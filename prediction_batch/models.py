"""SQLAlchemy 永続化モデルと、Gemini 入出力を検証する Pydantic モデル。"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import (
    JSON,
    CheckConstraint,
    Date,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.mysql import BIGINT, SMALLINT
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    """SQLAlchemy Declarative Base。"""


class Race(Base):
    __tablename__ = "races"

    race_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    race_date: Mapped[date] = mapped_column(Date, nullable=False)
    venue_code: Mapped[str] = mapped_column(String(32), nullable=False)
    venue_name: Mapped[str] = mapped_column(String(100), nullable=False)
    race_number: Mapped[int] = mapped_column(SMALLINT(unsigned=True), nullable=False)
    race_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    scheduled_start_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    race_status: Mapped[str] = mapped_column(
        Enum("scheduled", "started", "finished", "cancelled", name="race_status"),
        nullable=False,
        default="scheduled",
    )
    source_url: Mapped[str | None] = mapped_column(String(2048), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    __table_args__ = (
        CheckConstraint("race_number BETWEEN 1 AND 99", name="chk_races_race_number"),
        Index("idx_races_prediction_window", "race_status", "scheduled_start_at"),
        Index("idx_races_calendar", "race_date", "venue_code", "race_number"),
    )


class RacePrediction(Base):
    __tablename__ = "race_predictions"

    prediction_id: Mapped[int] = mapped_column(BIGINT(unsigned=True), primary_key=True, autoincrement=True)
    race_id: Mapped[str] = mapped_column(
        String(64),
        ForeignKey("races.race_id", ondelete="CASCADE", onupdate="CASCADE"),
        nullable=False,
    )
    generation_status: Mapped[str] = mapped_column(
        Enum("succeeded", "failed", name="prediction_generation_status"),
        nullable=False,
        default="succeeded",
    )
    model_name: Mapped[str] = mapped_column(String(128), nullable=False)
    provider_name: Mapped[str] = mapped_column(String(64), nullable=False)
    data_snapshot_json: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    prediction_json: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    generated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    __table_args__ = (
        UniqueConstraint("race_id", name="uq_race_predictions_race_id"),
        Index("idx_race_predictions_status_generated", "generation_status", "generated_at"),
    )


class RacePredictionLock(Base):
    __tablename__ = "race_prediction_locks"

    race_id: Mapped[str] = mapped_column(
        String(64),
        ForeignKey("races.race_id", ondelete="CASCADE", onupdate="CASCADE"),
        primary_key=True,
    )
    locked_by: Mapped[str] = mapped_column(String(128), nullable=False)
    lease_expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    __table_args__ = (Index("idx_race_prediction_locks_expiry", "lease_expires_at"),)


# ----- データ提供元から受け取る正規化済みの最新レース情報 -----

class RunnerMarketData(BaseModel):
    model_config = ConfigDict(extra="forbid")

    horse_number: int = Field(ge=1, le=99, description="馬番")
    horse_name: str = Field(min_length=1, max_length=120, description="馬名")
    gate_number: int | None = Field(default=None, ge=1, le=99, description="枠番")
    jockey_name: str | None = Field(default=None, max_length=120, description="騎手名")
    trainer_name: str | None = Field(default=None, max_length=120, description="調教師名")
    win_odds: float | None = Field(default=None, gt=0, description="単勝オッズ")
    popularity: int | None = Field(default=None, ge=1, description="単勝人気")
    carried_weight_kg: float | None = Field(default=None, gt=0, le=100, description="負担重量kg")
    age: int | None = Field(default=None, ge=2, le=20, description="年齢。不明時はnull")
    sire: str | None = Field(default=None, max_length=120, description="父馬。不明時はnull")
    horse_weight_kg: float | None = Field(default=None, gt=0, le=1000, description="馬体重kg。不明時はnull")
    horse_weight_diff_kg: float | None = Field(default=None, ge=-100, le=100, description="前走比馬体重差kg。不明時はnull")
    last3f_seconds: float | None = Field(default=None, gt=0, le=100, description="上がり3ハロン秒。不明時はnull")
    recent_form: list[str] = Field(default_factory=list, description="直近成績の要約")


class TicketMarketQuote(BaseModel):
    """券種・組合せごとの市場払戻見込みと、事前校正済みの的中確率。

    ``calibration_sample_size`` は同一券種・同一モデル版で、発走時点までに
    完全に精算されたウォークフォワード検証件数だけを指定する。未校正または
    小標本の値は買い目生成に使用しない。
    """

    model_config = ConfigDict(extra="forbid")

    ticket_type: Literal["trifecta", "trio", "wide"]
    selection: list[int] = Field(min_length=2, max_length=3)
    payout_per_100_yen: float = Field(gt=0, description="100円あたりの発走前払戻見込み")
    calibrated_probability_pct: float = Field(gt=0, le=100, description="校正済みの組合せ的中確率")
    calibration_sample_size: int = Field(ge=0, description="事前ウォークフォワード検証の精算済み件数")
    model_version: str = Field(min_length=1, max_length=64)


class RaceMarketData(BaseModel):
    """取得アダプタが返すデータ契約。

    このモデルの JSON を監査用にそのまま ``data_snapshot_json`` へ保存します。
    """

    model_config = ConfigDict(extra="forbid")

    race_id: str = Field(min_length=1, max_length=64)
    fetched_at: datetime
    scheduled_start_at: datetime
    venue_name: str = Field(min_length=1, max_length=100)
    race_number: int = Field(ge=1, le=99)
    race_name: str | None = Field(default=None, max_length=255)
    course: str | None = Field(default=None, max_length=255)
    surface: str | None = Field(default=None, max_length=40)
    distance_m: int | None = Field(default=None, ge=400, le=10000)
    track_condition: str | None = Field(default=None, max_length=40)
    weather: str | None = Field(default=None, max_length=40)
    runners: list[RunnerMarketData] = Field(min_length=2, max_length=40)
    ticket_market_quotes: list[TicketMarketQuote] = Field(
        default_factory=list,
        description="券種別の市場払戻見込みと校正済み確率。未提供なら買い目は見送る。",
    )
    source_url: str | None = Field(default=None, max_length=2048)


# ----- Gemini から取得する構造化予想結果 -----

class PredictedSelection(BaseModel):
    model_config = ConfigDict(extra="forbid")

    horse_number: int = Field(ge=1, le=99, description="馬番")
    horse_name: str = Field(min_length=1, max_length=120, description="馬名")
    confidence: float = Field(ge=0, le=1, description="相対的な確信度。的中確率や利益を保証しない。")
    rationale: str = Field(min_length=1, max_length=500, description="与えられたデータだけに基づく根拠")


class RacePredictionResult(BaseModel):
    """Gemini の ``response_schema`` として直接渡す出力契約。"""

    model_config = ConfigDict(extra="forbid")

    summary: str = Field(min_length=1, max_length=1000, description="レース全体の短い見立て")
    win_candidate: PredictedSelection = Field(description="最上位候補")
    place_candidates: list[PredictedSelection] = Field(
        min_length=2,
        max_length=3,
        description="連下を含む候補。win_candidate と重複させない。",
    )
    risk_level: Literal["low", "medium", "high"] = Field(description="データ不確実性の相対評価")
    risk_notes: list[str] = Field(
        min_length=1,
        max_length=4,
        description="オッズ変動、馬場、情報欠損などの注意点",
    )
    disclaimer: str = Field(
        min_length=1,
        max_length=300,
        description="予想は保証ではない旨の短い注意書き",
    )
