---
name: keiba-data-complement
description: "競馬レース履歴データの枠番・馬番補完ワークフロー。netkeibaスクレイピングによるhorse_race_historyテーブルの枠番データ一括取得、充填率確認、枠順有利不利テストまでの一連のプロセス。Use for - 枠番データが未入力のレース履歴を補完する、枠順バイアスを分析する、穴狙いアルゴリズムの精度を検証する。"
---

# 競馬データ補完スキル

netkeibaからレース結果をスクレイピングし、DBの`horse_race_history`テーブルに枠番・馬番を補完するワークフロー。

## ワークフロー概要

```
1. 充填率確認 → 2. 補完実行（バッチ） → 3. 検証 → 4. 枠順テスト
```

## Step 1: 充填率確認

```bash
cd <project-dir> && node scripts/check_fill_rate.mjs
```

会場別の充填率と残りレース数・推定所要時間を表示。

## Step 2: 枠番補完実行

```bash
cd <project-dir> && nohup node scripts/complement_bracket.mjs > /tmp/bracket_log.txt 2>&1 &
tail -f /tmp/bracket_log.txt
```

- 1回の実行で最大500レースを処理（BATCH_SIZE）
- 1レースあたり約1.2秒（DELAY_MS）→ 500レースで約10分
- 全レース完了まで複数回実行が必要な場合あり
- `nohup`で実行し、ログをtailで監視

### 複数バッチの実行パターン

```bash
# 残りレース数を確認
node scripts/check_fill_rate.mjs

# バッチ実行（完了まで繰り返し）
nohup node scripts/complement_bracket.mjs > /tmp/bracket_batch1.log 2>&1 &
# 完了後
nohup node scripts/complement_bracket.mjs > /tmp/bracket_batch2.log 2>&1 &
# ...残り0になるまで
```

## Step 3: 検証

補完完了後、再度充填率を確認:

```bash
node scripts/check_fill_rate.mjs
```

**目標: 全会場99.5%以上**（一部中止レース等で100%にならないのは正常）

### データ正当性の検証

枠番が着順と一致していないことを確認:

```sql
SELECT bracketNumber, finishPosition, horseName
FROM horse_race_history
WHERE raceId = '<任意のraceId>' AND bracketNumber > 0
ORDER BY finishPosition
LIMIT 10;
-- bracketNumberとfinishPositionが全行一致していたらパースバグ
```

## Step 4: 枠順有利不利テスト

```bash
node scripts/test_gate_bias.mjs
```

全会場×主要コースの枠順バイアスを出力。穴狙いアルゴリズムへの入力データとして使用。

## 重要な注意点

1. **td[0]は着順、td[1]が枠番** — netkeiba結果テーブルの最初のカラムは着順。枠番と混同しないこと。
2. **JRAはEUC-JP** — `TextDecoder('euc-jp')`でデコード必須。
3. **レート制限** — DELAY_MSは1200ms以上。短すぎると403/429。
4. **バッチ分割** — 500レース超の場合は自動的に次回実行分として残る。

## リファレンス

- `references/db_schema.md` — テーブルスキーマ、レースID形式、HTML構造の詳細
- `references/troubleshooting.md` — よくある問題と解決策

## スクリプト一覧

| スクリプト | 用途 |
|-----------|------|
| `scripts/complement_bracket.mjs` | 枠番・馬番の一括補完（メインスクリプト） |
| `scripts/check_fill_rate.mjs` | 充填率の確認（実行前後に使用） |
| `scripts/test_gate_bias.mjs` | 枠順有利不利テスト（補完完了後に使用） |

## 前提条件

- Node.js 18+
- `mysql2` パッケージ
- `dotenv` パッケージ
- `DATABASE_URL` 環境変数（MySQL/TiDB接続文字列）
- `horse_race_history` テーブルに`raceId`, `horseName`, `organizer`, `bracketNumber`, `horseNumber`カラムが存在
