"""SQL蓄積型予想の外部DBを使わない単体テスト。"""

from __future__ import annotations

import unittest
from datetime import datetime

from prediction_batch.models import RaceMarketData, RunnerMarketData, TicketMarketQuote
from prediction_batch.sql_pipeline import (
    ScoreBreakdown,
    ScoredRunner,
    calculate_return_yen,
    canonical_selection_key,
    generate_value_tickets,
    probability_lower_confidence_bound,
    score_market_data,
)


class SqlPipelineTests(unittest.TestCase):
    def test_canonical_ticket_keys_keep_trifecta_order_only(self) -> None:
        self.assertEqual(canonical_selection_key("trifecta", (3, 1, 2)), "3-1-2")
        self.assertEqual(canonical_selection_key("trio", (3, 1, 2)), "1-2-3")
        self.assertEqual(canonical_selection_key("wide", (8, 2)), "2-8")

    def test_score_market_data_marks_missing_values_without_inventing_them(self) -> None:
        market = RaceMarketData(
            race_id="future-race-001",
            fetched_at=datetime(2026, 8, 13, 1, 0, 0),
            scheduled_start_at=datetime(2026, 8, 13, 1, 10, 0),
            venue_name="東京",
            race_number=1,
            surface="turf",
            distance_m=1600,
            track_condition="good",
            runners=[
                RunnerMarketData(horse_number=1, horse_name="アルファ", gate_number=1, jockey_name="武豊", win_odds=2.1, popularity=1, age=4),
                RunnerMarketData(horse_number=2, horse_name="ベータ", gate_number=4, jockey_name="未登録騎手", win_odds=5.0, popularity=3),
                RunnerMarketData(horse_number=3, horse_name="ガンマ", gate_number=8, win_odds=12.0, popularity=7),
            ],
        )

        scored = score_market_data(market)

        self.assertEqual([item.rating for item in scored], ["◎", "○", "▲"])
        self.assertAlmostEqual(sum(item.win_probability for item in scored), 100.0, places=1)
        self.assertIn("sire", scored[0].breakdown.missing_fields)
        self.assertIn("age", next(item for item in scored if item.horse_number == 3).breakdown.missing_fields)
        self.assertFalse(any(item.is_longshot for item in scored), "欠損情報の穴馬を買い候補にしてはいけない")

    def test_return_yen_scales_with_actual_stake_and_uses_zero_for_miss(self) -> None:
        self.assertEqual(calculate_return_yen(100, 12540), 12540)
        self.assertEqual(calculate_return_yen(300, 12540), 37620)
        self.assertEqual(calculate_return_yen(100, None), 0)
        with self.assertRaises(ValueError):
            calculate_return_yen(0, 100)

    def test_probability_lower_confidence_bound_penalizes_small_samples(self) -> None:
        self.assertLess(
            probability_lower_confidence_bound(10.0, 30, 1.96),
            probability_lower_confidence_bound(10.0, 500, 1.96),
        )
        self.assertEqual(probability_lower_confidence_bound(10.0, 0, 1.96), 0.0)

    def test_generate_value_tickets_requires_calibrated_post_takeout_edge(self) -> None:
        breakdown = ScoreBreakdown(50, 0, 0, 0, 0, 0, 0, 0, 0, 50, [])
        candidates = [
            ScoredRunner(number, f"馬{number}", None, odds, number, 80 - number, 10.0, 0.0, "☆", False, breakdown)
            for number, odds in ((1, 6.0), (2, 8.0), (3, 10.0))
        ]
        strong_quote = TicketMarketQuote(
            ticket_type="wide",
            selection=[1, 2],
            payout_per_100_yen=2000,
            calibrated_probability_pct=10.0,
            calibration_sample_size=500,
            model_version="sql-v3-ev-strict",
        )
        second_strong_quote = TicketMarketQuote(
            ticket_type="trio",
            selection=[1, 2, 3],
            payout_per_100_yen=4000,
            calibrated_probability_pct=5.0,
            calibration_sample_size=500,
            model_version="sql-v3-ev-strict",
        )

        tickets = generate_value_tickets(candidates, 100, [strong_quote, second_strong_quote])

        self.assertEqual(len(tickets), 1, "極端な歪みが複数でも既定では最大1点に絞る")
        self.assertEqual(tickets[0].ticket_type, "wide")
        self.assertEqual(tickets[0].stake_yen, 100)

    def test_generate_value_tickets_rejects_uncalibrated_or_small_sample_quotes(self) -> None:
        breakdown = ScoreBreakdown(50, 0, 0, 0, 0, 0, 0, 0, 0, 50, [])
        candidates = [
            ScoredRunner(number, f"馬{number}", None, 10.0, number, 80 - number, 10.0, 99.0, "☆", False, breakdown)
            for number in (1, 2, 3)
        ]
        small_sample_quote = TicketMarketQuote(
            ticket_type="wide",
            selection=[1, 2],
            payout_per_100_yen=3000,
            calibrated_probability_pct=15.0,
            calibration_sample_size=14,
            model_version="sql-v3-ev-strict",
        )
        wrong_version_quote = TicketMarketQuote(
            ticket_type="wide",
            selection=[1, 2],
            payout_per_100_yen=3000,
            calibrated_probability_pct=15.0,
            calibration_sample_size=500,
            model_version="stale-version",
        )

        self.assertEqual(generate_value_tickets(candidates, 100, []), [])
        self.assertEqual(generate_value_tickets(candidates, 100, [small_sample_quote]), [])
        self.assertEqual(generate_value_tickets(candidates, 100, [wrong_version_quote]), [])

    def test_generate_value_tickets_rejects_missing_feature_selections(self) -> None:
        complete = ScoreBreakdown(50, 0, 0, 0, 0, 0, 0, 0, 0, 50, [])
        incomplete = ScoreBreakdown(50, 0, 0, 0, 0, 0, 0, 0, 0, 50, ["sire"])
        candidates = [
            ScoredRunner(1, "馬1", None, 8.0, 1, 80, 10.0, 90.0, "◎", False, complete),
            ScoredRunner(2, "馬2", None, 9.0, 2, 70, 10.0, 90.0, "○", False, incomplete),
        ]
        quote = TicketMarketQuote(
            ticket_type="wide",
            selection=[1, 2],
            payout_per_100_yen=3000,
            calibrated_probability_pct=15.0,
            calibration_sample_size=500,
            model_version="sql-v3-ev-strict",
        )
        self.assertEqual(generate_value_tickets(candidates, 100, [quote]), [])


if __name__ == "__main__":
    unittest.main()
