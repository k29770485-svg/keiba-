-- MySQL 8.0+/MariaDB 10.6+ 向けスキーマ
-- すべての DATETIME は UTC として保存します。

CREATE TABLE IF NOT EXISTS races (
    race_id VARCHAR(64) NOT NULL COMMENT 'データ提供元で一意となるレースID',
    race_date DATE NOT NULL,
    venue_code VARCHAR(32) NOT NULL,
    venue_name VARCHAR(100) NOT NULL,
    race_number SMALLINT UNSIGNED NOT NULL,
    race_name VARCHAR(255) NULL,
    scheduled_start_at DATETIME NOT NULL COMMENT 'UTC の発走予定日時',
    race_status ENUM('scheduled', 'started', 'finished', 'cancelled') NOT NULL DEFAULT 'scheduled',
    source_url VARCHAR(2048) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (race_id),
    CONSTRAINT chk_races_race_number CHECK (race_number BETWEEN 1 AND 99),
    INDEX idx_races_prediction_window (race_status, scheduled_start_at),
    INDEX idx_races_calendar (race_date, venue_code, race_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS race_predictions (
    prediction_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    race_id VARCHAR(64) NOT NULL,
    generation_status ENUM('succeeded', 'failed') NOT NULL DEFAULT 'succeeded',
    model_name VARCHAR(128) NOT NULL,
    provider_name VARCHAR(64) NOT NULL,
    data_snapshot_json JSON NOT NULL COMMENT '予想生成時点の正規化済み最新データ',
    prediction_json JSON NOT NULL COMMENT 'Gemini の Pydantic 検証済み予想結果',
    generated_at DATETIME NOT NULL COMMENT 'UTC の生成完了日時',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (prediction_id),
    UNIQUE KEY uq_race_predictions_race_id (race_id),
    CONSTRAINT fk_race_predictions_race
        FOREIGN KEY (race_id) REFERENCES races (race_id)
        ON DELETE CASCADE ON UPDATE CASCADE,
    INDEX idx_race_predictions_status_generated (generation_status, generated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 複数プロセスや手動再実行が重なった場合でも、同じ race_id に対する
-- Gemini API 呼び出しを一件に抑えるための短期リースです。
-- ロック期限を過ぎた行は次のワーカーが再取得できます。
CREATE TABLE IF NOT EXISTS race_prediction_locks (
    race_id VARCHAR(64) NOT NULL,
    locked_by VARCHAR(128) NOT NULL,
    lease_expires_at DATETIME NOT NULL COMMENT 'UTC',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (race_id),
    CONSTRAINT fk_race_prediction_locks_race
        FOREIGN KEY (race_id) REFERENCES races (race_id)
        ON DELETE CASCADE ON UPDATE CASCADE,
    INDEX idx_race_prediction_locks_expiry (lease_expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 対象レース抽出の基本クエリです。
-- :window_start / :window_end は UTC で、通常は「現在+9分30秒」から
-- 「現在+10分30秒」の一分幅をバインドします。
-- 成功済み予想との LEFT JOIN により、保存済みレースは Gemini を呼び出しません。
-- SELECT
--     r.race_id,
--     r.race_date,
--     r.venue_code,
--     r.venue_name,
--     r.race_number,
--     r.race_name,
--     r.scheduled_start_at,
--     r.source_url
-- FROM races AS r
-- LEFT JOIN race_predictions AS p
--   ON p.race_id = r.race_id
--  AND p.generation_status = 'succeeded'
-- WHERE r.race_status = 'scheduled'
--   AND r.scheduled_start_at >= :window_start
--   AND r.scheduled_start_at < :window_end
--   AND p.race_id IS NULL
-- ORDER BY r.scheduled_start_at ASC;
