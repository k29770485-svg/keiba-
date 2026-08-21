# SQLデータ契約

既存テーブル名・列名が異なる場合は、意味を保った対応表を作ってから実装する。時刻はUTCで保存し、表示時だけ利用者のタイムゾーンへ変換する。

## 基本テーブル

| テーブル | 主なキー | 最低限の列 | 不変条件 |
| --- | --- | --- | --- |
| `races` | `race_id` | `race_status`, `scheduled_start_at`, `race_date`, `venue_name`, `race_number`, `race_name` | `scheduled`、`finished` などのレース状態を持つ。 |
| `race_market_snapshots` | `snapshot_id` | `race_id`, `captured_at`, `scheduled_start_at`, `runners_json` | 予想対象時刻以前の入力だけを選べる。 |
| `sql_prediction_runs` | `prediction_id` | `race_id`, `algorithm_version`, `status`, `generated_at`, `total_stake_yen`, `ticket_count` | `(race_id, algorithm_version)` を一意にする。 |
| `sql_prediction_scores` | `score_id` | `prediction_id`, `horse_number`, `rank_position`, `score`, `expected_value_pct`, `is_longshot`, `missing_fields_json` | `(prediction_id, horse_number)` と `(prediction_id, rank_position)` を一意にする。 |
| `sql_prediction_tickets` | `ticket_id` | `prediction_id`, `ticket_type`, `selection_key`, `stake_yen`, `settlement_status`, `return_yen`, `net_yen`, `settled_at` | `(prediction_id, ticket_type, selection_key)` を一意にする。 |
| `sql_race_settlements` | `settlement_id` | `race_id`, `is_confirmed`, `payouts_json`, `confirmed_at` | 確定払戻だけを精算する。 |
| `prediction_performance_daily` | 複合主キー | `settled_date`, `algorithm_version`, `ticket_type`, 投資・払戻・収支・的中数 | 原票から再構築できる派生表にする。 |

## 推奨状態遷移

```text
race: scheduled → finished
prediction run: generated → settled
prediction ticket: pending → settled
```

`generated` のままレースが終了した予想は、払戻・精算待ちとして扱う。払戻不足がある限り `settled` へ遷移させない。見送りは `ticket_count=0` の `generated` を作成し、結果確定後に `settled` へ遷移できるようにする。

## 日次集計の最小DDL

```sql
CREATE TABLE IF NOT EXISTS prediction_performance_daily (
  settled_date DATE NOT NULL,
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

## 日次再構築SQL

同一トランザクションで、対象期間を削除してから原票で再生成する。

```sql
DELETE FROM prediction_performance_daily
WHERE settled_date >= :start_date AND settled_date < :end_date;

INSERT INTO prediction_performance_daily (
  settled_date, algorithm_version, ticket_type,
  settled_ticket_count, hit_ticket_count,
  total_stake_yen, total_return_yen, total_net_yen
)
SELECT
  DATE(spt.settled_at), spr.algorithm_version, spt.ticket_type,
  COUNT(*),
  SUM(CASE WHEN spt.return_yen > 0 THEN 1 ELSE 0 END),
  SUM(spt.stake_yen), SUM(spt.return_yen), SUM(spt.net_yen)
FROM sql_prediction_tickets AS spt
JOIN sql_prediction_runs AS spr ON spr.prediction_id = spt.prediction_id
WHERE spt.settlement_status = 'settled'
  AND spt.settled_at >= :start_at
  AND spt.settled_at < :end_at
GROUP BY DATE(spt.settled_at), spr.algorithm_version, spt.ticket_type;
```

## 索引の初期候補

| テーブル | 索引 | 支援する処理 |
| --- | --- | --- |
| `races` | `(race_status, scheduled_start_at)` | 発走前・結果待ちのレース抽出。 |
| `sql_prediction_runs` | `(algorithm_version, status, race_id)` | 状態別ダッシュボード。 |
| `sql_prediction_scores` | `(prediction_id, is_longshot, expected_value_pct, score)` | 穴馬一覧。 |
| `sql_prediction_tickets` | `(settlement_status, settled_at, prediction_id)` | 日別回収率と精算。 |

実際の導入時は、クエリの実行計画・行数・書き込み負荷を測定してから追加する。
