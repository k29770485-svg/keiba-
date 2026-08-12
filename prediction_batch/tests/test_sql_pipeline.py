"""SQL蓄積型予想の外部DBを使わない単体テスト。"""

from __future__ import annotations

import unittest
from datetime import datetime

from prediction_batch.models import RaceMarketData, RunnerMarketData
from prediction_batch.sql_pipeline import (
    ScoreBreakdown,
    ScoredRunner,
    calculate_return_yen,
    canonical_selection_key,
    generate_value_tickets,
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
        self.assertTrue(any(item.is_longshot for item in scored))

    def test_return_yen_scales_with_actual_stake_and_uses_zero_for_miss(self) -> None:
        self.assertEqual(calculate_return_yen(100, 12540), 12540)
        self.assertEqual(calculate_return_yen(300, 12540), 37620)
        self.assertEqual(calculate_return_yen(100, None), 0)
        with self.assertRaises(ValueError):
            calculate_return_yen(0, 100)

    def test_generate_value_tickets_deduplicates_and_uses_100_yen_unit(self) -> None:
        breakdown = ScoreBreakdown(50, 0, 0, 0, 0, 0, 0, 0, 0, 50, [])
        candidates = [
            ScoredRunner(number, f"馬{number}", None, odds, 5 + number, 80 - number, 20.0, 12.0, "☆", False, breakdown)
            for number, odds in ((1, 6.0), (2, 8.0), (3, 10.0), (4, 12.0))
        ]

        tickets = generate_value_tickets(candidates, 100)
        identifiers = {(ticket.ticket_type, canonical_selection_key(ticket.ticket_type, ticket.selection)) for ticket in tickets}

        self.assertTrue(tickets)
        self.assertEqual(len(tickets), len(identifiers))
        self.assertTrue(all(ticket.stake_yen == 100 for ticket in tickets))
        self.assertIn("trifecta", {ticket.ticket_type for ticket in tickets})
        self.assertIn("trio", {ticket.ticket_type for ticket in tickets})
        self.assertIn("wide", {ticket.ticket_type for ticket in tickets})

    def test_insufficient_value_candidates_returns_no_tickets(self) -> None:
        breakdown = ScoreBreakdown(50, 0, 0, 0, 0, 0, 0, 0, 0, 50, [])
        candidates = [
            ScoredRunner(1, "馬1", None, 2.0, 1, 80, 50.0, 0.0, "◎", False, breakdown),
            ScoredRunner(2, "馬2", None, 3.0, 2, 70, 30.0, -10.0, "○", False, breakdown),
            ScoredRunner(3, "馬3", None, 5.0, 3, 60, 20.0, -20.0, "▲", False, breakdown),
        ]

        self.assertEqual(generate_value_tickets(candidates, 100), [])


if __name__ == "__main__":
    unittest.main()
