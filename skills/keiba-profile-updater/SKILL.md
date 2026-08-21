---
name: keiba-profile-updater
description: 競馬アプリの全馬・全騎手プロフィールデータを一括更新するスキル。horse_race_historyテーブルから統計を計算し、horses/jockeysテーブルを最新化する。Use when asked to update horse profiles, jockey stats, run the weekly profile update, sync horse/jockey data from race history, or perform the initial base data setup for the keiba app.
---

# Keiba Profile Updater

horse_race_historyテーブルのレース履歴から馬・騎手の統計を計算し、horses/jockeysテーブルを一括更新する。

## When to Use

- 「全馬の更新」「全騎手の更新」を依頼されたとき
- 金曜定期更新の前倒し実行を依頼されたとき
- 初期ベースデータの一括登録を依頼されたとき
- horse_race_historyに大量データ投入後の統計再計算

## Workflow

1. **スケジュール確認・制御** — 定期ジョブとの重複を防止
2. **dry-run で対象件数を確認** — 書き込まずに影響範囲を把握
3. **スクリプト実行** — 一括更新スクリプトを実行
4. **結果検証** — 報告値と実データの両方を確認
5. **スケジュール復帰判断** — 必要に応じて定期ジョブを再開

## Step 1: スケジュール確認・制御

定期更新ジョブ（`update-profiles-weekly`）が有効な場合、二重実行を防ぐため一時停止する:

```bash
# ジョブ一覧確認
manus-heartbeat list 2>&1 | grep -A5 "update-profiles"

# 一時停止（task_uidは実際の値に置換）
manus-heartbeat pause --task-uid <TASK_UID>
```

ジョブが既に停止中なら、このステップはスキップ。

## Step 2: dry-run で対象件数を確認

実行前に、書き込まずに対象件数と拒否件数を確認する:

```bash
cd <project-dir> && node /home/ubuntu/skills/keiba-profile-updater/scripts/update_profiles.mjs --dry-run
```

`rejected.ambiguousName` が 0 でない場合、同名レコードが存在する。これらは書き込まれずスキップされるため、対象馬・騎手のプロフィールは更新されない。件数が多い場合は先に名寄せを検討する。

## Step 3: スクリプト実行

**プロジェクトディレクトリ（`package.json` がある場所）で実行する。** スクリプトは `createRequire` で cwd 基準に `mysql2` を解決するため、プロジェクト外から実行すると起動しない。

```bash
# 事前確認（ディレクトリと依存の存在チェック）
ls <project-dir>/package.json && ls -d <project-dir>/node_modules/mysql2

# 実行
cd <project-dir> && node /home/ubuntu/skills/keiba-profile-updater/scripts/update_profiles.mjs
```

`<project-dir>` は実在するパスに置き換える。プロジェクトの場所が不明な場合は先に探す:

```bash
ls -d /home/ubuntu/*/package.json 2>/dev/null | head
```

**所要時間の目安:** 16,000件のレース履歴で約44分（11,500頭の馬 + 450名の騎手）。この値は未実測の見積りであり、実際の所要時間は環境により変動する。

**注意事項:**
- `DATABASE_URL` 環境変数が必要（プロジェクトディレクトリ内で実行すれば自動設定）
- DB接続タイムアウト対策として5,000件ずつページネーション取得
- UPDATE/INSERTは100件バッチで実行
- 処理が長いため `timeout` を十分に設定（600秒以上推奨、waitで複数回待機が必要）
- **exit code が 0 以外なら失敗が発生している。** `failures` と `rejected` の内容を必ず確認する

## Step 4: 結果検証

報告される JSON サマリと、実際のDB状態の両方を確認する。**報告値だけで完了と判断しない。**

### 4-1. 報告値の確認

サマリの以下のフィールドを読む:

| フィールド | 確認すること |
|---|---|
| `success` | false なら失敗あり。`failureDetail` で原因を読む |
| `horses.rowsChanged` | UPDATE が実際に変更した行数。`updateTargets` と乖離していないか |
| `horses.insertedRows` | INSERT が実際に書き込んだ行数。`insertTargets` と乖離していないか |
| `rejected.ambiguousName` | 同名で書き込みを拒否した件数。0 でなければ名寄せが必要 |
| `rejected.insertFailed` | 個別に失敗した行。原因文から不正データを特定する |

### 4-2. DB状態の確認

```bash
cd <project-dir> && node -e "
const mysql = require('mysql2/promise');
(async () => {
  const conn = await mysql.createConnection(process.env.DATABASE_URL);
  const [[a]] = await conn.query('SELECT COUNT(*) AS n FROM horses WHERE totalRuns > 0');
  const [[b]] = await conn.query('SELECT COUNT(*) AS n FROM jockeys WHERE overallWinRate > 0');
  // 適性スコアが定義範囲(0-100)を外れていないか
  const [[c]] = await conn.query(\`SELECT COUNT(*) AS n FROM horses WHERE
    heavyTrackScore NOT BETWEEN 0 AND 100 OR smallTrackScore NOT BETWEEN 0 AND 100
    OR straightScore NOT BETWEEN 0 AND 100\`);
  // 履歴にあるのに horses に無い馬（取りこぼし）
  const [[d]] = await conn.query(\`SELECT COUNT(DISTINCT h.horseName) AS n FROM horse_race_history h
    LEFT JOIN horses o ON o.name = h.horseName WHERE o.id IS NULL\`);
  // 同名重複行
  const [[e]] = await conn.query(\`SELECT IFNULL(SUM(c-1),0) AS n FROM
    (SELECT COUNT(*) c FROM horses GROUP BY TRIM(name) HAVING c > 1) x\`);
  console.log('統計が入った馬:', a.n, '/ 騎手:', b.n);
  console.log('適性スコアが範囲外の行:', c.n, '（0 であるべき）');
  console.log('履歴にあるが horses に無い馬:', d.n, '（0 であるべき）');
  console.log('同名重複行:', e.n, '（0 であるべき）');
  await conn.end();
})();
"
```

**適性スコアが範囲外の行**は必ず 0 でなければならない。0 でなければ計算式が壊れているため `references/schema.md` の計算式節を確認する。

**履歴にあるが horses に無い馬**と**同名重複行**は、`rejected` の報告件数と照らして解釈する。`rejected.insertFailed` や `rejected.ambiguousName` に計上されている分は、スクリプトが意図的に書き込みを拒否した結果であり不整合ではない。報告されていない残差がある場合のみ調査対象になる。

```
（例）検証コマンドの出力
  履歴にあるが horses に無い馬: 1  ← rejected.insertFailed = 1 と一致すれば説明済み
  同名重複行: 1                    ← rejected.ambiguousName = 1 と一致すれば説明済み
```

### 4-3. 値を目視する

集計値だけでなく、更新されたレコードを数件そのまま読む。もっともらしい数値が入っていても、対象が取り違えられている場合がある。

```bash
cd <project-dir> && node -e "
const mysql = require('mysql2/promise');
(async () => {
  const conn = await mysql.createConnection(process.env.DATABASE_URL);
  const [rows] = await conn.query('SELECT id,name,totalWins,totalRuns,turfWinRate,dirtWinRate,heavyTrackScore,straightScore,affiliation,runningStyle FROM horses ORDER BY totalRuns DESC LIMIT 10');
  console.table(rows);
  await conn.end();
})();
"
```

## Step 5: スケジュール復帰判断

ユーザーに確認し、定期ジョブを再開する場合:

```bash
manus-heartbeat resume --task-uid <TASK_UID>
```

再開しない場合はそのまま停止状態を維持。

## 更新される統計項目

**馬（horsesテーブル）:**

| 項目 | 説明 |
|------|------|
| totalWins / totalRuns | 通算勝利数・出走数 |
| turfWinRate / dirtWinRate | 芝・ダート勝率 |
| heavyTrackScore | 重馬場適性スコア(0-100) |
| smallTrackScore | 小回り適性スコア(0-100) |
| straightScore | 直線適性スコア(0-100) |
| distanceAptitude | 距離適性(sprint/mile/middle/long)。複勝率で判定 |
| runningStyle | 脚質(escape/leading/stalking/closing) |
| affiliation | 所属(JRA/NAR)。履歴のorganizerから算出 |

**騎手（jockeysテーブル）:**

| 項目 | 説明 |
|------|------|
| totalWins | 通算勝利数 |
| overallWinRate | 総合勝率 |
| turfWinRate / dirtWinRate | 芝・ダート勝率 |
| heavyTrackWinRate | 重馬場勝率 |
| affiliation | 所属(JRA/NAR)。履歴のorganizerから算出 |

出走数が3走未満の騎手は登録・更新の対象外。

## 既知の制約

**同名レコードは更新されない。** `horses` / `jockeys` に同名が複数行ある場合、どの実体か判別できないためスキップし、`rejected.ambiguousName` に記録する。恒久的な解決には `horse_race_history` 側への馬ID導入、または `name` への UNIQUE 制約が必要である。関連する設計は `keiba-horse-db-pipeline` スキルを参照する。

**INSERT が失敗した行は登録されない。** 馬名欄にパース失敗文字列が混入している等、カラム制約に違反する行は個別に隔離され `rejected.insertFailed` に記録される。バッチ全体は破棄されないため、同一バッチの正常な行は登録される。原因はデータソース側にあるため、スクレイピング側の修正が必要である。

## Technical Details

スキーマ詳細・計算式・照合キーの注意点は `references/schema.md` を参照。計算式を変更する場合は、変更後に必ず `--dry-run` と Step 4 の検証を通す。

**コスト節約のポイント:**
- 定期ジョブとの重複実行を必ず防止する
- 差分更新が可能な場合は全件更新を避ける（レース結果確定時に該当馬のみ更新）
- 実行前に必ずスケジュール状態を確認する
- 大規模実行の前に `--dry-run` で対象件数を確認する
