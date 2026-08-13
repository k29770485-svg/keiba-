"""精算済みチケットからトップページ用の日次成績表を冪等に再構築する。"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta

from sqlalchemy import text
from sqlalchemy.orm import Session, sessionmaker

from .batch import utcnow


DELETE_DAILY_ROWS_SQL = text(
    """
    DELETE FROM prediction_performance_daily
    WHERE settled_date >= :start_date AND settled_date < :end_date
    """
)

REBUILD_DAILY_ROWS_SQL = text(
    """
    INSERT INTO prediction_performance_daily (
      settled_date,
      algorithm_version,
      ticket_type,
      settled_ticket_count,
      hit_ticket_count,
      total_stake_yen,
      total_return_yen,
      total_net_yen
    )
    SELECT
      DATE(spt.settled_at) AS settled_date,
      spr.algorithm_version,
      spt.ticket_type,
      COUNT(*) AS settled_ticket_count,
      SUM(CASE WHEN spt.return_yen > 0 THEN 1 ELSE 0 END) AS hit_ticket_count,
      SUM(spt.stake_yen) AS total_stake_yen,
      SUM(spt.return_yen) AS total_return_yen,
      SUM(spt.net_yen) AS total_net_yen
    FROM sql_prediction_tickets AS spt
    INNER JOIN sql_prediction_runs AS spr ON spr.prediction_id = spt.prediction_id
    WHERE spt.settlement_status = 'settled'
      AND spt.settled_at >= :start_at
      AND spt.settled_at < :end_at
    GROUP BY DATE(spt.settled_at), spr.algorithm_version, spt.ticket_type
    """
)

COUNT_DAILY_ROWS_SQL = text(
    """
    SELECT COUNT(*)
    FROM prediction_performance_daily
    WHERE settled_date >= :start_date AND settled_date < :end_date
    """
)


@dataclass(frozen=True)
class DailyPerformanceRefreshStats:
    """一回の再集計で対象となった日付範囲と生成済み行数。"""

    start_date: date
    end_date_exclusive: date
    daily_rows: int


def normalize_date_window(start_date: date, end_date_exclusive: date) -> tuple[date, date]:
    """半開区間 [start_date, end_date_exclusive) を検証する。"""
    if start_date >= end_date_exclusive:
        raise ValueError("開始日は終了日より前でなければなりません。")
    return start_date, end_date_exclusive


def refresh_daily_performance(
    session: Session,
    start_date: date,
    end_date_exclusive: date,
) -> DailyPerformanceRefreshStats:
    """対象日付範囲の日次集計を削除後に再構築する。

    削除とINSERT...SELECTは同一トランザクションで実行すること。既存行を加算しない
    ため、同じ範囲を何度実行しても元チケットから同じ値へ収束する。
    """
    start_date, end_date_exclusive = normalize_date_window(start_date, end_date_exclusive)
    start_at = datetime.combine(start_date, time.min)
    end_at = datetime.combine(end_date_exclusive, time.min)
    parameters = {
        "start_date": start_date,
        "end_date": end_date_exclusive,
        "start_at": start_at,
        "end_at": end_at,
    }

    session.execute(DELETE_DAILY_ROWS_SQL, parameters)
    session.execute(REBUILD_DAILY_ROWS_SQL, parameters)
    daily_rows = int(session.scalar(COUNT_DAILY_ROWS_SQL, parameters) or 0)
    return DailyPerformanceRefreshStats(
        start_date=start_date,
        end_date_exclusive=end_date_exclusive,
        daily_rows=daily_rows,
    )


def refresh_recent_daily_performance(
    session_factory: sessionmaker[Session],
    lookback_days: int = 7,
    now: datetime | None = None,
) -> DailyPerformanceRefreshStats:
    """遅延払戻・訂正に備え、当日を含む直近日数を毎日安全に再集計する。"""
    if lookback_days < 1 or lookback_days > 366:
        raise ValueError("再集計日数は1〜366日の範囲で指定してください。")
    execution_time = now or utcnow()
    end_date_exclusive = execution_time.date() + timedelta(days=1)
    start_date = end_date_exclusive - timedelta(days=lookback_days)
    with session_factory.begin() as session:
        return refresh_daily_performance(session, start_date, end_date_exclusive)
