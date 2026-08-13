# 競馬予想の定期生成バッチ

このディレクトリは、**発走約10分前**にレースの最新スナップショットを取得し、Gemini の構造化 JSON 出力で予想を生成して MySQL/MariaDB に保存する Python 3.10+ バッチです。Web アプリケーションは生成時に Gemini を呼び出さず、`race_predictions.prediction_json` を読む構成を想定しています。

> 予想は不確実性を伴うデータ分析結果であり、的中や収益を保証しません。実データの取得は、契約および取得元の利用規約に適合する公式 API または許可済みデータフィードに限ってください。

## 構成

| ファイル | 役割 |
| --- | --- |
| `schema.sql` | `races`、`race_predictions`、短期処理ロックの MySQL/MariaDB DDL |
| `config.py` | DB URL、Gemini キー、実行間隔などの環境変数検証 |
| `models.py` | SQLAlchemy モデルと、Gemini 構造化出力用 Pydantic モデル |
| `batch.py` | 対象選択、最新データ取得、Gemini 呼び出し、検証、保存 |
| `main.py` | APScheduler による 1 分周期の常駐起動 |
| `requirements.txt` | Python 依存関係 |
| `.env.example` | 秘密情報を含まない設定テンプレート |

## 導入手順

MySQL/MariaDB に DB と最小権限のアプリケーションユーザーを用意したうえで、DDL を適用します。日時は一貫して UTC として保存してください。

```bash
cd prediction_batch
mysql --default-character-set=utf8mb4 -u keiba_app -p keiba < schema.sql

python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
chmod 600 .env
```

`.env` の `DATABASE_URL` と `GEMINI_API_KEY` を実値へ変更します。秘密情報は Git に追加してはいけません。

初回の動作確認では、`DATA_PROVIDER=mock` のまま、対象となるレースを `races` に一件投入します。`scheduled_start_at` は**現在 UTC の約10分後**に設定してください。

```sql
INSERT INTO races (
  race_id, race_date, venue_code, venue_name, race_number, race_name,
  scheduled_start_at, race_status
) VALUES (
  'demo-20260812-01', UTC_DATE(), 'DEMO', 'デモ競馬場', 1, 'テストレース',
  DATE_ADD(UTC_TIMESTAMP(), INTERVAL 10 MINUTE), 'scheduled'
);
```

Gemini API を実際に呼び出すため、上記の環境変数を設定した後に以下で起動します。

```bash
python -m prediction_batch.main
```

このワーカーは 1 分ごとに実行します。`APScheduler` の `max_instances=1` と `coalesce=True` により、プロセス内で処理が重なることを防ぎます。サービス管理では、プロセス監視・自動再起動・標準出力の集約を設定してください。

## 重複 API 呼び出しの防止

予想対象の取得には、成功済みの予想に対する **LEFT JOIN** を使用します。`race_predictions` に `generation_status='succeeded'` の行があるレースは検索結果から除外されるため、通常の周期実行では Gemini を再度呼び出しません。

```sql
SELECT r.race_id
FROM races AS r
LEFT JOIN race_predictions AS p
  ON p.race_id = r.race_id
 AND p.generation_status = 'succeeded'
WHERE r.race_status = 'scheduled'
  AND p.race_id IS NULL;
```

さらに、複数プロセス、再起動、手動実行が重なった場合に備え、`race_prediction_locks` にレース単位の期限付きリースを原子的に確保します。保存には `race_id` の一意制約と MySQL の `INSERT ... ON DUPLICATE KEY UPDATE` を用います。

| 状況 | 挙動 |
| --- | --- |
| 保存済みの成功予想がある | SQL 検索段階で除外し、API を呼ばない |
| 別ワーカーが処理中 | 期限付きリースを取得できずスキップする |
| 正常に生成できた | 検証済み JSON を INSERT/UPDATE 保存し、リースを解放する |
| 取得・生成に失敗した | リース期限まで再呼び出しを抑制し、期限後に未生成として再試行できる |

## 実データ連携の実装位置

`batch.py` の `IntegrationRaceDataProvider.fetch_market_data()` に、利用許諾のあるデータソースとの連携を実装します。戻り値は必ず `RaceMarketData` とし、最低限、出走馬、馬番、オッズ、馬場状態、発走予定時刻を正規化してください。データ取得層と予想生成層を分離しているため、公式 API、契約済みフィード、既存 DB を同じバッチ本体へ影響なく切り替えられます。

```python
class IntegrationRaceDataProvider:
    name = "approved_feed"

    def fetch_market_data(self, race: DueRace) -> RaceMarketData:
        # 1. 許可済みデータソースから race.race_id の最新情報を取得する
        # 2. オッズ、馬場、出走表、直近成績を検証する
        # 3. RaceMarketData(...) に正規化して返す
        ...
```

`DATA_PROVIDER=integration` はこの実装を完了してから指定してください。標準実装は意図的に `NotImplementedError` とするため、モックを本番データと誤認して保存することはありません。

## Gemini の構造化出力

`generate_prediction()` は `google-genai` の `types.GenerateContentConfig` に次を設定しています。

```python
response_mime_type="application/json"
response_schema=RacePredictionResult
```

`RacePredictionResult` は Pydantic モデルであり、SDK が返す `response.parsed` を再検証します。さらに、選択馬が当該レースの実在出走馬と一致すること、候補馬番が重複していないことをアプリケーション側で検証してから保存します。Google の公式 SDK ドキュメントにある Pydantic スキーマを `response_schema` として渡す方式に沿った実装です。[1]

## 本番運用上の確認事項

1 分周期の常駐処理には、停止・休止しない実行環境が必要です。管理された Web アプリケーションの定期ジョブとして動かす方法と、既存のサーバーでプロセス管理する方法が代表的です。

| 運用方法 | 向く条件 | 留意点 |
| --- | --- | --- |
| 管理された定期ジョブ | 外部公開不要、負荷が軽く、運用を簡素化したい | 実行上限時間・環境変数・DB 接続の制限を確認する |
| 既存サーバーのプロセス管理 | Python 実行環境やデータ連携ライブラリを柔軟に管理したい | ヘルスチェック、再起動、ログ監視、秘密情報管理を整える |

本番切替前に、DB バックアップ、Gemini の利用上限・失敗時アラート、時刻同期、接続プール、実データ提供元の利用規約を確認してください。

## Web アプリからの参照例

Web 側は API 呼び出しをせず、保存済み JSON を取得します。

```sql
SELECT
  r.race_id,
  r.venue_name,
  r.race_number,
  r.scheduled_start_at,
  p.prediction_json,
  p.generated_at
FROM races AS r
JOIN race_predictions AS p ON p.race_id = r.race_id
WHERE r.race_id = :race_id
  AND p.generation_status = 'succeeded';
```

## 参考文献

[1]: https://googleapis.github.io/python-genai/ "Google Gen AI SDK documentation"


## SQL蓄積型の将来予想運用

通常の起動は、Geminiを都度呼び出す方式ではなく、`DATA_PROVIDER=sql` を使います。この方式は**過去レースを再取得・再予想しません**。許可済みの取込処理がSQLに保存した発走前スナップショットだけを読み、発走約10分前に一度だけ決定論的スコアを計算します。

| テーブル | 書き込み元 | 役割 |
| --- | --- | --- |
| `race_market_snapshots` | 許可済みの出走表・オッズ取込 | 発走前時点の入力を監査用JSONとして保存します。`is_ready_for_prediction=1` の最新行だけを利用します。 |
| `sql_prediction_runs` | 予想バッチ | 予想時点の入力、アルゴリズム版、総投資額を保存します。 |
| `sql_prediction_scores` | 予想バッチ | 各馬のスコア内訳、推定勝率、相対期待値、穴馬フラグ、欠損項目を保存します。 |
| `sql_prediction_tickets` | 予想バッチ | 実際に推奨した券を1点ごとに保存し、投資額を推測しません。 |
| `sql_race_settlements` | 許可済みの結果・払戻取込 | 確定着順と券種別の100円あたり払戻を保存します。 |

> `score_breakdown_json` の欠損項目は0点として補完せず、`missing_fields_json` に明示します。推定勝率・相対期待値・回収率は過去の結果や実際の払戻が確定した範囲だけで表示され、的中・利益を保証するものではありません。

### 発走前入力のSQL形式

入力JSONは `RaceMarketData` に準拠し、`race_id`、`fetched_at`、`scheduled_start_at`、競馬場・コース・馬場状態・出走馬を含めます。各出走馬は少なくとも `horse_number`、`horse_name`、可能なら `win_odds`、`popularity`、`gate_number`、`jockey_name` を持ちます。年齢・父馬・馬体重増減などが未取得ならnullのまま保存してください。

```sql
INSERT INTO race_market_snapshots (
  race_id, captured_at, source_name, snapshot_json, is_ready_for_prediction
) VALUES (
  :race_id, :captured_at_utc, :source_name, :race_market_data_json, TRUE
);
```

### 結果・払戻のSQL形式

結果取込では、レースを `finished` に更新したうえで、`sql_race_settlements` に確定値をUPSERTします。`payouts_json` のキーは `trifecta`、`trio`、`wide` で、値は馬番キーと100円あたり払戻の対応表です。三連単は着順どおり、三連複とワイドは馬番昇順のキーです。

```sql
INSERT INTO sql_race_settlements (
  race_id, actual_top3_json, payouts_json, source_name, is_confirmed, confirmed_at
) VALUES (
  :race_id,
  JSON_ARRAY(1, 2, 3),
  JSON_OBJECT(
    'trifecta', JSON_OBJECT('1-2-3', 12540),
    'trio', JSON_OBJECT('1-2-3', 1840),
    'wide', JSON_OBJECT('1-2', 420)
  ),
  :source_name, TRUE, UTC_TIMESTAMP()
)
ON DUPLICATE KEY UPDATE
  actual_top3_json = VALUES(actual_top3_json),
  payouts_json = VALUES(payouts_json),
  source_name = VALUES(source_name),
  is_confirmed = TRUE,
  confirmed_at = VALUES(confirmed_at);
```

バッチは1周期ごとに、未生成の発走前レースを予想し、確定払戻が揃った保留チケットだけを精算します。払戻が未入力の券種は保留を維持するため、推測の回収率は生成されません。券種別の回収率は `sql_prediction_performance_summary` から参照できます。

```bash
cd prediction_batch
python -m prediction_batch.main
```

長時間の常駐実行には、サイトと同じSQLに接続できる管理されたバックグラウンド実行環境を使用してください。サービスが停止している間は予想対象の時間窓を逃すため、`SCHEDULER_INTERVAL_SECONDS=60` を維持し、プロセス監視と自動再起動を設定します。


## トップページ連携サンプル

トップページに今回の予測結果と回収率を表示するためのサンプルは、次のファイルにあります。

| ファイル | 内容 |
| --- | --- |
| `top_page_dashboard_queries.sql` | 全体・券種別の回収率、直近予測、穴馬候補、日別回収率推移、レース詳細を取得するSQLです。 |
| `top_page_api.sample.ts` | 上記SQLをバインド変数で実行するExpress APIの例です。`GET /api/top-page/prediction-summary` と `GET /api/top-page/recovery-trend` を提供します。 |

APIは、予測入力そのものや未確定の回収率を返しません。発走前レースについては保存済みのスコア・穴馬フラグ・買い目概要を、実績については精算済みチケットだけを返します。既存サイトのバックエンドへ組み込む際は、アプリで共有しているMySQLプールを `createTopPageApiRouter(pool)` に渡してルーターを登録してください。


## 日次回収率集計バッチ

`prediction_performance_daily` は、精算済みチケットを**精算日・アルゴリズム版・券種**ごとに集約するトップページ用の派生表です。`schema.sql` 適用後、次のコマンドで実行できます。

```bash
cd prediction_batch
python -m prediction_batch.daily_performance_batch
```

バッチは `DAILY_PERFORMANCE_LOOKBACK_DAYS` の直近日数（既定7日）を、削除して原票から再構築します。同じ範囲を再実行しても既存値へ加算しないため、払戻の遅延確定・訂正があっても二重計上しません。日次実行には、UTC日付が切り替わった後にこのコマンドを1回起動してください。

| テーブル／モジュール | 役割 |
| --- | --- |
| `prediction_performance_daily` | 日別・アルゴリズム別・券種別の投資額、払戻額、収支、的中券数を保存します。 |
| `daily_performance.py` | 半開期間 `[開始日, 終了日)` を削除後に原票から再構築する冪等な集計ロジックです。 |
| `daily_performance_batch.py` | 設定済みDBへ接続して直近期間の集計を一度実行するバッチ入口です。 |

トップページは、全期間・任意期間のサマリーを次のように取得できます。

```sql
SELECT
  algorithm_version,
  ticket_type,
  SUM(settled_ticket_count) AS settled_ticket_count,
  SUM(hit_ticket_count) AS hit_ticket_count,
  SUM(total_stake_yen) AS total_stake_yen,
  SUM(total_return_yen) AS total_return_yen,
  SUM(total_net_yen) AS total_net_yen,
  ROUND(SUM(total_return_yen) / NULLIF(SUM(total_stake_yen), 0) * 100, 2) AS recovery_rate_pct
FROM prediction_performance_daily
WHERE algorithm_version = :algorithm_version
  AND settled_date >= :start_date
  AND settled_date < :end_date
GROUP BY algorithm_version, ticket_type;
```


## 過去予想履歴・確定結果・リアルタイム表示

トップページでは、予想の状態を画面側で推測せず、`sql_prediction_runs`、`sql_prediction_tickets`、`prediction_performance_daily` から返す**表示状態**を使ってください。

| 表示区分 | `display_state` | 表示ラベル | 表示する値 |
| --- | --- | --- | --- |
| これからの予想 | `prediction_ready` | 発走前・予想確定 | 予想生成時刻、発走予定、推奨点数。結果・回収率は表示しません。 |
| 結果待ち | `result_pending` | 結果待ち・払戻未確定 | 払戻確定待ちであることだけを明示し、不的中とは表示しません。 |
| 過去予想履歴 | `hit_settled` / `miss_settled` / `no_bet_settled` | 的中・結果確定／不的中・結果確定／見送り・結果確定 | 精算済みの投資額、払戻額、収支、回収率、精算完了時刻。 |

| ファイル | 内容 |
| --- | --- |
| `top_page_history_status_queries.sql` | 上記3区分、更新時刻、予測順位・買い目明細を新テーブルから取得するSQLです。 |
| `top_page_history_api.sample.ts` | `GET /api/top-page/prediction-history-board` を提供し、表示状態・案内文・60秒更新間隔を返すAPIサンプルです。 |
| `PredictionHistoryBoard.sample.tsx` | 3区分を別テーブルとして描画し、データの最終更新時刻を明示するReactコンポーネントです。 |

React側は `refreshAfterSeconds` に従って再取得します。予測・精算・日次集計の最終更新時刻を常に表示するため、ユーザーは情報の新しさと「結果待ち」の状態を確認できます。
