"""日次成績再集計のDB非依存テスト。"""

from __future__ import annotations

import unittest
from datetime import date, datetime

from prediction_batch.daily_performance import (
    COUNT_DAILY_ROWS_SQL,
    DELETE_DAILY_ROWS_SQL,
    REBUILD_DAILY_ROWS_SQL,
    normalize_date_window,
    refresh_daily_performance,
)


class RecordingSession:
    def __init__(self, daily_rows: int) -> None:
        self.daily_rows = daily_rows
        self.executed: list[tuple[str, dict[str, object]]] = []
        self.scalar_calls: list[tuple[str, dict[str, object]]] = []

    def execute(self, statement: object, parameters: dict[str, object]) -> None:
        self.executed.append((str(statement), parameters))

    def scalar(self, statement: object, parameters: dict[str, object]) -> int:
        self.scalar_calls.append((str(statement), parameters))
        return self.daily_rows


class DailyPerformanceTests(unittest.TestCase):
    def test_normalize_date_window_rejects_empty_or_reversed_ranges(self) -> None:
        with self.assertRaises(ValueError):
            normalize_date_window(date(2026, 8, 13), date(2026, 8, 13))
        with self.assertRaises(ValueError):
            normalize_date_window(date(2026, 8, 14), date(2026, 8, 13))

    def test_refresh_deletes_then_rebuilds_the_same_half_open_window(self) -> None:
        session = RecordingSession(daily_rows=6)

        stats = refresh_daily_performance(
            session,  # type: ignore[arg-type]
            date(2026, 8, 7),
            date(2026, 8, 14),
        )

        self.assertEqual(stats.daily_rows, 6)
        self.assertEqual(stats.start_date, date(2026, 8, 7))
        self.assertEqual(stats.end_date_exclusive, date(2026, 8, 14))
        self.assertEqual(len(session.executed), 2)
        self.assertIn("DELETE FROM prediction_performance_daily", session.executed[0][0])
        self.assertIn("INSERT INTO prediction_performance_daily", session.executed[1][0])
        self.assertEqual(session.executed[0][1]["start_at"], datetime(2026, 8, 7, 0, 0))
        self.assertEqual(session.executed[0][1]["end_at"], datetime(2026, 8, 14, 0, 0))
        self.assertEqual(len(session.scalar_calls), 1)
        self.assertIn("COUNT(*)", session.scalar_calls[0][0])

    def test_rebuild_sql_uses_raw_settled_tickets_and_not_existing_daily_values(self) -> None:
        statement = str(REBUILD_DAILY_ROWS_SQL)
        self.assertIn("FROM sql_prediction_tickets", statement)
        self.assertIn("settlement_status = 'settled'", statement)
        self.assertIn("GROUP BY DATE(spt.settled_at), spr.algorithm_version, spt.ticket_type", statement)
        self.assertNotIn("ON DUPLICATE KEY UPDATE", statement)
        self.assertIn("prediction_performance_daily", str(DELETE_DAILY_ROWS_SQL))
        self.assertIn("prediction_performance_daily", str(COUNT_DAILY_ROWS_SQL))


if __name__ == "__main__":
    unittest.main()
