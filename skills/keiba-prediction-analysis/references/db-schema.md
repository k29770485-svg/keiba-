# 予想分析に必要なDBテーブル構造

## race_results（レース結果）

| カラム | 型 | 説明 |
|--------|-----|------|
| id | INT | PK |
| analysisId | INT | → race_analysis_results.id |
| raceDate | VARCHAR | YYYY-MM-DD |
| raceName | VARCHAR | レース名 |
| venue | VARCHAR | 開催場 |
| isHit | TINYINT | 的中=1, 不的中=0 |
| hitTickets | TEXT | 的中券種JSON |
| actual1st | VARCHAR | 実際の1着馬名 |
| actual2nd | VARCHAR | 実際の2着馬名 |
| actual3rd | VARCHAR | 実際の3着馬名 |
| trifectaPayout | INT | 3連単配当（円） |
| trioBoxPayout | INT | 3連複配当（円） |
| winPayout | INT | 単勝配当（円） |
| placePayout | TEXT | 複勝配当JSON |

## race_analysis_results（AI予想結果）

| カラム | 型 | 説明 |
|--------|-----|------|
| id | INT | PK |
| raceName | VARCHAR | レース名 |
| venue | VARCHAR | 開催場 |
| surface | VARCHAR | 芝/ダート |
| distance | INT | 距離(m) |
| weather | VARCHAR | 天候 |
| trackCondition | VARCHAR | 馬場状態(良/稍重/重/不良) |
| raceDate | VARCHAR | YYYY-MM-DD |
| netkeibaRaceId | VARCHAR | netkeiba レースID |
| analysisJson | TEXT | スコア詳細JSON配列 |
| bettingJson | TEXT | 買い目JSON |
| predicted1st | VARCHAR | 予想1着馬名 |
| predicted2nd | VARCHAR | 予想2着馬名 |
| predicted3rd | VARCHAR | 予想3着馬名 |

## analysisJson の構造

```json
[
  {
    "name": "馬名",
    "odds": 3.2,
    "totalScore": 51.4,
    "baseScore": 51.4,
    "courseBonus": 0,
    "historyBonus": 0,
    "aptitudeBonus": 0
  }
]
```

## JOIN関係

```
race_results.analysisId → race_analysis_results.id
```

race_predictionsテーブルは別系統（旧形式）。分析時は必ず `race_analysis_results` とJOINすること。
