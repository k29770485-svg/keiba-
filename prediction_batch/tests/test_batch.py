"""外部 API・DB を使わないバッチ中核ロジックの単体テスト。"""

from __future__ import annotations

import json
import unittest
from datetime import datetime

from prediction_batch.batch import build_prediction_prompt, validate_prediction_against_race
from prediction_batch.models import (
    PredictedSelection,
    RaceMarketData,
    RacePredictionResult,
    RunnerMarketData,
)


class PredictionValidationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.market_data = RaceMarketData(
            race_id="test-race-001",
            fetched_at=datetime(2026, 8, 12, 1, 0, 0),
            scheduled_start_at=datetime(2026, 8, 12, 1, 10, 0),
            venue_name="テスト競馬場",
            race_number=1,
            runners=[
                RunnerMarketData(horse_number=1, horse_name="アルファ", win_odds=2.1),
                RunnerMarketData(horse_number=2, horse_name="ベータ", win_odds=3.8),
                RunnerMarketData(horse_number=3, horse_name="ガンマ", win_odds=6.2),
            ],
        )
        self.prediction = RacePredictionResult(
            summary="オッズと出走表から比較的拮抗したレースとみる。",
            win_candidate=PredictedSelection(
                horse_number=1,
                horse_name="アルファ",
                confidence=0.52,
                rationale="単勝オッズが最も低い。",
            ),
            place_candidates=[
                PredictedSelection(
                    horse_number=2,
                    horse_name="ベータ",
                    confidence=0.31,
                    rationale="次点のオッズである。",
                ),
                PredictedSelection(
                    horse_number=3,
                    horse_name="ガンマ",
                    confidence=0.17,
                    rationale="出走表に含まれる。",
                ),
            ],
            risk_level="high",
            risk_notes=["直近成績が不足している。"],
            disclaimer="予想は保証ではありません。",
        )

    def test_prompt_contains_normalized_race_data(self) -> None:
        prompt = build_prediction_prompt(self.market_data)
        self.assertIn("JSON", prompt)
        self.assertIn("test-race-001", prompt)
        self.assertIn(json.dumps("アルファ", ensure_ascii=False), prompt)

    def test_valid_prediction_matches_runners(self) -> None:
        validate_prediction_against_race(self.prediction, self.market_data)

    def test_unknown_horse_number_is_rejected(self) -> None:
        invalid = self.prediction.model_copy(
            update={
                "win_candidate": PredictedSelection(
                    horse_number=99,
                    horse_name="存在しない馬",
                    confidence=0.5,
                    rationale="テスト",
                )
            }
        )
        with self.assertRaisesRegex(ValueError, "存在しない馬番"):
            validate_prediction_against_race(invalid, self.market_data)

    def test_duplicate_horse_number_is_rejected(self) -> None:
        invalid = self.prediction.model_copy(
            update={
                "place_candidates": [
                    PredictedSelection(
                        horse_number=1,
                        horse_name="アルファ",
                        confidence=0.4,
                        rationale="テスト",
                    ),
                    self.prediction.place_candidates[1],
                ]
            }
        )
        with self.assertRaisesRegex(ValueError, "重複"):
            validate_prediction_against_race(invalid, self.market_data)


if __name__ == "__main__":
    unittest.main()
