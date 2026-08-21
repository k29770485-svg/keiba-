# 履歴ダッシュボード表示契約

APIは予想値、結果待ち、確定実績を別区分で返す。画面がレース状態や収支を推測しないよう、各行に表示状態・ラベル・案内文を含める。

## 状態と表示

| `display_state` | 表示ラベル例 | データ条件 | UIで表示する値 | UIで表示しない値 |
| --- | --- | --- | --- | --- |
| `prediction_ready` | 発走前・予想確定 | 発走前かつ予想保存済み | 発走予定、予想生成時刻、推奨点数、順位、穴馬 | 回収率、確定払戻、確定収支 |
| `result_pending` | 結果待ち・払戻未確定 | レース終了、精算未完了 | 予想生成時刻、保留チケット数、精算待ち案内 | 不的中ラベル、確定収支、回収率 |
| `hit_settled` | 的中・結果確定 | 精算済み、払戻あり | 投資額、払戻額、収支、回収率、精算時刻 | 推定払戻 |
| `miss_settled` | 不的中・結果確定 | 精算済み、払戻なし | 投資額、払戻額0円、収支、回収率、精算時刻 | 結果待ち表示 |
| `no_bet_settled` | 見送り・結果確定 | 買い目なし、結果確定 | 見送り理由、投資額0円、払戻額0円 | 的中・不的中ラベル |

## API必須フィールド

```ts
type RaceBoardItem = {
  raceId: string;
  raceDate: string;
  venueName: string;
  raceNumber: number;
  raceName: string | null;
  scheduledStartAt: string;
  predictionGeneratedAt: string;
  settlementCompletedAt: string | null;
  displayState: DisplayState;
  displayLabel: string;
  displayNote: string;
  recommendedTicketCount: number;
  pendingTicketCount: number;
  totalStakeYen: number;
  totalReturnYen: number;
  totalNetYen: number;
  recoveryRatePct: number;
};
```

API全体には、次の鮮度情報を含める。

```ts
type Freshness = {
  serverTimeUtc: string | null;
  latestPredictionGeneratedAt: string | null;
  latestTicketSettledAt: string | null;
  latestDailyAggregatedAt: string | null;
};
```

## UIの取得状態

| 状態 | 必要な挙動 |
| --- | --- |
| 初回取得中 | スケルトンまたはローディングを表示し、空の実績表を出さない。 |
| 取得成功 | 最新データと鮮度情報を表示し、指定間隔で再取得する。 |
| 再取得中 | 前回成功データを維持し、「更新中」を表示する。 |
| 初回失敗 | エラー詳細と手動再試行を表示する。 |
| 再取得失敗 | 前回成功データを維持し、「前回取得分」を明示して自動・手動再試行を提供する。 |

リクエスト中断には `AbortController` を用いる。再試行時は既存のポーリングタイマーを解除し、重複リクエストを起こさない。
