"""APScheduler で予想バッチを1分ごとに実行するエントリーポイント。"""

from __future__ import annotations

import logging
import signal
import sys
from datetime import timezone

from apscheduler.events import EVENT_JOB_ERROR, EVENT_JOB_EXECUTED
from apscheduler.schedulers.blocking import BlockingScheduler

from .batch import create_data_provider, create_engine_and_session_factory
from .config import get_settings
from .sql_pipeline import run_sql_cycle


def configure_logging(level: str) -> None:
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )


def main() -> None:
    settings = get_settings()
    configure_logging(settings.log_level)
    logger = logging.getLogger(__name__)

    engine, session_factory = create_engine_and_session_factory(settings)

    provider = create_data_provider(settings)

    def run_batch() -> None:
        prediction_stats, settlement_stats = run_sql_cycle(settings, session_factory, provider)
        logger.info(
            "SQL予想周期完了 discovered=%d locked=%d generated=%d skipped=%d failed=%d "
            "confirmed_races=%d settled_tickets=%d pending_tickets=%d",
            prediction_stats.discovered,
            prediction_stats.locked,
            prediction_stats.generated,
            prediction_stats.skipped,
            prediction_stats.failed,
            settlement_stats.confirmed_races,
            settlement_stats.settled_tickets,
            settlement_stats.pending_tickets,
        )

    scheduler = BlockingScheduler(
        timezone=timezone.utc,
        job_defaults={
            "coalesce": True,
            "max_instances": 1,
            "misfire_grace_time": settings.scheduler_interval_seconds,
        },
    )
    scheduler.add_job(
        run_batch,
        trigger="interval",
        seconds=settings.scheduler_interval_seconds,
        id="run_sql_prediction_and_settlement_cycle",
        replace_existing=True,
        next_run_time=None,
    )

    def on_job_event(event: object) -> None:
        exception = getattr(event, "exception", None)
        if exception:
            logger.error(
                "予想バッチのジョブ実行に失敗しました。",
                exc_info=(type(exception), exception, exception.__traceback__),
            )

    scheduler.add_listener(on_job_event, EVENT_JOB_ERROR | EVENT_JOB_EXECUTED)

    def shutdown(*_: object) -> None:
        logger.info("終了シグナルを受信したため、スケジューラーを停止します。")
        scheduler.shutdown(wait=True)
        engine.dispose()

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    logger.info(
        "SQL予想バッチを開始します。実行間隔=%s秒、目標発走時刻=%s分前、データ提供元=%s、アルゴリズム=%s",
        settings.scheduler_interval_seconds,
        settings.prediction_lead_minutes,
        settings.data_provider,
        settings.sql_algorithm_version,
    )
    try:
        scheduler.start()
    except (KeyboardInterrupt, SystemExit):
        shutdown()
        sys.exit(0)


if __name__ == "__main__":
    main()
