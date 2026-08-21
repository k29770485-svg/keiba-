"""架空・隔離DBでSQL蓄積型競馬予想の多条件ワークフローを実測する。

実在の馬名・レース・払戻を使わない。DATABASE_URL は専用の空DBを指定すること。
"""

from __future__ import annotations

import json
import os
from dataclasses import asdict
from datetime import timedelta
from pathlib import Path
from typing import Any

from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

from prediction_batch.batch import SqlRaceDataProvider, utcnow
from prediction_batch.config import Settings
from prediction_batch.daily_performance import refresh_daily_performance
from prediction_batch.models import RaceMarketData, RunnerMarketData
from prediction_batch.sql_pipeline import (
    generate_value_tickets,
    process_sql_predictions,
    score_market_data,
    settle_confirmed_tickets,
)

ALGORITHM_VERSION = "fixture-sql-v2"
FIXTURE_SOURCE = "isolated-fixture"


def build_runners(prefix: str, count: int, odds_profile: str) -> list[RunnerMarketData]:
    """競馬場・馬場条件の違いを除いて、再現可能な出走表を構築する。"""
    runners: list[RunnerMarketData] = []
    for number in range(1, count + 1):
        if odds_profile == "value":
            odds = [2.4, 4.2, 6.5, 12.0, 11.2, 14.5, 18.0, 22.0, 28.0, 35.0][min(number - 1, 9)]
        elif odds_profile == "no_bet":
            odds = 1.1
        else:
            odds = 2.5 + number * 1.8
        jockey = "C.ルメール" if number == 7 else ("戸崎圭太" if number == 3 else ("川田将雅" if number == 4 else f"架空騎手{number}"))
        sire = "ロードカナロア" if number in {1, 7} else ("ハーツクライ" if number in {2, 4, 8} else "架空父馬")
        runners.append(
            RunnerMarketData(
                horse_number=number,
                horse_name=f"{prefix}_HORSE_{number:02d}",
                gate_number=((number - 1) // 2) + 1,
                jockey_name=jockey,
                trainer_name=f"架空調教師{number}",
                win_odds=odds,
                popularity=number,
                carried_weight_kg=57.0,
                age=3 if number in {3, 7} else 4,
                sire=sire,
                horse_weight_kg=480.0 + number,
                horse_weight_diff_kg=2.0 if number in {3, 7} else 0.0,
                last3f_seconds=34.0 + number / 10,
                recent_form=["fixture"],
            )
        )
    return runners


def build_case(
    race_id: str,
    venue_name: str,
    course: str,
    surface: str,
    distance_m: int,
    track_condition: str,
    field_size: int,
    odds_profile: str,
    scheduled_start_at: Any,
) -> RaceMarketData:
    return RaceMarketData(
        race_id=race_id,
        fetched_at=scheduled_start_at - timedelta(minutes=12),
        scheduled_start_at=scheduled_start_at,
        venue_name=venue_name,
        race_number=8,
        race_name=f"FIXTURE {venue_name} {distance_m}m",
        course=course,
        surface=surface,
        distance_m=distance_m,
        track_condition=track_condition,
        weather="fixture",
        runners=build_runners(race_id, field_size, odds_profile),
        source_url=f"https://fixture.invalid/{race_id}",
    )


def insert_race_and_snapshot(connection: Any, market: RaceMarketData, latest_marker: str | None = None) -> None:
    connection.execute(
        text(
            """
            INSERT INTO races (
              race_id, race_date, venue_code, venue_name, race_number,
              race_name, scheduled_start_at, race_status, source_url
            ) VALUES (
              :race_id, :race_date, :venue_code, :venue_name, :race_number,
              :race_name, :scheduled_start_at, 'scheduled', :source_url
            )
            """
        ),
        {
            "race_id": market.race_id,
            "race_date": market.scheduled_start_at.date(),
            "venue_code": market.venue_name,
            "venue_name": market.venue_name,
            "race_number": market.race_number,
            "race_name": market.race_name,
            "scheduled_start_at": market.scheduled_start_at,
            "source_url": market.source_url,
        },
    )
    payload = market.model_dump(mode="json")
    if latest_marker:
        payload["weather"] = latest_marker
    connection.execute(
        text(
            """
            INSERT INTO race_market_snapshots (
              race_id, captured_at, source_name, snapshot_json, is_ready_for_prediction
            ) VALUES (
              :race_id, :captured_at, :source_name, :snapshot_json, 1
            )
            """
        ),
        {
            "race_id": market.race_id,
            "captured_at": market.scheduled_start_at - timedelta(minutes=8),
            "source_name": FIXTURE_SOURCE,
            "snapshot_json": json.dumps(payload, ensure_ascii=False),
        },
    )


def query_one(connection: Any, statement: str, **params: Any) -> dict[str, Any]:
    row = connection.execute(text(statement), params).mappings().one()
    return dict(row)


def main() -> None:
    database_url = os.environ["DATABASE_URL"]
    if "keiba_skill_test" not in database_url:
        raise RuntimeError("隔離DBだけを使うため、DATABASE_URLにkeiba_skill_testを指定してください。")
    sqlalchemy_url = database_url.replace("mysql://", "mysql+pymysql://", 1)
    engine = create_engine(sqlalchemy_url, future=True)
    session_factory = sessionmaker(bind=engine, expire_on_commit=False, future=True)
    now = utcnow().replace(microsecond=0)
    scheduled = now + timedelta(minutes=10)

    cases = [
        build_case(
            "FX_SAPPORO_T1200", "札幌", "札幌 芝1200", "芝", 1200, "良", 12, "value", scheduled
        ),
        build_case(
            "FX_TOKYO_D1600", "東京", "東京 ダ1600", "ダート", 1600, "重", 14, "value", scheduled
        ),
        build_case(
            "FX_CHUKYO_T2200", "中京", "中京 芝2200", "芝", 2200, "不良", 10, "no_bet", scheduled
        ),
        build_case(
            "FX_KYOTO_D1800", "京都", "京都 ダ1800", "ダート", 1800, "稍重", 16, "value", scheduled
        ),
    ]

    with engine.begin() as connection:
        for market in cases:
            insert_race_and_snapshot(
                connection,
                market,
                latest_marker="札幌最新スナップショット" if market.race_id == "FX_SAPPORO_T1200" else None,
            )
        # 発走後スナップショットは意図的に置くが、SQL提供元は絶対に採用してはならない。
        stale = cases[0].model_dump(mode="json")
        stale["weather"] = "発走後の不正入力"
        connection.execute(
            text(
                """
                INSERT INTO race_market_snapshots (
                  race_id, captured_at, source_name, snapshot_json, is_ready_for_prediction
                ) VALUES (:race_id, :captured_at, :source_name, :snapshot_json, 1)
                """
            ),
            {
                "race_id": cases[0].race_id,
                "captured_at": scheduled + timedelta(minutes=1),
                "source_name": FIXTURE_SOURCE,
                "snapshot_json": json.dumps(stale, ensure_ascii=False),
            },
        )

    settings = Settings(
        database_url=sqlalchemy_url,
        data_provider="sql",
        prediction_lead_minutes=10,
        prediction_window_seconds=300,
        sql_algorithm_version=ALGORITHM_VERSION,
        ticket_stake_yen=100,
    )
    provider = SqlRaceDataProvider(sqlalchemy_url)
    prediction_stats = process_sql_predictions(settings, session_factory, provider)

    with engine.connect() as connection:
        generated_runs = query_one(
            connection,
            "SELECT COUNT(*) AS count FROM sql_prediction_runs WHERE algorithm_version = :algorithm_version",
            algorithm_version=ALGORITHM_VERSION,
        )["count"]
        sapporo_snapshot = query_one(
            connection,
            """
            SELECT snapshot_json FROM sql_prediction_runs
            WHERE race_id = 'FX_SAPPORO_T1200' AND algorithm_version = :algorithm_version
            """,
            algorithm_version=ALGORITHM_VERSION,
        )["snapshot_json"]
        if isinstance(sapporo_snapshot, str):
            sapporo_snapshot = json.loads(sapporo_snapshot)
        if sapporo_snapshot["weather"] != "札幌最新スナップショット":
            raise AssertionError("発走後スナップショットが予想入力へ混入しました。")
        ticket_counts = {
            row["race_id"]: int(row["ticket_count"])
            for row in connection.execute(
                text(
                    """
                    SELECT race_id, ticket_count FROM sql_prediction_runs
                    WHERE algorithm_version = :algorithm_version ORDER BY race_id
                    """
                ),
                {"algorithm_version": ALGORITHM_VERSION},
            ).mappings()
        }

    if generated_runs != 4 or prediction_stats.generated != 4 or prediction_stats.failed != 0:
        raise AssertionError(f"予想保存件数が不正です: {asdict(prediction_stats)}")
    if ticket_counts["FX_CHUKYO_T2200"] != 0:
        raise AssertionError("低オッズのみの見送りケースで買い目が生成されました。")
    if ticket_counts["FX_TOKYO_D1600"] == 0:
        raise AssertionError("東京ダート重馬場ケースで買い目が生成されませんでした。")

    # 東京は払戻を投入して精算、京都は結果待ち、中京は見送りでも結果確定へ遷移できるか検証する。
    with engine.begin() as connection:
        connection.execute(
            text("UPDATE races SET race_status = 'finished' WHERE race_id IN ('FX_TOKYO_D1600', 'FX_CHUKYO_T2200', 'FX_KYOTO_D1800')")
        )
        tokyo_tickets = connection.execute(
            text(
                """
                SELECT spt.ticket_type, spt.selection_key
                FROM sql_prediction_tickets AS spt
                JOIN sql_prediction_runs AS spr ON spr.prediction_id = spt.prediction_id
                WHERE spr.race_id = 'FX_TOKYO_D1600' AND spr.algorithm_version = :algorithm_version
                ORDER BY spt.ticket_id
                """
            ),
            {"algorithm_version": ALGORITHM_VERSION},
        ).mappings().all()
        payouts: dict[str, dict[str, int]] = {"trifecta": {}, "trio": {}, "wide": {}}
        for index, ticket in enumerate(tokyo_tickets):
            if index == 0:
                payouts[ticket["ticket_type"]][ticket["selection_key"]] = 8600
        for race_id, payout_json in [
            ("FX_TOKYO_D1600", payouts),
            ("FX_CHUKYO_T2200", {"trifecta": {}, "trio": {}, "wide": {}}),
        ]:
            connection.execute(
                text(
                    """
                    INSERT INTO sql_race_settlements (
                      race_id, actual_top3_json, payouts_json, source_name, is_confirmed, confirmed_at
                    ) VALUES (:race_id, :actual_top3_json, :payouts_json, :source_name, 1, :confirmed_at)
                    """
                ),
                {
                    "race_id": race_id,
                    "actual_top3_json": "[1,2,3]",
                    "payouts_json": json.dumps(payout_json),
                    "source_name": FIXTURE_SOURCE,
                    "confirmed_at": now,
                },
            )

    settlement_stats = settle_confirmed_tickets(session_factory)
    with session_factory.begin() as session:
        daily_first = refresh_daily_performance(session, now.date(), now.date() + timedelta(days=1))
    with session_factory.begin() as session:
        daily_second = refresh_daily_performance(session, now.date(), now.date() + timedelta(days=1))

    with engine.connect() as connection:
        run_rows = connection.execute(
            text(
                """
                SELECT race_id, status, ticket_count
                FROM sql_prediction_runs
                WHERE algorithm_version = :algorithm_version ORDER BY race_id
                """
            ),
            {"algorithm_version": ALGORITHM_VERSION},
        ).mappings().all()
        statuses = {row["race_id"]: row["status"] for row in run_rows}
        daily_rows = connection.execute(
            text(
                """
                SELECT ticket_type, settled_ticket_count, total_stake_yen, total_return_yen, total_net_yen
                FROM prediction_performance_daily
                WHERE algorithm_version = :algorithm_version AND settled_date = :settled_date
                ORDER BY ticket_type
                """
            ),
            {"algorithm_version": ALGORITHM_VERSION, "settled_date": now.date()},
        ).mappings().all()
        raw_totals = query_one(
            connection,
            """
            SELECT COUNT(*) AS settled_ticket_count,
                   COALESCE(SUM(spt.stake_yen), 0) AS total_stake_yen,
                   COALESCE(SUM(spt.return_yen), 0) AS total_return_yen,
                   COALESCE(SUM(spt.net_yen), 0) AS total_net_yen
            FROM sql_prediction_tickets AS spt
            JOIN sql_prediction_runs AS spr ON spr.prediction_id = spt.prediction_id
            WHERE spr.algorithm_version = :algorithm_version
              AND spt.settlement_status = 'settled'
            """,
            algorithm_version=ALGORITHM_VERSION,
        )
        daily_totals = {
            "settled_ticket_count": sum(int(row["settled_ticket_count"]) for row in daily_rows),
            "total_stake_yen": sum(int(row["total_stake_yen"]) for row in daily_rows),
            "total_return_yen": sum(int(row["total_return_yen"]) for row in daily_rows),
            "total_net_yen": sum(int(row["total_net_yen"]) for row in daily_rows),
        }

    if statuses["FX_TOKYO_D1600"] != "settled":
        raise AssertionError("確定払戻済み東京レースがsettledへ遷移しませんでした。")
    if statuses["FX_CHUKYO_T2200"] != "settled":
        raise AssertionError("見送り・確定済み中京レースがsettledへ遷移しませんでした。")
    if statuses["FX_KYOTO_D1800"] != "generated":
        raise AssertionError("払戻未投入の京都レースを誤ってsettledにしました。")
    if {key: int(value) for key, value in raw_totals.items()} != daily_totals:
        raise AssertionError(f"日次集計と原票が一致しません: raw={raw_totals}, daily={daily_totals}")
    if daily_first.daily_rows != daily_second.daily_rows:
        raise AssertionError("同一期間の再集計で日次行数が変化しました。")

    score_summaries = {}
    for market in cases:
        scored = score_market_data(market)
        score_summaries[market.race_id] = {
            "venue": market.venue_name,
            "surface": market.surface,
            "distanceM": market.distance_m,
            "trackCondition": market.track_condition,
            "fieldSize": len(market.runners),
            "longshotCount": sum(1 for item in scored if item.is_longshot),
            "ticketCount": ticket_counts[market.race_id],
            "topScore": scored[0].score,
            "topRating": scored[0].rating,
        }

    report = {
        "disclaimer": "この結果は架空の隔離フィクスチャに基づくスキル検証であり、実在のレース・馬・回収率ではありません。",
        "predictionStats": asdict(prediction_stats),
        "settlementStats": asdict(settlement_stats),
        "dailyRefresh": {"first": asdict(daily_first), "second": asdict(daily_second)},
        "cases": score_summaries,
        "statuses": statuses,
        "dailyTotals": daily_totals,
    }
    output = Path(__file__).resolve().parents[2] / "test_artifacts" / "keiba_sql_skill_fixture_result.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2, default=str) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2, default=str))


if __name__ == "__main__":
    main()
