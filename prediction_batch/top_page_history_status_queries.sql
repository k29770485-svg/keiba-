-- Keiba De GO: 過去予想履歴・確定結果・発走前予想を明確に区別するSQL
--
-- 状態ラベルは表示用の契約であり、フロント側で推測してはならない。
-- :algorithm_version と :limit は必ずバインド変数として渡す。

-- ============================================================================
-- 1. リアルタイム更新状況
--    APIレスポンスに含め、「いつのデータか」を常に画面上へ表示する。
-- ============================================================================
SELECT
    UTC_TIMESTAMP() AS server_time_utc,
    (
      SELECT MAX(generated_at)
      FROM sql_prediction_runs
      WHERE algorithm_version = :algorithm_version
    ) AS latest_prediction_generated_at,
    (
      SELECT MAX(settled_at)
      FROM sql_prediction_tickets AS spt
      INNER JOIN sql_prediction_runs AS spr ON spr.prediction_id = spt.prediction_id
      WHERE spr.algorithm_version = :algorithm_version
        AND spt.settlement_status = 'settled'
    ) AS latest_ticket_settled_at,
    (
      SELECT MAX(updated_at)
      FROM prediction_performance_daily
      WHERE algorithm_version = :algorithm_version
    ) AS latest_daily_aggregated_at;


-- ============================================================================
-- 2. 発走前予想: 「発走前・予想確定」として表示するカード
--    結果・回収率を混在させない。払い戻しはまだ発生していない。
-- ============================================================================
SELECT
    r.race_id,
    r.race_date,
    r.venue_name,
    r.race_number,
    r.race_name,
    r.scheduled_start_at,
    spr.generated_at AS prediction_generated_at,
    spr.total_stake_yen,
    spr.ticket_count,
    'prediction_ready' AS display_state,
    '発走前・予想確定' AS display_label,
    '確定結果・回収率は発走後の払戻確定まで表示しません' AS display_note
FROM sql_prediction_runs AS spr
INNER JOIN races AS r ON r.race_id = spr.race_id
WHERE spr.algorithm_version = :algorithm_version
  AND spr.status = 'generated'
  AND r.race_status = 'scheduled'
  AND r.scheduled_start_at > UTC_TIMESTAMP()
ORDER BY r.scheduled_start_at ASC
LIMIT :limit;


-- ============================================================================
-- 3. 結果待ち: レースは終了したが、払戻・精算がまだ完了していない履歴
--    「外れ」と誤表示しないため、結果未精算と明示する。
-- ============================================================================
SELECT
    r.race_id,
    r.race_date,
    r.venue_name,
    r.race_number,
    r.race_name,
    r.scheduled_start_at,
    spr.generated_at AS prediction_generated_at,
    spr.total_stake_yen,
    spr.ticket_count,
    COUNT(spt.ticket_id) AS ticket_count_recorded,
    SUM(CASE WHEN spt.settlement_status = 'pending' THEN 1 ELSE 0 END) AS pending_ticket_count,
    'result_pending' AS display_state,
    '結果待ち・払戻未確定' AS display_label,
    '払戻データの確定後に収支と回収率へ反映します' AS display_note
FROM sql_prediction_runs AS spr
INNER JOIN races AS r ON r.race_id = spr.race_id
LEFT JOIN sql_prediction_tickets AS spt ON spt.prediction_id = spr.prediction_id
WHERE spr.algorithm_version = :algorithm_version
  AND r.race_status = 'finished'
  AND spr.status = 'generated'
GROUP BY
    r.race_id, r.race_date, r.venue_name, r.race_number, r.race_name,
    r.scheduled_start_at, spr.prediction_id, spr.generated_at,
    spr.total_stake_yen, spr.ticket_count
ORDER BY r.scheduled_start_at DESC
LIMIT :limit;


-- ============================================================================
-- 4. 過去予想履歴・確定結果: 精算済みだけを表示する
--    投資・払戻・収支・回収率を実値で返す。予想なし／見送りはゼロ円と明示する。
-- ============================================================================
SELECT
    r.race_id,
    r.race_date,
    r.venue_name,
    r.race_number,
    r.race_name,
    r.scheduled_start_at,
    spr.generated_at AS prediction_generated_at,
    MAX(spt.settled_at) AS settlement_completed_at,
    spr.ticket_count AS recommended_ticket_count,
    COALESCE(SUM(spt.stake_yen), 0) AS total_stake_yen,
    COALESCE(SUM(spt.return_yen), 0) AS total_return_yen,
    COALESCE(SUM(spt.net_yen), 0) AS total_net_yen,
    COALESCE(SUM(CASE WHEN spt.return_yen > 0 THEN 1 ELSE 0 END), 0) AS hit_ticket_count,
    COUNT(spt.ticket_id) AS settled_ticket_count,
    COALESCE(
      ROUND(SUM(spt.return_yen) / NULLIF(SUM(spt.stake_yen), 0) * 100, 2),
      0
    ) AS recovery_rate_pct,
    CASE
      WHEN spr.ticket_count = 0 THEN 'no_bet_settled'
      WHEN SUM(CASE WHEN spt.return_yen > 0 THEN 1 ELSE 0 END) > 0 THEN 'hit_settled'
      ELSE 'miss_settled'
    END AS display_state,
    CASE
      WHEN spr.ticket_count = 0 THEN '見送り・結果確定'
      WHEN SUM(CASE WHEN spt.return_yen > 0 THEN 1 ELSE 0 END) > 0 THEN '的中・結果確定'
      ELSE '不的中・結果確定'
    END AS display_label,
    CASE
      WHEN spr.ticket_count = 0 THEN '購入推奨なしのため、投資額・払戻額は0円です'
      ELSE '投資額・払戻額・収支・回収率は確定払戻に基づく実績です'
    END AS display_note
FROM sql_prediction_runs AS spr
INNER JOIN races AS r ON r.race_id = spr.race_id
LEFT JOIN sql_prediction_tickets AS spt
  ON spt.prediction_id = spr.prediction_id
 AND spt.settlement_status = 'settled'
WHERE spr.algorithm_version = :algorithm_version
  AND r.race_status = 'finished'
  AND spr.status = 'settled'
GROUP BY
    r.race_id, r.race_date, r.venue_name, r.race_number, r.race_name,
    r.scheduled_start_at, spr.prediction_id, spr.generated_at, spr.ticket_count
ORDER BY r.scheduled_start_at DESC
LIMIT :limit;


-- ============================================================================
-- 5. 各履歴カードの上位予測・穴馬・買い目明細
--    :race_id と :algorithm_version を受け、表示対象を確定済みの一つに限定する。
-- ============================================================================
SELECT
    sps.horse_number,
    sps.horse_name,
    sps.jockey_name,
    sps.rating,
    sps.rank_position,
    sps.score,
    sps.odds,
    sps.popularity,
    sps.win_probability_pct,
    sps.expected_value_pct,
    sps.is_longshot,
    sps.score_breakdown_json,
    sps.missing_fields_json
FROM sql_prediction_scores AS sps
INNER JOIN sql_prediction_runs AS spr ON spr.prediction_id = sps.prediction_id
WHERE spr.race_id = :race_id
  AND spr.algorithm_version = :algorithm_version
ORDER BY sps.rank_position ASC;

SELECT
    spt.ticket_type,
    spt.selection_json,
    spt.stake_yen,
    spt.settlement_status,
    spt.return_yen,
    spt.net_yen,
    spt.settled_at
FROM sql_prediction_tickets AS spt
INNER JOIN sql_prediction_runs AS spr ON spr.prediction_id = spt.prediction_id
WHERE spr.race_id = :race_id
  AND spr.algorithm_version = :algorithm_version
ORDER BY FIELD(spt.ticket_type, 'trifecta', 'trio', 'wide'), spt.selection_key;
