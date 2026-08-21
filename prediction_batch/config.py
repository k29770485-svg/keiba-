"""環境変数を検証してバッチ設定を提供するモジュール。"""

from __future__ import annotations

from functools import lru_cache

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """実行環境の設定。

    ``DATABASE_URL`` は SQLAlchemy 形式を使います。
    例: ``mysql+pymysql://app_user:password@127.0.0.1:3306/keiba?charset=utf8mb4``
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    database_url: str = Field(description="SQLAlchemy MySQL/MariaDB 接続 URL")
    gemini_api_key: SecretStr | None = Field(default=None, description="Gemini併用時のDeveloper APIキー")
    gemini_model: str = "gemini-2.5-flash"

    # 現在時刻からこの分数前後を調べ、発走約10分前に一度だけ生成します。
    prediction_lead_minutes: int = Field(default=10, ge=1, le=120)
    prediction_window_seconds: int = Field(default=60, ge=15, le=300)
    lock_lease_seconds: int = Field(default=300, ge=60, le=1800)
    scheduler_interval_seconds: int = Field(default=60, ge=30, le=300)

    # SQL蓄積型の決定論的予想に使用する設定です。
    sql_algorithm_version: str = Field(default="sql-v3-ev-strict", min_length=1, max_length=64)
    ticket_stake_yen: int = Field(default=100, ge=100, le=10000, multiple_of=100)
    daily_performance_lookback_days: int = Field(default=7, ge=1, le=366)

    # 買い目は、券種別に事前校正された組合せ確率と発走前払戻見込みがそろう場合だけ生成する。
    # 直近2週間程度の小標本だけでは0件のままとし、ノイズによる穴馬の過剰評価を防ぐ。
    value_min_calibration_sample_size: int = Field(default=250, ge=30, le=100000)
    value_probability_confidence_z: float = Field(default=1.96, ge=0.0, le=4.0)
    value_min_conservative_ev_pct: float = Field(default=35.0, ge=0.0, le=1000.0)
    value_min_market_edge_pct: float = Field(default=50.0, ge=0.0, le=1000.0)
    value_max_tickets_per_race: int = Field(default=1, ge=1, le=10)

    # ``mock`` はローカル検証用です。実運用では実データ連携実装を登録してください。
    data_provider: str = "sql"
    log_level: str = "INFO"

    @field_validator("database_url")
    @classmethod
    def validate_database_url(cls, value: str) -> str:
        supported_prefixes = ("mysql+pymysql://", "mysql+mysqldb://", "mariadb+mariadbconnector://")
        if not value.startswith(supported_prefixes):
            raise ValueError(
                "DATABASE_URL は mysql+pymysql://、mysql+mysqldb://、"
                "mariadb+mariadbconnector:// のいずれかで指定してください。"
            )
        return value

    @field_validator("data_provider")
    @classmethod
    def normalize_data_provider(cls, value: str) -> str:
        normalized = value.strip().lower()
        if normalized not in {"mock", "integration", "sql"}:
            raise ValueError("DATA_PROVIDER は mock、integration、sql のいずれかを指定してください。")
        return normalized


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """検証済み設定を一度だけ読み込む。"""

    return Settings()
