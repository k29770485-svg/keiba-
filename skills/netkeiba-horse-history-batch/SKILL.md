---
name: netkeiba-horse-history-batch
description: "netkeiba馬ページから全競走成績・写真URLをバッチ取得し、Heartbeatスケジュールジョブで今週末出走馬のデータを自動補完するワークフロー。Use for: 馬の過去成績の自動取得、netkeibaスクレイピング、競走成績のDB一括保存、週末出走馬の定期データ補完、horse_race_historyテーブルへの自動INSERT。"
---

# netkeiba 競走成績バッチ取得スキル

netkeibaの馬プロフィールページから全競走成績と写真URLをスクレイピングし、Heartbeat定期ジョブで今週末出走馬のデータを自動補完するワークフロー。

## ワークフロー概要

```
1. DBスキーマ準備 → 2. スクレイピング関数実装 → 3. スケジュールハンドラ作成
→ 4. ルート登録 → 5. デプロイ → 6. manus-heartbeat CLIでcron作成
```

---

## Step 1: DBスキーマ準備

`horse_race_history` テーブルに必要な全カラムを定義。詳細は `references/db-schema.md` を参照。

必須カラム: horseName, horseId, raceDate, venue, raceName, raceId, distance, surface, trackCondition, finishPosition, horseCount, finishTime, last3f, odds, popularity, jockey, weight, horseWeight, margin, bracketNumber, horseNumber, cornerPositions, weather, prizeMoney, horseWeightDiff, timeDifference, organizer

`horses` テーブルには `netkeibaId`（VARCHAR(32)）と `imageUrl`（TEXT）が必要。

---

## Step 2: スクレイピング関数

`fetchHorseRaceHistoryFromNetkeiba(netkeibaId: string)` を実装。

パース対象: `https://db.netkeiba.com/horse/{netkeibaId}` の `table.db_h_race_results tbody tr`

カラムマッピングの詳細は `references/netkeiba-scraping.md` を参照。

実装上の注意:
- cheerioでHTMLパース（`import * as cheerio from "cheerio"`）
- User-Agentヘッダー必須
- cells配列アクセスは `string | undefined` 型で安全に処理
- 距離カラムは正規表現 `/([芝ダ障])\D*(\d+)/` でsurfaceとdistanceを分離
- 馬体重は `/(\d+)\(([+-]?\d+)\)/` でweight/diffを分離
- 写真URLは `div.horse_photo img[src]` から取得

---

## Step 3: スケジュールハンドラ

テンプレート: `templates/fetchWeekendHorseHistory.ts`

処理フロー:
1. `race_entries` から今週末（土日）の出走馬名を取得（`inArray(raceDate, targetDates)`）
2. `horses` テーブルとマッチして `netkeibaId` 保有馬を特定
3. `horse_race_history` のレコード数が少ない馬を優先（`count(*)` でソート）
4. 上位MAX_HORSES_PER_RUN頭をnetkeibaから取得してDB保存

安全設計パラメータ:
- `MAX_HORSES_PER_RUN = 20` — 1回あたりの最大処理頭数
- `TIMEOUT_MS = 100_000` — ハンドラタイムアウト（120秒制限に余裕）
- `DELAY_BETWEEN_HORSES_MS = 2500` — netkeibaへの負荷軽減
- 重複チェック: `raceDate + venue + raceName` の組み合わせでスキップ

payloadで日付上書き可能: `{ "dates": ["2026-08-09", "2026-08-10"] }`

---

## Step 4: ルート登録

`server/_core/index.ts` に追加（tRPCミドルウェアの前、Vite/staticフォールスルーの前）:

```ts
import { fetchWeekendHorseHistoryHandler } from "../scheduled/fetchWeekendHorseHistory";
app.post("/api/scheduled/fetchWeekendHorseHistory", fetchWeekendHorseHistoryHandler);
```

`scheduledJobs` テーブルにレコードを追加:

```sql
INSERT INTO scheduled_jobs (name, is_active) VALUES ('fetchWeekendHorseHistory', true);
```

---

## Step 5: デプロイ

`webdev_save_checkpoint` でチェックポイント保存。auto-publishが有効なら自動デプロイ。

---

## Step 6: Heartbeat cronジョブ作成

デプロイ完了後にCLIで作成:

```bash
manus-heartbeat create \
  --name fetchWeekendHorseHistory \
  --cron "0 0 18 * * 4" \
  --path /api/scheduled/fetchWeekendHorseHistory \
  --description "毎週木曜18:00 UTC（金曜03:00 JST）に今週末出走馬の全競走成績を自動補完"
```

返却された `task_uid` を `scheduledJobs` テーブルの `schedule_cron_task_uid` に保存:

```sql
UPDATE scheduled_jobs SET schedule_cron_task_uid = '{task_uid}' WHERE name = 'fetchWeekendHorseHistory';
```

---

## 管理・運用

| 操作 | コマンド |
|------|----------|
| 一覧確認 | `manus-heartbeat list` |
| 一時停止 | `manus-heartbeat update --task-uid {uid} --enable=false` |
| 再開 | `manus-heartbeat update --task-uid {uid} --enable=true` |
| 実行ログ | `manus-heartbeat logs --task-uid {uid}` |
| 手動実行 | 管理画面 Settings → Schedules → Run Now |

---

## トラブルシューティング

- **「出走予定馬なし」**: `race_entries` に今週末のデータが未登録。先にレーススケジュール取得ジョブを実行。
- **「netkeibaId保有馬なし」**: `horses` テーブルの `netkeibaId` が未設定。`fetchDetailsBatch` で馬詳細を先に取得。
- **タイムアウト中断**: 正常動作。次回実行時に残りの馬を処理（レコード数少ない順で優先されるため）。
- **429エラー多発**: `DELAY_BETWEEN_HORSES_MS` を増やす（3000〜5000推奨）。
