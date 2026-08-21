"""SQL蓄積型の将来レース予想・精算パイプライン。

このモジュールは過去データを補完・再生成しない。対象は発走前の新規レースだけであり、
入力として受け取った時点の正規化済み出走表・オッズを監査用スナップショットとして保存する。
結果と払戻は、許可済みの取込処理がSQLへ確定値を書き込んだ場合にだけ精算する。
"""

from __future__ import annotations

import json
import logging
import math
import socket
import uuid
from dataclasses import asdict, dataclass, replace
from datetime import datetime, timedelta
from itertools import combinations
from typing import Any

from sqlalchemy import text
from sqlalchemy.orm import Session, sessionmaker

from .batch import (
    DueRace,
    RaceDataProvider,
    acquire_race_lock,
    as_utc_naive,
    release_race_lock,
    utcnow,
)
from .config import Settings
from .models import RaceMarketData, RunnerMarketData

logger = logging.getLogger(__name__)

# 新規のSQL予想が未保存のレースだけを、発走予定の指定窓内から選ぶ。
# 既存のGemini予想テーブルには依存しないため、SQL方式へ安全に移行できる。
SQL_DUE_RACES_SQL = text(
    """
    SELECT r.race_id, r.venue_name, r.race_number, r.scheduled_start_at,
           r.race_name, r.source_url
    FROM races AS r
    LEFT JOIN sql_prediction_runs AS spr
      ON spr.race_id = r.race_id
     AND spr.algorithm_version = :algorithm_version
    WHERE r.race_status = 'scheduled'
      AND r.scheduled_start_at >= :window_start
      AND r.scheduled_start_at < :window_end
      AND spr.prediction_id IS NULL
    ORDER BY r.scheduled_start_at ASC
    """
)

TOP_JOCKEYS: dict[str, float] = {
    "C.ルメール": 12,
    "川田将雅": 11,
    "横山武史": 10,
    "戸崎圭太": 9,
    "福永祐一": 9,
    "松山弘平": 8,
    "M.デムーロ": 8,
    "武豊": 8,
    "岩田望来": 7,
    "坂井瑠星": 7,
    "池添謙一": 6,
    "田辺裕信": 6,
    "横山典弘": 6,
    "吉田隼人": 5,
    "石橋脩": 5,
    "菅原明良": 5,
    "鮫島克駿": 5,
    "藤岡佑介": 5,
    "北村宏司": 4,
    "丹内祐次": 4,
}

TRACK_CONDITION_FACTOR: dict[str, dict[str, float]] = {
    "good": {"turf": 1.0, "dirt": 1.0},
    "slightly_heavy": {"turf": 0.95, "dirt": 1.05},
    "heavy": {"turf": 0.88, "dirt": 1.10},
    "bad": {"turf": 0.80, "dirt": 1.15},
}

GATE_BIAS: dict[str, dict[str, float]] = {
    "東京": {"inner": 2, "outer": -1},
    "中山": {"inner": 3, "outer": -2},
    "阪神": {"inner": 1, "outer": 0},
    "京都": {"inner": 2, "outer": -1},
    "中京": {"inner": 0, "outer": 1},
    "新潟": {"inner": -1, "outer": 2},
    "札幌": {"inner": 2, "outer": -1},
    "函館": {"inner": 2, "outer": -2},
    "小倉": {"inner": 3, "outer": -2},
    "福島": {"inner": 1, "outer": 0},
}

SIRE_LINE_AFFINITY: dict[str, dict[str, float]] = {
    "ディープインパクト": {"turf": 5, "dirt": -2, "sprint": -1, "long": 4},
    "キングカメハメハ": {"turf": 3, "dirt": 3, "sprint": 1, "long": 2},
    "ハーツクライ": {"turf": 4, "dirt": 0, "sprint": -2, "long": 5},
    "ロードカナロア": {"turf": 3, "dirt": 1, "sprint": 5, "long": -2},
    "エピファネイア": {"turf": 4, "dirt": 1, "sprint": -1, "long": 3},
    "ドゥラメンテ": {"turf": 4, "dirt": 2, "sprint": 0, "long": 3},
    "モーリス": {"turf": 4, "dirt": 0, "sprint": 1, "long": 2},
    "キタサンブラック": {"turf": 4, "dirt": 1, "sprint": -1, "long": 4},
    "サトノダイヤモンド": {"turf": 3, "dirt": 0, "sprint": -2, "long": 4},
    "ゴールドシップ": {"turf": 3, "dirt": 1, "sprint": -3, "long": 5},
}

RATING_BY_RANK = ("◎", "○", "▲", "△", "△")


@dataclass(frozen=True)
class ScoreBreakdown:
    base: float
    jockey_bonus: float
    odds_score: float
    gate_score: float
    track_condition_score: float
    bloodline_score: float
    weight_score: float
    age_score: float
    odds_movement_score: float
    total: float
    missing_fields: list[str]


@dataclass(frozen=True)
class ScoredRunner:
    horse_number: int
    horse_name: str
    jockey_name: str | None
    odds: float | None
    popularity: int | None
    score: float
    win_probability: float
    expected_value: float | None
    rating: str
    is_longshot: bool
    breakdown: ScoreBreakdown


@dataclass(frozen=True)
class GeneratedTicket:
    ticket_type: str
    selection: tuple[int, ...]
    stake_yen: int


@dataclass
class SqlPredictionRunStats:
    discovered: int = 0
    locked: int = 0
    generated: int = 0
    skipped: int = 0
    failed: int = 0


@dataclass
class SettlementStats:
    confirmed_races: int = 0
    settled_tickets: int = 0
    pending_tickets: int = 0


def canonical_selection_key(ticket_type: str, selection: tuple[int, ...] | list[int]) -> str:
    """払戻取込・購入記録共通の馬番キーを生成する。"""
    values = tuple(int(value) for value in selection)
    if ticket_type == "trifecta":
        return "-".join(str(value) for value in values)
    return "-".join(str(value) for value in sorted(values))


def calculate_return_yen(stake_yen: int, payout_per_100_yen: float | int | None) -> int:
    """100円あたりの確定払戻から、実投資額に比例した返戻額を算出する。"""
    if stake_yen <= 0:
        raise ValueError("投資額は正の整数で指定してください。")
    if payout_per_100_yen is None:
        return 0
    return round(float(payout_per_100_yen) * stake_yen / 100)


def _canonical_surface(value: str | None) -> str:
    normalized = (value or "turf").lower()
    if normalized in {"ダート", "dirt"}:
        return "dirt"
    return "turf"


def _canonical_condition(value: str | None) -> str:
    mapping = {
        "良": "good",
        "稍重": "slightly_heavy",
        "重": "heavy",
        "不良": "bad",
        "good": "good",
        "slightly_heavy": "slightly_heavy",
        "heavy": "heavy",
        "bad": "bad",
    }
    return mapping.get((value or "good").lower(), "good")


def _jockey_bonus(jockey_name: str | None) -> float:
    if not jockey_name:
        return 0.0
    if jockey_name in TOP_JOCKEYS:
        return TOP_JOCKEYS[jockey_name]
    for name, bonus in TOP_JOCKEYS.items():
        surname = name.replace("C.", "").replace("M.", "")
        if jockey_name in name or surname in jockey_name:
            return bonus
    return 0.0


def calculate_score(runner: RunnerMarketData, market_data: RaceMarketData) -> ScoreBreakdown:
    """既存サイトの決定論的スコアを、欠損項目を補わずに再現する。"""
    surface = _canonical_surface(market_data.surface)
    condition = _canonical_condition(market_data.track_condition)
    distance = market_data.distance_m or 1600
    field_size = len(market_data.runners)
    missing_fields: list[str] = []

    base = 50.0
    if runner.win_odds and runner.win_odds > 0:
        base = max(30.0, min(80.0, 100.0 - math.log2(runner.win_odds) * 8.0))
    else:
        missing_fields.append("win_odds")

    jockey_bonus = _jockey_bonus(runner.jockey_name)
    if not runner.jockey_name:
        missing_fields.append("jockey_name")

    odds_score = 0.0
    if runner.win_odds and runner.popularity:
        expected_odds = runner.popularity * 3.0
        if runner.win_odds < expected_odds * 0.7:
            odds_score = 5.0
        elif runner.win_odds > expected_odds * 1.5 and runner.win_odds < 30:
            odds_score = 8.0
    else:
        missing_fields.append("popularity")

    gate_score = 0.0
    if runner.gate_number is not None and market_data.venue_name in GATE_BIAS:
        bias = GATE_BIAS[market_data.venue_name]
        if runner.gate_number <= math.ceil(field_size / 3):
            gate_score = bias["inner"]
        elif runner.gate_number > math.ceil(field_size * 2 / 3):
            gate_score = bias["outer"]
    elif runner.gate_number is None:
        missing_fields.append("gate_number")

    track_condition_score = 0.0
    factor = TRACK_CONDITION_FACTOR[condition][surface]
    if factor != 1.0:
        if surface == "dirt" and factor > 1.0:
            track_condition_score = round((factor - 1.0) * 30.0)
        elif surface == "turf" and factor < 1.0:
            track_condition_score = round((1.0 - factor) * -10.0)

    bloodline_score = 0.0
    if runner.sire:
        affinity = SIRE_LINE_AFFINITY.get(runner.sire)
        if affinity:
            bloodline_score += affinity[surface]
            if distance <= 1400:
                bloodline_score += affinity["sprint"]
            elif distance >= 2200:
                bloodline_score += affinity["long"]
    else:
        missing_fields.append("sire")

    weight_score = 0.0
    if runner.horse_weight_diff_kg is None:
        missing_fields.append("horse_weight_diff_kg")
    elif runner.horse_weight_diff_kg < -10:
        weight_score = -5.0
    elif runner.horse_weight_diff_kg > 15:
        weight_score = -3.0
    elif -2 <= runner.horse_weight_diff_kg <= 4:
        weight_score = 3.0

    age_score = 0.0
    if runner.age is None:
        missing_fields.append("age")
    elif runner.age == 3:
        age_score = 3.0
    elif runner.age == 4:
        age_score = 4.0
    elif runner.age == 5:
        age_score = 2.0
    elif runner.age >= 7:
        age_score = -3.0

    odds_movement_score = 0.0
    total = round(
        base
        + jockey_bonus
        + odds_score
        + gate_score
        + track_condition_score
        + bloodline_score
        + weight_score
        + age_score
        + odds_movement_score,
        3,
    )
    return ScoreBreakdown(
        base=base,
        jockey_bonus=jockey_bonus,
        odds_score=odds_score,
        gate_score=gate_score,
        track_condition_score=track_condition_score,
        bloodline_score=bloodline_score,
        weight_score=weight_score,
        age_score=age_score,
        odds_movement_score=odds_movement_score,
        total=total,
        missing_fields=missing_fields,
    )


def score_market_data(market_data: RaceMarketData) -> list[ScoredRunner]:
    """レース内正規化の推定勝率・相対期待値を付与し、穴馬候補を識別する。"""
    breakdowns = [(runner, calculate_score(runner, market_data)) for runner in market_data.runners]
    if not breakdowns:
        return []

    max_score = max(breakdown.total for _, breakdown in breakdowns)
    weights = [math.exp((breakdown.total - max_score) / 12.0) for _, breakdown in breakdowns]
    total_weight = sum(weights) or 1.0

    unsorted: list[ScoredRunner] = []
    for (runner, breakdown), weight in zip(breakdowns, weights, strict=True):
        probability = round(weight / total_weight * 100.0, 1)
        expected_value = None
        if runner.win_odds and runner.win_odds > 0:
            expected_value = round(((probability / 100.0) * runner.win_odds - 1.0) * 100.0, 1)
        is_longshot = bool(
            runner.popularity is not None
            and runner.popularity >= 6
            and runner.win_odds is not None
            and runner.win_odds >= 5.0
            and expected_value is not None
            and expected_value >= 0
        )
        unsorted.append(
            ScoredRunner(
                horse_number=runner.horse_number,
                horse_name=runner.horse_name,
                jockey_name=runner.jockey_name,
                odds=runner.win_odds,
                popularity=runner.popularity,
                score=breakdown.total,
                win_probability=probability,
                expected_value=expected_value,
                rating="☆",
                is_longshot=is_longshot,
                breakdown=breakdown,
            )
        )

    ranked = sorted(unsorted, key=lambda item: (-item.score, item.horse_number))
    return [
        replace(item, rating=RATING_BY_RANK[index] if index < len(RATING_BY_RANK) else "☆")
        for index, item in enumerate(ranked)
    ]


def generate_value_tickets(scored: list[ScoredRunner], stake_yen: int) -> list[GeneratedTicket]:
    """相対期待値0%以上の候補が3頭以上ある場合だけ、重複のない券を作る。"""
    eligible = [
        item
        for item in scored
        if item.odds is not None and item.odds > 0 and item.expected_value is not None and item.expected_value >= 0
    ]
    eligible.sort(key=lambda item: (-(item.expected_value or 0.0), -item.score, item.horse_number))
    eligible = eligible[:4]
    if len(eligible) < 3:
        return []

    axis = eligible[0]
    partners = eligible[1:4]
    tickets: list[GeneratedTicket] = []
    ticket_keys: set[tuple[str, str]] = set()

    def add(ticket_type: str, selection: tuple[int, ...]) -> None:
        key = canonical_selection_key(ticket_type, selection)
        identifier = (ticket_type, key)
        if identifier not in ticket_keys:
            ticket_keys.add(identifier)
            tickets.append(GeneratedTicket(ticket_type=ticket_type, selection=selection, stake_yen=stake_yen))

    for second in partners[:2]:
        for third in [axis, *partners]:
            selection = (axis.horse_number, second.horse_number, third.horse_number)
            if len(set(selection)) == 3:
                add("trifecta", selection)

    for pair in combinations(partners, 2):
        add("trio", (axis.horse_number, pair[0].horse_number, pair[1].horse_number))

    if axis.odds is not None and axis.odds >= 4.0 and partners:
        add("wide", (axis.horse_number, partners[0].horse_number))

    return tickets


def get_sql_due_races(session: Session, settings: Settings, now: datetime) -> list[DueRace]:
    center = now + timedelta(minutes=settings.prediction_lead_minutes)
    half_window = timedelta(seconds=settings.prediction_window_seconds / 2)
    rows = session.execute(
        SQL_DUE_RACES_SQL,
        {
            "window_start": center - half_window,
            "window_end": center + half_window,
            "algorithm_version": settings.sql_algorithm_version,
        },
    ).mappings()
    return [
        DueRace(
            race_id=row["race_id"],
            venue_name=row["venue_name"],
            race_number=row["race_number"],
            scheduled_start_at=as_utc_naive(row["scheduled_start_at"]),
            race_name=row["race_name"],
            source_url=row["source_url"],
        )
        for row in rows
    ]


def save_sql_prediction(
    session: Session,
    market_data: RaceMarketData,
    scored: list[ScoredRunner],
    tickets: list[GeneratedTicket],
    settings: Settings,
    now: datetime,
) -> None:
    """一つの予想実行を監査可能なスナップショットとして保存する。"""
    total_stake = sum(ticket.stake_yen for ticket in tickets)
    session.execute(
        text(
            """
            INSERT INTO sql_prediction_runs (
              race_id, algorithm_version, source_name, snapshot_json, generated_at,
              total_stake_yen, ticket_count, status
            ) VALUES (
              :race_id, :algorithm_version, :source_name, :snapshot_json, :generated_at,
              :total_stake_yen, :ticket_count, 'generated'
            )
            ON DUPLICATE KEY UPDATE
              source_name = VALUES(source_name),
              snapshot_json = VALUES(snapshot_json),
              generated_at = VALUES(generated_at),
              total_stake_yen = VALUES(total_stake_yen),
              ticket_count = VALUES(ticket_count),
              status = 'generated',
              updated_at = VALUES(generated_at)
            """
        ),
        {
            "race_id": market_data.race_id,
            "algorithm_version": settings.sql_algorithm_version,
            "source_name": settings.data_provider,
            "snapshot_json": json.dumps(market_data.model_dump(mode="json"), ensure_ascii=False),
            "generated_at": now,
            "total_stake_yen": total_stake,
            "ticket_count": len(tickets),
        },
    )
    prediction_id = session.scalar(
        text(
            """
            SELECT prediction_id
            FROM sql_prediction_runs
            WHERE race_id = :race_id AND algorithm_version = :algorithm_version
            """
        ),
        {"race_id": market_data.race_id, "algorithm_version": settings.sql_algorithm_version},
    )
    if prediction_id is None:
        raise RuntimeError("SQL予想IDの取得に失敗しました。")

    session.execute(text("DELETE FROM sql_prediction_scores WHERE prediction_id = :prediction_id"), {"prediction_id": prediction_id})
    session.execute(text("DELETE FROM sql_prediction_tickets WHERE prediction_id = :prediction_id AND settlement_status = 'pending'"), {"prediction_id": prediction_id})

    for rank, item in enumerate(scored, start=1):
        session.execute(
            text(
                """
                INSERT INTO sql_prediction_scores (
                  prediction_id, horse_number, horse_name, jockey_name, odds, popularity,
                  score, win_probability_pct, expected_value_pct, rating, is_longshot,
                  score_breakdown_json, missing_fields_json, rank_position
                ) VALUES (
                  :prediction_id, :horse_number, :horse_name, :jockey_name, :odds, :popularity,
                  :score, :win_probability_pct, :expected_value_pct, :rating, :is_longshot,
                  :score_breakdown_json, :missing_fields_json, :rank_position
                )
                """
            ),
            {
                "prediction_id": prediction_id,
                "horse_number": item.horse_number,
                "horse_name": item.horse_name,
                "jockey_name": item.jockey_name,
                "odds": item.odds,
                "popularity": item.popularity,
                "score": item.score,
                "win_probability_pct": item.win_probability,
                "expected_value_pct": item.expected_value,
                "rating": item.rating,
                "is_longshot": item.is_longshot,
                "score_breakdown_json": json.dumps(asdict(item.breakdown), ensure_ascii=False),
                "missing_fields_json": json.dumps(item.breakdown.missing_fields, ensure_ascii=False),
                "rank_position": rank,
            },
        )

    for ticket in tickets:
        selection_key = canonical_selection_key(ticket.ticket_type, ticket.selection)
        session.execute(
            text(
                """
                INSERT INTO sql_prediction_tickets (
                  prediction_id, ticket_type, selection_json, selection_key, stake_yen, settlement_status
                ) VALUES (
                  :prediction_id, :ticket_type, :selection_json, :selection_key, :stake_yen, 'pending'
                )
                """
            ),
            {
                "prediction_id": prediction_id,
                "ticket_type": ticket.ticket_type,
                "selection_json": json.dumps(list(ticket.selection)),
                "selection_key": selection_key,
                "stake_yen": ticket.stake_yen,
            },
        )


def process_sql_predictions(
    settings: Settings,
    session_factory: sessionmaker[Session],
    provider: RaceDataProvider,
) -> SqlPredictionRunStats:
    """発走前の未来レースを一度だけSQL予想として保存する。"""
    worker_id = f"{socket.gethostname()}-{uuid.uuid4()}"
    stats = SqlPredictionRunStats()
    with session_factory() as session:
        due_races = get_sql_due_races(session, settings, utcnow())
        stats.discovered = len(due_races)

    for race in due_races:
        now = utcnow()
        with session_factory.begin() as session:
            if not acquire_race_lock(session, race.race_id, worker_id, now, settings.lock_lease_seconds):
                stats.skipped += 1
                continue
            stats.locked += 1
        try:
            market_data = provider.fetch_market_data(race)
            if market_data.race_id != race.race_id:
                raise ValueError("入力データのrace_idが対象レースと一致しません。")
            scored = score_market_data(market_data)
            tickets = generate_value_tickets(scored, settings.ticket_stake_yen)
            with session_factory.begin() as session:
                save_sql_prediction(session, market_data, scored, tickets, settings, utcnow())
                release_race_lock(session, race.race_id, worker_id)
            stats.generated += 1
            logger.info("race_id=%s のSQL予想を保存しました。", race.race_id)
        except Exception:
            stats.failed += 1
            logger.exception("race_id=%s のSQL予想に失敗しました。", race.race_id)
    return stats


def settle_confirmed_tickets(session_factory: sessionmaker[Session]) -> SettlementStats:
    """確定払戻がSQLに存在するレースだけを精算する。欠損払戻は保留のままにする。"""
    stats = SettlementStats()
    with session_factory.begin() as session:
        settlement_rows = session.execute(
            text(
                """
                SELECT DISTINCT r.race_id, rs.payouts_json
                FROM races AS r
                JOIN sql_race_settlements AS rs
                  ON rs.race_id = r.race_id AND rs.is_confirmed = 1
                JOIN sql_prediction_runs AS spr
                  ON spr.race_id = r.race_id AND spr.status = 'generated'
                WHERE r.race_status = 'finished'
                """
            )
        ).mappings().all()
        stats.confirmed_races = len(settlement_rows)

        for row in settlement_rows:
            try:
                payouts = json.loads(row["payouts_json"])
            except (TypeError, json.JSONDecodeError):
                logger.warning("race_id=%s の払戻JSONが不正なため精算を保留します。", row["race_id"])
                continue

            tickets = session.execute(
                text(
                    """
                    SELECT spt.ticket_id, spt.ticket_type, spt.selection_key, spt.stake_yen
                    FROM sql_prediction_tickets AS spt
                    JOIN sql_prediction_runs AS spr ON spr.prediction_id = spt.prediction_id
                    WHERE spr.race_id = :race_id AND spt.settlement_status = 'pending'
                    """
                ),
                {"race_id": row["race_id"]},
            ).mappings().all()
            for ticket in tickets:
                payout_map = payouts.get(ticket["ticket_type"])
                if not isinstance(payout_map, dict):
                    stats.pending_tickets += 1
                    continue
                payout_per_100 = payout_map.get(ticket["selection_key"])
                return_yen = calculate_return_yen(int(ticket["stake_yen"]), payout_per_100)
                session.execute(
                    text(
                        """
                        UPDATE sql_prediction_tickets
                        SET settlement_status = 'settled', return_yen = :return_yen,
                            net_yen = :net_yen, settled_at = :settled_at
                        WHERE ticket_id = :ticket_id
                        """
                    ),
                    {
                        "ticket_id": ticket["ticket_id"],
                        "return_yen": return_yen,
                        "net_yen": return_yen - int(ticket["stake_yen"]),
                        "settled_at": utcnow(),
                    },
                )
                stats.settled_tickets += 1

            remaining = session.scalar(
                text(
                    """
                    SELECT COUNT(*)
                    FROM sql_prediction_tickets AS spt
                    JOIN sql_prediction_runs AS spr ON spr.prediction_id = spt.prediction_id
                    WHERE spr.race_id = :race_id AND spt.settlement_status = 'pending'
                    """
                ),
                {"race_id": row["race_id"]},
            )
            if remaining == 0:
                session.execute(
                    text(
                        """
                        UPDATE sql_prediction_runs
                        SET status = 'settled', updated_at = :updated_at
                        WHERE race_id = :race_id AND status = 'generated'
                        """
                    ),
                    {"race_id": row["race_id"], "updated_at": utcnow()},
                )
    return stats


def run_sql_cycle(
    settings: Settings,
    session_factory: sessionmaker[Session],
    provider: RaceDataProvider,
) -> tuple[SqlPredictionRunStats, SettlementStats]:
    """生成と精算を一周期で実行する。"""
    prediction_stats = process_sql_predictions(settings, session_factory, provider)
    settlement_stats = settle_confirmed_tickets(session_factory)
    return prediction_stats, settlement_stats
