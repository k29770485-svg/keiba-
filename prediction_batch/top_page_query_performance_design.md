# Keiba De GO トップページSQLの性能設計

**対象:** `top_page_dashboard_queries.sql` と `top_page_api.sample.ts`。本設計は、発走前の予測カード、穴馬一覧、券種別回収率、日別回収率推移を対象にする。すべての提案は、実データベースで `EXPLAIN ANALYZE` を確認してから段階的に適用する。

> **結論:** 現行の予想・精算テーブルを直ちにパーティション化する必要はない。先に3本の複合インデックスと日次集計テーブルを導入し、原票が大規模化した場合だけ、外部キーを持たない日次集計テーブルを月次パーティション化する。

## 1. クエリ別のアクセス経路

| 画面・API | 主な絞り込み | 結合 | 集計・並び替え | 優先施策 |
|---|---|---|---|---|
| `/prediction-summary` の直近レース | `races.race_status`、`scheduled_start_at`、アルゴリズム版、予想状態 | `races → sql_prediction_runs → sql_prediction_scores` | 発走時刻昇順、各レース上位5頭 | `runs` のアルゴリズム・状態・レースID複合索引を追加する。 |
| 穴馬一覧 | アルゴリズム版、予想状態、将来レース、`is_longshot` | `races → runs → scores` | 相対期待値・スコア降順 | `scores` の予想ID・穴馬フラグ・期待値複合索引を追加する。 |
| 回収率サマリー | アルゴリズム版、精算済み | `runs → tickets` | 券種別集約 | 当面はチケット索引。履歴増加後は日次集計表を読む。 |
| 日別回収率推移 | アルゴリズム版、`settled_at` の期間、精算済み | `tickets → runs` | 日付単位の集約 | `tickets` の精算状態・精算日時・予想ID複合索引を追加する。 |
| レース詳細 | `race_id`、アルゴリズム版 | `runs → tickets` | 券種・選択キー順 | 現行の一意索引 `(race_id, algorithm_version)` とチケット一意索引で十分。 |

`races` にある既存索引 `(race_status, scheduled_start_at)` は、将来レースの抽出に適している。直近レースクエリは、実行計画がこの索引から始まることを確認する。`sql_prediction_runs` から全履歴を先に走査する実行計画なら、CTEを `races` 起点へ書き換えるか、次節の索引を追加する。

## 2. 優先度P0: 追加する複合インデックス

以下は**現行スキーマに追加可能な候補**である。書き込み負荷とストレージを増やすため、同時に全件追加せず、P0-1から順番に適用・計測する。

```sql
-- P0-1: 直近予測・穴馬クエリで、アルゴリズム版と実行状態から対象レースへ到達する。
ALTER TABLE sql_prediction_runs
  ADD INDEX idx_spr_algorithm_status_race (
    algorithm_version,
    status,
    race_id
  );

-- P0-2: 予測カードで上位馬、穴馬一覧で穴馬だけを読む。
-- 既存の (prediction_id, rank_position) は上位5頭用として維持する。
ALTER TABLE sql_prediction_scores
  ADD INDEX idx_sps_prediction_longshot_ev (
    prediction_id,
    is_longshot,
    expected_value_pct,
    score
  );

-- P0-3: アルゴリズム別集計で run から精算済み券へ到達する。
ALTER TABLE sql_prediction_tickets
  ADD INDEX idx_spt_prediction_status_type (
    prediction_id,
    settlement_status,
    ticket_type
  );

-- P0-4: 直近N日の日別回収率を、精算日時の範囲走査で読む。
ALTER TABLE sql_prediction_tickets
  ADD INDEX idx_spt_settlement_time_prediction (
    settlement_status,
    settled_at,
    prediction_id
  );
```

`sql_prediction_scores` のJSON列はインデックスへ含めない。トップページはJSON全体で絞り込まず、すでに列として正規化された `rank_position`、`is_longshot`、`expected_value_pct`、`score` を入口にしてから、必要なJSONだけを返す。この方針により索引の肥大化を避ける。

| 索引 | 効果が出るクエリ | 追加しない場合の兆候 | 適用判断 |
|---|---|---|---|
| `idx_spr_algorithm_status_race` | 直近予測・穴馬 | `sql_prediction_runs` の全表／大範囲走査 | 複数アルゴリズム版を残すなら優先度最高。 |
| `idx_sps_prediction_longshot_ev` | 穴馬一覧 | `scores` の結合後フィルタや大きな一時表 | 1レースごとに候補が少ない場合は効果が限定的。`EXPLAIN ANALYZE` で確認する。 |
| `idx_spt_prediction_status_type` | 回収率サマリー | `tickets` の精算状態フィルタを大量適用 | 履歴の精算済み券が増えたら導入する。 |
| `idx_spt_settlement_time_prediction` | 日別回収率推移 | 期間外の精算済みチケットまで走査 | 推移グラフを頻繁に表示するなら必須。 |

## 3. クエリ側の小さな改善

直近予測では、将来時刻を持つ `races` から先に少数のレースを選ぶ形を優先する。これにより、過去の `sql_prediction_runs` を不必要に読むリスクを抑えられる。

```sql
WITH target_races AS (
  SELECT race_id, race_date, venue_name, race_number, race_name, scheduled_start_at
  FROM races
  WHERE race_status = 'scheduled'
    AND scheduled_start_at > UTC_TIMESTAMP()
  ORDER BY scheduled_start_at
  LIMIT :limit
)
SELECT ...
FROM target_races AS r
JOIN sql_prediction_runs AS spr
  ON spr.race_id = r.race_id
 AND spr.algorithm_version = :algorithm_version
 AND spr.status = 'generated'
JOIN sql_prediction_scores AS sps
  ON sps.prediction_id = spr.prediction_id
 AND sps.rank_position <= 5
ORDER BY r.scheduled_start_at ASC, sps.rank_position ASC;
```

回収率サマリーは、原票ビューを毎リクエストで全履歴集計しない。次節の**日次集計表**へ移行すれば、トップページは少数行だけを合計できる。

## 4. 優先度P1: 日次集計テーブル

精算済みチケットが数十万件を超える、またはトップページの回収率APIが目標応答時間を満たさない場合は、精算処理と同じトランザクションで日次集計を更新する。トップページはチケット原票でなく、この表を読む。

```sql
CREATE TABLE prediction_performance_daily (
  settled_date DATE NOT NULL,
  algorithm_version VARCHAR(64) NOT NULL,
  ticket_type ENUM('trifecta', 'trio', 'wide') NOT NULL,
  settled_ticket_count INT UNSIGNED NOT NULL DEFAULT 0,
  hit_ticket_count INT UNSIGNED NOT NULL DEFAULT 0,
  total_stake_yen BIGINT UNSIGNED NOT NULL DEFAULT 0,
  total_return_yen BIGINT UNSIGNED NOT NULL DEFAULT 0,
  total_net_yen BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (settled_date, algorithm_version, ticket_type),
  KEY idx_ppd_algorithm_date_type (algorithm_version, settled_date, ticket_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

精算時はチケット確定と同一トランザクションで次のように加算する。冪等性を保つため、二重精算を防ぐ既存の `settlement_status='pending' → 'settled'` 遷移が前提である。

```sql
INSERT INTO prediction_performance_daily (
  settled_date, algorithm_version, ticket_type,
  settled_ticket_count, hit_ticket_count,
  total_stake_yen, total_return_yen, total_net_yen
) VALUES (
  DATE(:settled_at), :algorithm_version, :ticket_type,
  1, :is_hit, :stake_yen, :return_yen, :net_yen
)
ON DUPLICATE KEY UPDATE
  settled_ticket_count = settled_ticket_count + VALUES(settled_ticket_count),
  hit_ticket_count = hit_ticket_count + VALUES(hit_ticket_count),
  total_stake_yen = total_stake_yen + VALUES(total_stake_yen),
  total_return_yen = total_return_yen + VALUES(total_return_yen),
  total_net_yen = total_net_yen + VALUES(total_net_yen);
```

## 5. パーティショニング方針

### 推奨しない対象

現在の `sql_prediction_runs`、`sql_prediction_scores`、`sql_prediction_tickets`、`race_market_snapshots` は、外部キー制約を持つ、または外部キーで参照される。MySQLのパーティション化されたInnoDBテーブルは外部キーを持てず、外部キーから参照されることもできない。[1] さらに、パーティション式に使う列は、すべての一意キーおよび主キーに含める必要がある。[2]

したがって、これらの原票を `settled_at` や `generated_at` で直接月次パーティション化するには、外部キーを撤去し、主キー・一意キーを変更し、アプリ側の参照整合性も再設計する必要がある。トップページ高速化だけを目的にこの移行を行うのは、費用対効果が低い。

### 推奨する対象

`prediction_performance_daily` は外部キーを持たない派生集計表であり、主キーに `settled_date` を含められる。そのため、日次集計が数年分に増え、月単位の削除・アーカイブが必要になった時点でだけ、`RANGE COLUMNS(settled_date)` の月次パーティションを検討する。

```sql
CREATE TABLE prediction_performance_daily_partitioned (
  settled_date DATE NOT NULL,
  algorithm_version VARCHAR(64) NOT NULL,
  ticket_type ENUM('trifecta', 'trio', 'wide') NOT NULL,
  settled_ticket_count INT UNSIGNED NOT NULL DEFAULT 0,
  hit_ticket_count INT UNSIGNED NOT NULL DEFAULT 0,
  total_stake_yen BIGINT UNSIGNED NOT NULL DEFAULT 0,
  total_return_yen BIGINT UNSIGNED NOT NULL DEFAULT 0,
  total_net_yen BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (settled_date, algorithm_version, ticket_type),
  KEY idx_ppdp_algorithm_date_type (algorithm_version, settled_date, ticket_type)
) ENGINE=InnoDB
PARTITION BY RANGE COLUMNS (settled_date) (
  PARTITION p2026_08 VALUES LESS THAN ('2026-09-01'),
  PARTITION p2026_09 VALUES LESS THAN ('2026-10-01'),
  PARTITION p2026_10 VALUES LESS THAN ('2026-11-01'),
  PARTITION pmax VALUES LESS THAN (MAXVALUE)
);
```

`pmax` を恒久的に使わず、月初前に `REORGANIZE PARTITION pmax` で翌月分を追加する運用にする。保管期限を過ぎた集計は `DROP PARTITION` で削除できる。ただしパーティション数を増やすだけで性能は上がらず、インデックスとパーティション・プルーニングを両立させる必要がある。[1]

## 6. 導入順序と判定基準

| 段階 | 実施内容 | 開始条件 | 完了条件 |
|---|---|---|---|
| A | 既存索引と実行計画を計測する | 本番投入前 | 主要SQLの実行時間、rows examined、返却行数を記録。 |
| B | P0-1、P0-3、P0-4を追加する | 実行計画が大範囲走査、または精算履歴が増加 | `EXPLAIN ANALYZE` で対象索引の利用と読み取り行数低下を確認。 |
| C | P0-2を追加・再評価する | 穴馬一覧が遅い | `scores` の全走査／大きなfilesortが改善するか確認。 |
| D | 日次集計表へ書き込み、サマリーAPIを切替 | 回収率の原票集計が遅い、またはチケット数が数十万件超 | 原票集計との照合で投資・払戻・収支が一致。 |
| E | 日次集計表だけを月次パーティション化 | 年単位の保持・削除要件、または日次集計も大きくなった場合 | プルーニングと月次メンテナンスを監視可能。 |

## 7. 適用前後の検証

```sql
-- MySQL 8系: 実際のバインド値で確認する。
EXPLAIN ANALYZE
SELECT ...;

-- 索引統計を更新する。
ANALYZE TABLE
  sql_prediction_runs,
  sql_prediction_scores,
  sql_prediction_tickets;

-- 精算値と日次集計の整合を確認する。
SELECT
  spr.algorithm_version,
  spt.ticket_type,
  SUM(spt.stake_yen) AS raw_stake_yen,
  SUM(spt.return_yen) AS raw_return_yen
FROM sql_prediction_tickets AS spt
JOIN sql_prediction_runs AS spr ON spr.prediction_id = spt.prediction_id
WHERE spt.settlement_status = 'settled'
GROUP BY spr.algorithm_version, spt.ticket_type;
```

パーティショニングや再パーティショニングはテーブルロックやファイルシステム操作の影響を受けうるため、本番ピーク時間帯に直接実施しない。[1] まずステージング環境でDDL時間、ロック、実行計画、集計値の一致を確認する。

## 参考文献

[1] [MySQL 8.4 Reference Manual — Restrictions and Limitations on Partitioning](https://dev.mysql.com/doc/refman/8.4/en/partitioning-limitations.html)

[2] [MySQL 8.4 Reference Manual — Partitioning Keys, Primary Keys, and Unique Keys](https://dev.mysql.com/doc/refman/8.4/en/partitioning-limitations-partitioning-keys-unique-keys.html)
