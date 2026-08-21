---
name: keiba-prediction-analysis
description: "競馬予想の的中率低下・外れ原因を分析するワークフロー。予想が外れた原因の調査、的中率の時系列推移、アルゴリズム診断（スコア構成比分析）、荒れ判定、改善提案までを一貫して実行する。Use for: 予想が外れた理由の調査、的中率分析、予想アルゴリズムの診断、予想精度の改善提案。"
---

# 競馬予想外れ原因分析

## ワークフロー

### Step 1: データ取得

`race_results`と`race_analysis_results`をJOINして予想と結果を突合する。

```sql
SELECT rr.*, rar.predicted1st, rar.predicted2nd, rar.predicted3rd,
       rar.analysisJson, rar.weather, rar.trackCondition, rar.surface, rar.distance
FROM race_results rr
JOIN race_analysis_results rar ON rr.analysisId = rar.id
WHERE rr.raceDate BETWEEN '<start>' AND '<end>'
```

> **注意**: `race_predictions`テーブルは旧形式。必ず`race_analysis_results`とJOINすること。DB構造の詳細は `references/db-schema.md` を参照。

### Step 2: 多軸分析

以下の軸で分析する（詳細は `references/analysis-dimensions.md`）:

1. **日別的中率推移** — 急落タイミングの特定
2. **overlap分析** — 予想3頭中何頭が3着以内に入ったか
3. **会場別・馬場別** — 弱点の特定
4. **3連単配当分析** — 荒れ度合いの定量化（万馬券率）
5. **アルゴリズム診断** — `analysisJson`のスコア構成比（baseScore/courseBonus/historyBonus/aptitudeBonus）

### Step 3: 根本原因の特定

典型的な外れパターン:

| パターン | 症状 | 原因 |
|----------|------|------|
| オッズ依存 | baseScore比率>80%, bonus全て0 | 人気馬しか選べない |
| 大荒れ日 | 万馬券率>50%, 予想◎3着以内率<20% | 構造的に対応不可 |
| 会場偏り | 特定会場のみ的中率低い | コース適性未反映 |
| 馬場苦手 | 重/稍重で的中率急落 | 馬場適性未反映 |

### Step 4: レポート出力

Markdownレポートに以下を含める:
- エグゼクティブサマリー（3行以内）
- 的中率推移テーブル
- 多軸分析結果
- 根本原因（優先度付き）
- 改善提案（実装可能な具体策）

### Step 5: 分析スクリプト（オプション）

`scripts/analyze_predictions.mjs` を使用すると、上記分析を自動実行可能:

```bash
cd <project-dir> && node <skill-path>/scripts/analyze_predictions.mjs --date 2026-08-02 --range 2
```

プロジェクトの`node_modules/mysql2`を使用するため、プロジェクトディレクトリで実行すること。

## 注意事項

- 配当データの単位（円 or 100円単位）を必ず確認する
- `isHit`フラグの判定ロジックは券種によって異なる（3連単的中 vs ワイド的中）
- 直近1週間の推移と比較して初めて「急落」と判断できる
- 平日開催（12レース）と週末開催（36レース）は母数が異なるため単純比較不可
