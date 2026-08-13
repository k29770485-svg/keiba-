"""トップページ用日次回収率集計を一度実行するエントリーポイント。"""

from __future__ import annotations

import logging

from .batch import create_engine_and_session_factory
from .config import get_settings
from .daily_performance import refresh_recent_daily_performance


def main() -> None:
    settings = get_settings()
    logging.basicConfig(
        level=getattr(logging, settings.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    logger = logging.getLogger(__name__)
    engine, session_factory = create_engine_and_session_factory(settings)
    try:
        stats = refresh_recent_daily_performance(
            session_factory,
            lookback_days=settings.daily_performance_lookback_days,
        )
        logger.info(
            "日次成績を再集計しました。開始日=%s 終了日（排他）=%s 集計行数=%d",
            stats.start_date,
            stats.end_date_exclusive,
            stats.daily_rows,
        )
    finally:
        engine.dispose()


if __name__ == "__main__":
    main()
