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
    gemini_api_key: SecretStr = Field(description="Gemini Developer API の API キー")
    gemini_model: str = "gemini-2.5-flash"

    # 現在時刻からこの分数前後を調べ、発走約10分前に一度だけ生成します。
    prediction_lead_minutes: int = Field(default=10, ge=1, le=120)
    prediction_window_seconds: int = Field(default=60, ge=15, le=300)
    lock_lease_seconds: int = Field(default=300, ge=60, le=1800)
    scheduler_interval_seconds: int = Field(default=60, ge=30, le=300)

    # ``mock`` はローカル検証用です。実運用では実データ連携実装を登録してください。
    data_provider: str = "mock"
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
        if normalized not in {"mock", "integration"}:
            raise ValueError("DATA_PROVIDER は mock または integration を指定してください。")
        return normalized


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """検証済み設定を一度だけ読み込む。"""

    return Settings()
