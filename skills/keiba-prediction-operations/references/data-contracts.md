# 競馬予想データ契約

## レース識別

予想、結果、オッズ、払戻を結合するため、以下を保存する。

| 項目 | 用途 |
|---|---|
| `raceId` | 内部の一意キー |
| `providerRaceId` | 許諾データ提供元の識別子。内部IDの代替にしない |
| `raceDate` | JST開催日 |
| `venue` | 競馬場 |
| `raceNumber` | レース番号 |
| `raceName` | レース名。二重検証に利用 |
| `startTime` | JST発走時刻。状態判定に利用 |
| `surface` / `distance` / `trackCondition` | スコアリング前に検証する条件 |
| `resultStatus` | `upcoming` / `waiting_result` / `settled` |

## 出走馬・オッズ

| 項目 | 注意点 |
|---|---|
| `horseNumber` | レース内で一意 |
| `horseName`, `jockey`, `gateNumber` | スコア根拠と表示 |
| `odds` | 現在値。数値化できない値は保存しない |
| `capturedAt` | オッズスナップショットの取得時刻 |
| `source` | 公式ファイル/APIなど許諾済みの提供元 |

## 予想・買い目

保存する買い目は、次の構造を最低限含める。

```ts
type TicketMetadata = {
  totalPoints: number;
  unitStake: number; // 例: 100
  totalStake: number;
  tickets: Array<{
    type: "trifecta" | "trio" | "quinella" | "exacta" | "wide";
    expression: string;
    points: number;
    role: "main" | "cover";
  }>;
};
```

過去の文字列だけの買い目から、点数や投資額を推定して分析に混ぜない。

## 収支集計

`settled` 状態の予想だけを集計する。1件ごとに `totalStake`、`returnAmount`、`isHit` を保存する。回収率は `returnAmount / totalStake * 100`、収支は `returnAmount - totalStake` とする。
