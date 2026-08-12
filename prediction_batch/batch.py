"""発走約10分前のレースについて予想を生成・保存するバッチ処理。"""

from __future__ import annotations

import json
import logging
import socket
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Protocol

from google import genai
from google.genai import types
from sqlalchemy import Engine, delete, select, text
from sqlalchemy.dialects.mysql import insert as mysql_insert
from sqlalchemy.orm import Session, sessionmaker

from .config import Settings
from .models import (
    Race,
    RaceMarketData,
    RacePrediction,
    RacePredictionLock,
    RacePredictionResult,
    RunnerMarketData,
)

logger = logging.getLogger(__name__)


# 成功済み予想を LEFT JOIN で除外します。レースの発走予定日時は UTC として扱います。
DUE_RACES_SQL = text(
    """
    SELECT
        r.race_id,
        r.race_date,
        r.venue_code,
        r.venue_name,
        r.race_number,
        r.race_name,
        r.scheduled_start_at,
        r.source_url
    FROM races AS r
    LEFT JOIN race_predictions AS p
      ON p.race_id = r.race_id
     AND p.generation_status = 'succeeded'
    WHERE r.race_status = 'scheduled'
      AND r.scheduled_start_at >= :window_start
      AND r.scheduled_start_at < :window_end
      AND p.race_id IS NULL
    ORDER BY r.scheduled_start_at ASC
    """
)

# INSERT ... ON DUPLICATE KEY UPDATE による期限付きリース取得です。期限切れのロックだけを奪取します。
ACQUIRE_LOCK_SQL = text(
    """
    INSERT INTO race_prediction_locks (race_id, locked_by, lease_expires_at, created_at, updated_at)
    VALUES (:race_id, :locked_by, :lease_expires_at, :now, :now)
    ON DUPLICATE KEY UPDATE
      locked_by = IF(lease_expires_at < :now, VALUES(locked_by), locked_by),
      lease_expires_at = IF(lease_expires_at < :now, VALUES(lease_expires_at), lease_expires_at),
      updated_at = IF(lease_expires_at < :now, VALUES(updated_at), updated_at)
    """
)


@dataclass(frozen=True)
class DueRace:
    race_id: str
    venue_name: str
    race_number: int
    scheduled_start_at: datetime
    race_name: str | None
    source_url: str | None


@dataclass
class BatchRunStats:
    discovered: int = 0
    locked: int = 0
    generated: int = 0
    skipped: int = 0
    failed: int = 0


class RaceDataProvider(Protocol):
    """外部データ提供元を差し替えるためのインターフェース。"""

    name: str

    def fetch_market_data(self, race: DueRace) -> RaceMarketData:
        """対象レースのオッズ・馬場・出走表を正規化済みモデルで返す。"""


class MockRaceDataProvider:
    """DB・Gemini 接続を除くローカル動作確認用の決定的モック。"""

    name = "mock"

    def fetch_market_data(self, race: DueRace) -> RaceMarketData:
        runners = [
            RunnerMarketData(
                horse_number=number,
                horse_name=f"テストホース{number}",
                gate_number=((number - 1) // 2) + 1,
                jockey_name=f"テスト騎手{number}",
                trainer_name=f"テスト調教師{number}",
                win_odds=round(2.0 + (number * 1.7), 1),
                popularity=number,
                carried_weight_kg=57.0,
                recent_form=["近3走の成績は取得アダプタで置換してください"],
            )
            for number in range(1, 9)
        ]
        return RaceMarketData(
            race_id=race.race_id,
            fetched_at=utcnow(),
            scheduled_start_at=as_utc_naive(race.scheduled_start_at),
            venue_name=race.venue_name,
            race_number=race.race_number,
            race_name=race.race_name,
            course="モック競馬場 芝",
            surface="芝",
            distance_m=1600,
            track_condition="良",
            weather="晴",
            runners=runners,
            source_url=race.source_url,
        )


class SqlRaceDataProvider:
    """SQLへ投入済みの発走前スナップショットだけを読むデータ提供元。

    外部サイトへの取得や過去データの補完は行わない。投入元は許可済みの取込処理が
    ``race_market_snapshots`` に正規化済みJSONを書き込む前提とする。
    """

    name = "sql"

    def __init__(self, database_url: str) -> None:
        from sqlalchemy import create_engine

        self._engine = create_engine(database_url, pool_pre_ping=True, future=True)

    def fetch_market_data(self, race: DueRace) -> RaceMarketData:
        statement = text(
            """
            SELECT snapshot_json
            FROM race_market_snapshots
            WHERE race_id = :race_id
              AND is_ready_for_prediction = 1
              AND captured_at <= :scheduled_start_at
            ORDER BY captured_at DESC
            LIMIT 1
            """
        )
        with self._engine.connect() as connection:
            row = connection.execute(
                statement,
                {
                    "race_id": race.race_id,
                    "scheduled_start_at": as_utc_naive(race.scheduled_start_at),
                },
            ).mappings().first()

        if row is None:
            raise LookupError(
                f"race_id={race.race_id} に発走前のSQLスナップショットがありません。"
            )
        payload = row["snapshot_json"]
        if isinstance(payload, str):
            payload = json.loads(payload)
        market_data = RaceMarketData.model_validate(payload)
        if market_data.race_id != race.race_id:
            raise ValueError("SQLスナップショットのrace_idが対象レースと一致しません。")
        return market_data


class IntegrationRaceDataProvider:
    """実データ連携の実装位置を明示するアダプタ。

    契約または利用規約に従って利用できる公式 API・許可済みデータフィードを実装してください。
    HTML の構造や取得元をバッチ本体に混在させず、本クラスで
    ``RaceMarketData`` に正規化します。
    """

    name = "integration"

    def fetch_market_data(self, race: DueRace) -> RaceMarketData:
        raise NotImplementedError(
            "実データ連携は IntegrationRaceDataProvider.fetch_market_data() に実装してください。"
        )


def create_data_provider(settings: Settings) -> RaceDataProvider:
    if settings.data_provider == "mock":
        return MockRaceDataProvider()
    if settings.data_provider == "sql":
        return SqlRaceDataProvider(settings.database_url)
    return IntegrationRaceDataProvider()


def create_engine_and_session_factory(settings: Settings) -> tuple[Engine, sessionmaker[Session]]:
    """MySQL/MariaDB 向けプール設定を備えた Engine と SessionFactory を返す。"""

    from sqlalchemy import create_engine

    engine = create_engine(
        settings.database_url,
        pool_pre_ping=True,
        pool_recycle=1800,
        pool_size=5,
        max_overflow=5,
        future=True,
    )
    return engine, sessionmaker(bind=engine, expire_on_commit=False, future=True)


def utcnow() -> datetime:
    """MySQL の DATETIME に保存する tz-naive UTC 時刻。"""

    return datetime.now(timezone.utc).replace(tzinfo=None)


def as_utc_naive(value: datetime) -> datetime:
    """時刻を UTC の tz-naive DATETIME に正規化する。"""

    if value.tzinfo is None:
        return value
    return value.astimezone(timezone.utc).replace(tzinfo=None)


def get_due_races(session: Session, settings: Settings, now: datetime) -> list[DueRace]:
    """発走予定の約10分前に入った、成功済み予想がないレースを返す。"""

    center = now + timedelta(minutes=settings.prediction_lead_minutes)
    half_window = timedelta(seconds=settings.prediction_window_seconds / 2)
    rows = session.execute(
        DUE_RACES_SQL,
        {"window_start": center - half_window, "window_end": center + half_window},
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


def acquire_race_lock(
    session: Session,
    race_id: str,
    worker_id: str,
    now: datetime,
    lease_seconds: int,
) -> bool:
    """期限切れまたは未作成のリースを原子的に取得する。"""

    session.execute(
        ACQUIRE_LOCK_SQL,
        {
            "race_id": race_id,
            "locked_by": worker_id,
            "lease_expires_at": now + timedelta(seconds=lease_seconds),
            "now": now,
        },
    )
    lock = session.get(RacePredictionLock, race_id)
    return lock is not None and lock.locked_by == worker_id and lock.lease_expires_at > now


def release_race_lock(session: Session, race_id: str, worker_id: str) -> None:
    """自分が保持するリースだけを解放する。"""

    session.execute(
        delete(RacePredictionLock).where(
            RacePredictionLock.race_id == race_id,
            RacePredictionLock.locked_by == worker_id,
        )
    )


def build_prediction_prompt(market_data: RaceMarketData) -> str:
    """モデルに与える指示と、取得済みの正規化データを構築する。"""

    payload = json.dumps(market_data.model_dump(mode="json"), ensure_ascii=False, separators=(",", ":"))
    return f"""
あなたは競馬データの分析アシスタントです。以下の JSON は、発走直前に正規化された
出走表・オッズ・馬場等のデータです。JSON に含まれない事実、最新ニュース、外部知識は
使用しないでください。返答は指定された JSON スキーマに完全に従ってください。

制約:
- win_candidate と place_candidates は、必ず runners にある horse_number と horse_name を使う。
- win_candidate と place_candidates は重複させない。
- confidence は相対的な不確実性の指標であり、的中確率や利益を保証しない。
- 情報が不足または変動しやすい場合は risk_level と risk_notes に明記する。
- disclaimer には「予想は保証ではない」旨を日本語で記載する。

レースデータ:
{payload}
""".strip()


def generate_prediction(
    client: genai.Client,
    settings: Settings,
    market_data: RaceMarketData,
) -> RacePredictionResult:
    """最新 google-genai SDK の Pydantic response_schema で予想を生成・検証する。"""

    response = client.models.generate_content(
        model=settings.gemini_model,
        contents=build_prediction_prompt(market_data),
        config=types.GenerateContentConfig(
            temperature=0.2,
            response_mime_type="application/json",
            response_schema=RacePredictionResult,
        ),
    )

    if response.parsed is not None:
        if isinstance(response.parsed, RacePredictionResult):
            prediction = response.parsed
        else:
            prediction = RacePredictionResult.model_validate(response.parsed)
    elif response.text:
        prediction = RacePredictionResult.model_validate_json(response.text)
    else:
        raise RuntimeError("Gemini API が解析可能な構造化レスポンスを返しませんでした。")

    validate_prediction_against_race(prediction, market_data)
    return prediction


def validate_prediction_against_race(
    prediction: RacePredictionResult,
    market_data: RaceMarketData,
) -> None:
    """Pydantic の型検証に加え、候補が実際の出走馬だけであることを保証する。"""

    runners_by_number = {runner.horse_number: runner.horse_name for runner in market_data.runners}
    selections = [prediction.win_candidate, *prediction.place_candidates]
    selected_numbers = [selection.horse_number for selection in selections]

    if len(selected_numbers) != len(set(selected_numbers)):
        raise ValueError("Gemini の候補に馬番の重複があります。")

    for selection in selections:
        expected_name = runners_by_number.get(selection.horse_number)
        if expected_name is None:
            raise ValueError(f"存在しない馬番が予想に含まれています: {selection.horse_number}")
        if selection.horse_name != expected_name:
            raise ValueError(
                f"馬番 {selection.horse_number} の馬名が出走表と一致しません: "
                f"{selection.horse_name!r} != {expected_name!r}"
            )


def upsert_prediction(
    session: Session,
    race: DueRace,
    market_data: RaceMarketData,
    prediction: RacePredictionResult,
    settings: Settings,
    provider_name: str,
    now: datetime,
) -> None:
    """成功結果を原子的に INSERT/UPDATE 保存する。"""

    statement = mysql_insert(RacePrediction).values(
        race_id=race.race_id,
        generation_status="succeeded",
        model_name=settings.gemini_model,
        provider_name=provider_name,
        data_snapshot_json=market_data.model_dump(mode="json"),
        prediction_json=prediction.model_dump(mode="json"),
        generated_at=now,
    )
    statement = statement.on_duplicate_key_update(
        generation_status=statement.inserted.generation_status,
        model_name=statement.inserted.model_name,
        provider_name=statement.inserted.provider_name,
        data_snapshot_json=statement.inserted.data_snapshot_json,
        prediction_json=statement.inserted.prediction_json,
        generated_at=statement.inserted.generated_at,
        updated_at=now,
    )
    session.execute(statement)


def process_due_races(
    settings: Settings,
    session_factory: sessionmaker[Session],
    provider: RaceDataProvider | None = None,
    client: genai.Client | None = None,
) -> BatchRunStats:
    """一回分のバッチを実行し、件数統計を返す。

    API クライアントは対象レースがあるときだけ初期化します。対象がなければ
    Gemini API を呼ばないため、空振りの定期実行で API コストは発生しません。
    """

    provider = provider or create_data_provider(settings)
    worker_id = f"{socket.gethostname()}-{uuid.uuid4()}"
    stats = BatchRunStats()

    with session_factory() as session:
        due_races = get_due_races(session, settings, utcnow())
        stats.discovered = len(due_races)

    if not due_races:
        logger.info("発走約%s分前の未生成レースはありません。", settings.prediction_lead_minutes)
        return stats

    for race in due_races:
        now = utcnow()
        with session_factory.begin() as session:
            if not acquire_race_lock(session, race.race_id, worker_id, now, settings.lock_lease_seconds):
                stats.skipped += 1
                logger.info("race_id=%s は他ワーカーが処理中のためスキップしました。", race.race_id)
                continue

            # ロック待ちの間に別ワーカーが保存済みとした場合は API を呼ばない。
            already_saved = session.scalar(
                select(RacePrediction.prediction_id).where(
                    RacePrediction.race_id == race.race_id,
                    RacePrediction.generation_status == "succeeded",
                )
            )
            if already_saved is not None:
                release_race_lock(session, race.race_id, worker_id)
                stats.skipped += 1
                continue
            stats.locked += 1

        try:
            market_data = provider.fetch_market_data(race)
            if market_data.race_id != race.race_id:
                raise ValueError("データ提供元の race_id が対象レースと一致しません。")

            if client is None:
                if settings.gemini_api_key is None:
                    raise RuntimeError("Gemini予想を実行するにはGEMINI_API_KEYが必要です。SQL方式では不要です。")
                client = genai.Client(api_key=settings.gemini_api_key.get_secret_value())

            prediction = generate_prediction(client, settings, market_data)
            with session_factory.begin() as session:
                upsert_prediction(
                    session=session,
                    race=race,
                    market_data=market_data,
                    prediction=prediction,
                    settings=settings,
                    provider_name=provider.name,
                    now=utcnow(),
                )
                release_race_lock(session, race.race_id, worker_id)
            stats.generated += 1
            logger.info("race_id=%s の予想を保存しました。", race.race_id)
        except Exception:
            # 不確定な API タイムアウトでの連続呼び出しを避けるため、失敗時は
            # リースを残し、lease_expires_at 後にだけ再試行可能にします。
            stats.failed += 1
            logger.exception("race_id=%s の予想生成に失敗しました。", race.race_id)

    return stats
