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


-- ---------------------------------------------------------------------------
-- SQL蓄積型の将来レース予想・精算テーブル
--
-- これらのテーブルは新規レースだけを対象とする。過去レースの推測や補完は行わない。
-- sql_race_settlements.payouts_json は、券種別・馬番キー別の「100円あたり確定払戻」を保存する。
-- 例: {"trifecta":{"1-2-3":12540},"trio":{"1-2-3":1840},"wide":{"1-2":420}}
-- trifecta は着順どおり、trio / wide は馬番昇順のハイフン結合キーを使用する。
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sql_prediction_runs (
    prediction_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    race_id VARCHAR(64) NOT NULL,
    algorithm_version VARCHAR(64) NOT NULL,
    source_name VARCHAR(64) NOT NULL,
    snapshot_json JSON NOT NULL COMMENT '予想実行時点の正規化済み出走表・オッズ',
    generated_at DATETIME NOT NULL COMMENT 'UTC',
    total_stake_yen INT UNSIGNED NOT NULL DEFAULT 0,
    ticket_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    status ENUM('generated', 'settled', 'void') NOT NULL DEFAULT 'generated',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (prediction_id),
    UNIQUE KEY uq_sql_prediction_runs_race_algorithm (race_id, algorithm_version),
    CONSTRAINT fk_sql_prediction_runs_race
        FOREIGN KEY (race_id) REFERENCES races (race_id)
        ON DELETE CASCADE ON UPDATE CASCADE,
    INDEX idx_sql_prediction_runs_generated (generated_at),
    INDEX idx_sql_prediction_runs_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sql_prediction_scores (
    score_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    prediction_id BIGINT UNSIGNED NOT NULL,
    horse_number SMALLINT UNSIGNED NOT NULL,
    horse_name VARCHAR(120) NOT NULL,
    jockey_name VARCHAR(120) NULL,
    odds DECIMAL(10,3) NULL,
    popularity SMALLINT UNSIGNED NULL,
    score DECIMAL(10,3) NOT NULL,
    win_probability_pct DECIMAL(6,2) NOT NULL COMMENT 'レース内正規化した推定勝率。保証値ではない',
    expected_value_pct DECIMAL(10,2) NULL COMMENT '単勝オッズから算出する相対期待値。3連系期待値ではない',
    rating CHAR(1) NOT NULL,
    is_longshot BOOLEAN NOT NULL DEFAULT FALSE,
    score_breakdown_json JSON NOT NULL,
    missing_fields_json JSON NOT NULL COMMENT '未取得値。0点と区別する',
    rank_position SMALLINT UNSIGNED NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (score_id),
    UNIQUE KEY uq_sql_prediction_scores_prediction_horse (prediction_id, horse_number),
    CONSTRAINT fk_sql_prediction_scores_prediction
        FOREIGN KEY (prediction_id) REFERENCES sql_prediction_runs (prediction_id)
        ON DELETE CASCADE ON UPDATE CASCADE,
    INDEX idx_sql_prediction_scores_rank (prediction_id, rank_position),
    INDEX idx_sql_prediction_scores_longshot (is_longshot)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sql_prediction_tickets (
    ticket_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    prediction_id BIGINT UNSIGNED NOT NULL,
    ticket_type ENUM('trifecta', 'trio', 'wide') NOT NULL,
    selection_json JSON NOT NULL,
    selection_key VARCHAR(64) NOT NULL,
    stake_yen INT UNSIGNED NOT NULL,
    settlement_status ENUM('pending', 'settled', 'void') NOT NULL DEFAULT 'pending',
    return_yen INT UNSIGNED NULL,
    net_yen INT NULL,
    settled_at DATETIME NULL COMMENT 'UTC',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (ticket_id),
    UNIQUE KEY uq_sql_prediction_tickets_ticket (prediction_id, ticket_type, selection_key),
    CONSTRAINT fk_sql_prediction_tickets_prediction
        FOREIGN KEY (prediction_id) REFERENCES sql_prediction_runs (prediction_id)
        ON DELETE CASCADE ON UPDATE CASCADE,
    INDEX idx_sql_prediction_tickets_settlement (settlement_status, ticket_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sql_race_settlements (
    settlement_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    race_id VARCHAR(64) NOT NULL,
    actual_top3_json JSON NOT NULL COMMENT '確定した1〜3着の馬番。例: [1,2,3]',
    payouts_json JSON NOT NULL COMMENT '券種別・馬番キー別の100円あたり確定払戻',
    source_name VARCHAR(64) NOT NULL,
    is_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
    confirmed_at DATETIME NULL COMMENT 'UTC',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (settlement_id),
    UNIQUE KEY uq_sql_race_settlements_race (race_id),
    CONSTRAINT fk_sql_race_settlements_race
        FOREIGN KEY (race_id) REFERENCES races (race_id)
        ON DELETE CASCADE ON UPDATE CASCADE,
    INDEX idx_sql_race_settlements_confirmed (is_confirmed, confirmed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE OR REPLACE VIEW sql_prediction_performance_summary AS
SELECT
    spr.algorithm_version,
    spt.ticket_type,
    COUNT(*) AS settled_ticket_count,
    SUM(spt.stake_yen) AS total_stake_yen,
    SUM(spt.return_yen) AS total_return_yen,
    SUM(spt.net_yen) AS total_net_yen,
    SUM(CASE WHEN spt.return_yen > 0 THEN 1 ELSE 0 END) AS hit_ticket_count,
    ROUND(SUM(CASE WHEN spt.return_yen > 0 THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0) * 100, 2) AS hit_rate_pct,
    ROUND(SUM(spt.return_yen) / NULLIF(SUM(spt.stake_yen), 0) * 100, 2) AS recovery_rate_pct
FROM sql_prediction_tickets AS spt
JOIN sql_prediction_runs AS spr ON spr.prediction_id = spt.prediction_id
WHERE spt.settlement_status = 'settled'
GROUP BY spr.algorithm_version, spt.ticket_type;


-- 発走前の正規化済み出走表・オッズを投入する入力テーブル。
-- 取込元は契約済みフィードまたは公式データに限る。予想バッチはこのテーブルだけを読む。
CREATE TABLE IF NOT EXISTS race_market_snapshots (
    snapshot_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    race_id VARCHAR(64) NOT NULL,
    captured_at DATETIME NOT NULL COMMENT 'スナップショット取得時刻（UTC）',
    source_name VARCHAR(64) NOT NULL,
    snapshot_json JSON NOT NULL COMMENT 'RaceMarketData互換の正規化済みJSON',
    is_ready_for_prediction BOOLEAN NOT NULL DEFAULT FALSE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (snapshot_id),
    CONSTRAINT fk_race_market_snapshots_race
        FOREIGN KEY (race_id) REFERENCES races (race_id)
        ON DELETE CASCADE ON UPDATE CASCADE,
    INDEX idx_race_market_snapshots_ready (race_id, is_ready_for_prediction, captured_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ---------------------------------------------------------------------------
-- トップページ向け日次回収率集計
--
-- 外部キーを持たない派生表。精算済みチケットの値を再集計して置き換えるため、
-- 同じ日付を何度処理しても二重加算されない。
-- 将来パーティション化する場合にも、settled_date を主キーへ含めている。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS prediction_performance_daily (
    settled_date DATE NOT NULL COMMENT '精算日（UTC）',
    algorithm_version VARCHAR(64) NOT NULL,
    ticket_type ENUM('trifecta', 'trio', 'wide') NOT NULL,
    settled_ticket_count INT UNSIGNED NOT NULL DEFAULT 0,
    hit_ticket_count INT UNSIGNED NOT NULL DEFAULT 0,
    total_stake_yen BIGINT UNSIGNED NOT NULL DEFAULT 0,
    total_return_yen BIGINT UNSIGNED NOT NULL DEFAULT 0,
    total_net_yen BIGINT NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (settled_date, algorithm_version, ticket_type),
    KEY idx_ppd_algorithm_date_type (algorithm_version, settled_date, ticket_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
