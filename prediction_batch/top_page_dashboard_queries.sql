-- Keiba De GO トップページ向けSQLクエリ集
--
-- 前提: prediction_batch/schema.sql を適用済みであること。
-- すべての時刻はUTC。表示時だけクライアントのタイムゾーンへ変換する。
-- :algorithm_version, :limit, :days はプレースホルダーであり、必ずバインド変数で渡す。

-- ============================================================================
-- 1. 回収率サマリー（全券種合計）
--    回収率は精算済みチケットだけで算出する。未確定の未来レースは含めない。
-- ============================================================================
SELECT
    COALESCE(SUM(total_stake_yen), 0) AS total_stake_yen,
    COALESCE(SUM(total_return_yen), 0) AS total_return_yen,
    COALESCE(SUM(total_net_yen), 0) AS total_net_yen,
    COALESCE(SUM(settled_ticket_count), 0) AS settled_ticket_count,
    COALESCE(SUM(hit_ticket_count), 0) AS hit_ticket_count,
    COALESCE(
      ROUND(
        SUM(hit_ticket_count) / NULLIF(SUM(settled_ticket_count), 0) * 100,
        2
      ),
      0
    ) AS hit_rate_pct,
    COALESCE(
      ROUND(
        SUM(total_return_yen) / NULLIF(SUM(total_stake_yen), 0) * 100,
        2
      ),
      0
    ) AS recovery_rate_pct
FROM sql_prediction_performance_summary
WHERE algorithm_version = :algorithm_version;


-- ============================================================================
-- 2. 券種別の回収率サマリー
--    表示順はフロント側で調整できるよう、券種キーと集計値をそのまま返す。
-- ============================================================================
SELECT
    ticket_type,
    settled_ticket_count,
    total_stake_yen,
    total_return_yen,
    total_net_yen,
    hit_ticket_count,
    hit_rate_pct,
    recovery_rate_pct
FROM sql_prediction_performance_summary
WHERE algorithm_version = :algorithm_version
ORDER BY FIELD(ticket_type, 'trifecta', 'trio', 'wide');


-- ============================================================================
-- 3. 直近の発走前レースと上位5頭
--    予想が保存済みで、まだ発走前のレースだけをトップページに出す。
--    top_predictions_json は各馬のスコア内訳を必要最小限に絞ったJSON配列。
-- ============================================================================
WITH upcoming_runs AS (
    SELECT
        spr.prediction_id,
        spr.race_id,
        spr.algorithm_version,
        spr.generated_at,
        spr.total_stake_yen,
        spr.ticket_count,
        r.race_date,
        r.venue_name,
        r.race_number,
        r.race_name,
        r.scheduled_start_at
    FROM sql_prediction_runs AS spr
    INNER JOIN races AS r ON r.race_id = spr.race_id
    WHERE spr.algorithm_version = :algorithm_version
      AND spr.status = 'generated'
      AND r.race_status = 'scheduled'
      AND r.scheduled_start_at > UTC_TIMESTAMP()
    ORDER BY r.scheduled_start_at ASC
    LIMIT :limit
)
SELECT
    ur.race_id,
    ur.algorithm_version,
    ur.race_date,
    ur.venue_name,
    ur.race_number,
    ur.race_name,
    ur.scheduled_start_at,
    ur.generated_at,
    ur.total_stake_yen,
    ur.ticket_count,
    JSON_ARRAYAGG(
        JSON_OBJECT(
            'rankPosition', sps.rank_position,
            'horseNumber', sps.horse_number,
            'horseName', sps.horse_name,
            'jockeyName', sps.jockey_name,
            'odds', sps.odds,
            'popularity', sps.popularity,
            'score', sps.score,
            'rating', sps.rating,
            'winProbabilityPct', sps.win_probability_pct,
            'expectedValuePct', sps.expected_value_pct,
            'isLongshot', sps.is_longshot,
            'missingFields', sps.missing_fields_json
        )
    ) AS top_predictions_json
FROM upcoming_runs AS ur
INNER JOIN sql_prediction_scores AS sps ON sps.prediction_id = ur.prediction_id
WHERE sps.rank_position <= 5
GROUP BY
    ur.prediction_id,
    ur.race_id,
    ur.algorithm_version,
    ur.race_date,
    ur.venue_name,
    ur.race_number,
    ur.race_name,
    ur.scheduled_start_at,
    ur.generated_at,
    ur.total_stake_yen,
    ur.ticket_count
ORDER BY ur.scheduled_start_at ASC;


-- ============================================================================
-- 4. 直近の穴馬候補
--    将来レースかつ保存済みのスコアに限定する。穴馬判定は予想生成時の記録を使用し、
--    表示時に改めて閾値計算をしない。
-- ============================================================================
SELECT
    r.race_id,
    r.race_date,
    r.venue_name,
    r.race_number,
    r.race_name,
    r.scheduled_start_at,
    sps.horse_number,
    sps.horse_name,
    sps.jockey_name,
    sps.odds,
    sps.popularity,
    sps.score,
    sps.rating,
    sps.win_probability_pct,
    sps.expected_value_pct,
    sps.score_breakdown_json,
    sps.missing_fields_json
FROM sql_prediction_runs AS spr
INNER JOIN races AS r ON r.race_id = spr.race_id
INNER JOIN sql_prediction_scores AS sps ON sps.prediction_id = spr.prediction_id
WHERE spr.algorithm_version = :algorithm_version
  AND spr.status = 'generated'
  AND r.race_status = 'scheduled'
  AND r.scheduled_start_at > UTC_TIMESTAMP()
  AND sps.is_longshot = TRUE
ORDER BY
    sps.expected_value_pct DESC,
    sps.score DESC,
    r.scheduled_start_at ASC
LIMIT :limit;


-- ============================================================================
-- 5. 日別の回収率推移（直近 :days 日）
--    実績グラフ用。精算済みのみを対象とし、日付は精算日時でまとめる。
-- ============================================================================
SELECT
    DATE(spt.settled_at) AS settled_date,
    SUM(spt.stake_yen) AS total_stake_yen,
    SUM(spt.return_yen) AS total_return_yen,
    SUM(spt.net_yen) AS total_net_yen,
    COUNT(*) AS settled_ticket_count,
    SUM(CASE WHEN spt.return_yen > 0 THEN 1 ELSE 0 END) AS hit_ticket_count,
    ROUND(
        SUM(spt.return_yen) / NULLIF(SUM(spt.stake_yen), 0) * 100,
        2
    ) AS recovery_rate_pct
FROM sql_prediction_tickets AS spt
INNER JOIN sql_prediction_runs AS spr ON spr.prediction_id = spt.prediction_id
WHERE spr.algorithm_version = :algorithm_version
  AND spt.settlement_status = 'settled'
  AND spt.settled_at >= UTC_TIMESTAMP() - INTERVAL :days DAY
GROUP BY DATE(spt.settled_at)
ORDER BY settled_date ASC;


-- ============================================================================
-- 6. レース詳細画面の買い目と精算結果
--    :race_id はURLパラメータから直接連結せず、必ずバインドする。
-- ============================================================================
SELECT
    spr.race_id,
    spr.algorithm_version,
    spr.generated_at,
    spr.total_stake_yen,
    spr.ticket_count,
    spt.ticket_type,
    spt.selection_json,
    spt.selection_key,
    spt.stake_yen,
    spt.settlement_status,
    spt.return_yen,
    spt.net_yen,
    spt.settled_at
FROM sql_prediction_runs AS spr
LEFT JOIN sql_prediction_tickets AS spt ON spt.prediction_id = spr.prediction_id
WHERE spr.race_id = :race_id
  AND spr.algorithm_version = :algorithm_version
ORDER BY FIELD(spt.ticket_type, 'trifecta', 'trio', 'wide'), spt.selection_key;
