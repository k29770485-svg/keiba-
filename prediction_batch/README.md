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
