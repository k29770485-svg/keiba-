"""設定、データ提供元、MySQL 方言のスキーマ生成を確認するテスト。"""

from __future__ import annotations

import unittest
from datetime import datetime

from sqlalchemy.dialects import mysql
from sqlalchemy.schema import CreateTable

from prediction_batch.batch import DueRace, MockRaceDataProvider, create_data_provider
from prediction_batch.config import Settings
from prediction_batch.models import Race, RacePrediction


class ConfigurationAndSchemaTests(unittest.TestCase):
    @staticmethod
    def create_settings(**overrides: object) -> Settings:
        values: dict[str, object] = {
            "database_url": "mysql+pymysql://user:password@localhost:3306/keiba?charset=utf8mb4",
            "gemini_api_key": "test-key",
        }
        values.update(overrides)
        return Settings(**values)

    def test_settings_accept_mysql_pymysql_url(self) -> None:
        settings = self.create_settings(data_provider="MOCK")
        self.assertEqual(settings.data_provider, "mock")
        self.assertEqual(settings.prediction_lead_minutes, 10)

    def test_settings_reject_non_mysql_url(self) -> None:
        with self.assertRaises(ValueError):
            self.create_settings(database_url="postgresql://localhost/keiba")

    def test_mock_provider_returns_market_data_for_target_race(self) -> None:
        race = DueRace(
            race_id="test-race-001",
            venue_name="テスト競馬場",
            race_number=1,
            scheduled_start_at=datetime(2026, 8, 12, 1, 10, 0),
            race_name="テストレース",
            source_url=None,
        )
        provider = create_data_provider(self.create_settings(data_provider="mock"))
        market_data = provider.fetch_market_data(race)
        self.assertIsInstance(provider, MockRaceDataProvider)
        self.assertEqual(market_data.race_id, race.race_id)
        self.assertEqual(len(market_data.runners), 8)

    def test_mysql_schema_uses_unsigned_identifiers(self) -> None:
        races_ddl = str(CreateTable(Race.__table__).compile(dialect=mysql.dialect()))
        predictions_ddl = str(CreateTable(RacePrediction.__table__).compile(dialect=mysql.dialect()))
        self.assertIn("SMALLINT UNSIGNED", races_ddl)
        self.assertIn("BIGINT UNSIGNED", predictions_ddl)
        self.assertIn("UNIQUE (race_id)", predictions_ddl)


if __name__ == "__main__":
    unittest.main()
