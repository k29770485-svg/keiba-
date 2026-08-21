# 2モード予想アーキテクチャ設計

> **注意:** これは予想表示・買い目生成のプロダクト設計であり、利益や回収率を保証しない。実運用では、ユーザーに「厳格モード」と「エンタメモード」の目的、購入有無、確定前後の成績を明確に区別して表示する。

## 1. モードの契約を分離する

| 項目 | `value_guard` — 穴馬買い目 | `score_story` — スコア順買い目 |
| --- | --- | --- |
| 目的 | 控除率・確率誤差・小標本を差し引いても優位性がある場合だけに絞る | スコアの順位と根拠を楽しく理解させ、週末の主要レースで会話を生む |
| 買い目の頻度 | 原則ゼロ。厳格な条件を満たす時だけ最大1点 | 高い。データが有効なレースでは常に「注目フォーメーション」を作る |
| 評価指標 | 控除率後の保守的期待値、確定済み回収率、校正誤差、見送り率 | 表示率、詳細閲覧率、保存・共有率、根拠カードの閲覧率。回収率と混ぜない |
| 確率の扱い | 同一モデル版の時系列ウォークフォワードで校正した組合せ確率だけを使う | 馬単位の相対スコアを順位・物語の根拠に使う。確率や利益の保証として表示しない |
| UIラベル | **「厳格EV・見送り優先」** | **「AIスコアの注目フォーメーション」** |
| 成績表示 | 精算済み券だけで算出した券種別・モード別成績 | 的中／不的中の結果は表示可。ただし`value_guard`と合算した回収率を表示しない |

`score_story`を収支モードの緩い版にしないことが重要である。目的・評価・表示・日次集計を別にすることで、「出る頻度」と「控除率後に厳格な期待値を要求すること」の衝突を防ぐ。

## 2. Pythonの変更案

### 2.1 モード値と設定を追加する

`config.py` に、既存の `value_*` を `value_guard_*` として残し、以下を追加する。

```python
score_story_enabled: bool = True
score_story_max_tickets_per_race: int = 2
score_story_featured_race_required: bool = False
score_story_min_runners: int = 4
score_story_algorithm_version: str = "score-story-v1"
```

`value_guard` の既存値は変更しない。`VALUE_MIN_CALIBRATION_SAMPLE_SIZE=250`、95%下方信頼限界、控除率後期待値35%以上、市場歪み50%以上、最大1点を維持する。直近2週間だけのデータでは、校正件数不足により意図的に見送りとなる。

### 2.2 買い目生成を2関数へ分割する

現在の `generate_value_tickets()` は `generate_value_guard_tickets()` に改名し、`TicketMarketQuote`、校正件数、モデル版、特徴量欠損、控除率後の下方期待値を必須にする。

```python
def generate_value_guard_tickets(
    scored: list[ScoredRunner],
    quotes: list[TicketMarketQuote],
    policy: ValueGuardPolicy,
) -> Decision:
    # 既存の下方信頼限界・控除率後期待値ロジックを使用する。
    # 条件不足は必ず tickets=[] と決定理由コードを返す。
    ...
```

戻り値をリストだけでなく決定理由付きにする。

```python
@dataclass(frozen=True)
class Decision:
    mode: Literal["value_guard", "score_story"]
    tickets: list[GeneratedTicket]
    status: Literal["bet", "no_bet", "preview"]
    reason_codes: list[str]
    evaluated_candidate_count: int
```

`reason_codes` は少なくとも `missing_market_quote`、`insufficient_calibration`、`model_version_mismatch`、`feature_missing`、`lcb_edge_below_threshold`、`conservative_ev_below_threshold`、`ticket_limit_reached` を持つ。これにより「買い目ゼロ」を失敗・不具合ではなく、明示的な品質判断として表示できる。

`score_story` は市場期待値を使わず、上位スコアを必ず説明付きで返す。ただし発走前スナップショットが無い、4頭未満、必須特徴量の欠損が多い場合は、買い目を捏造せず `preview` とする。

```python
def generate_score_story_tickets(scored: list[ScoredRunner], *, is_featured: bool) -> Decision:
    eligible = [s for s in scored if len(s.breakdown.missing_fields) <= 1]
    if len(eligible) < 3:
        return Decision("score_story", [], "preview", ["insufficient_race_data"], len(eligible))

    first, second, third = eligible[:3]
    tickets = [
        GeneratedTicket("wide", (first.horse_number, second.horse_number), 100),
        GeneratedTicket("trio", tuple(sorted((first.horse_number, second.horse_number, third.horse_number))), 100),
    ]
    return Decision("score_story", tickets[:2], "preview", [], len(eligible))
```

主要レースで「何かを表示する」要件は、`is_featured` を取込元が明示的に持つ場合に限る。レース名の文字列推測でG1等を判定しない。市場・出走表が未取得なら、買い目ではなく「データ確定待ち」と表示する。

### 2.3 根拠を構造化して返す

`ScoreBreakdown` の正負寄与を上位2件ずつ抽出し、自然言語を生成する前の構造化データとして保存する。

```python
@dataclass(frozen=True)
class ScoreNarrative:
    headline: str
    positive_factors: list[dict[str, float | str]]
    caution_factors: list[dict[str, float | str]]
    data_quality: Literal["high", "medium", "low"]
```

例として、`bloodline_score`、`jockey_bonus`、`gate_score`、`track_condition_score`、`weight_score`、`age_score`を比較し、「芝1200mの血統適性」「内枠補正」「重馬場での注意」のような根拠キーを返す。LLMの自由文をスコア計算へ戻さず、説明だけに使う。

## 3. SQLの変更案

### 3.1 予想実行をモード単位にする

既存の `sql_prediction_runs` は `(race_id, algorithm_version)` が一意であり、両モードを保存できない。`prediction_mode` を追加し、一意キーを `(race_id, algorithm_version, prediction_mode)` に置換する。

```sql
ALTER TABLE sql_prediction_runs
  ADD COLUMN prediction_mode ENUM('value_guard', 'score_story') NOT NULL DEFAULT 'value_guard' AFTER algorithm_version,
  ADD COLUMN decision_status ENUM('bet', 'no_bet', 'preview') NOT NULL DEFAULT 'no_bet' AFTER status,
  ADD COLUMN decision_reasons_json JSON NOT NULL AFTER snapshot_json,
  DROP INDEX uq_sql_prediction_runs_race_algorithm,
  ADD UNIQUE KEY uq_sql_prediction_runs_race_algorithm_mode (
    race_id, algorithm_version, prediction_mode
  ),
  ADD INDEX idx_spr_mode_status_race (prediction_mode, status, race_id);
```

既存レコードは `value_guard` として移行するが、過去のレコードを新方式の期待値成績に混ぜない。新しい `sql-v3-ev-strict` 以降を別フィルターで表示する。

### 3.2 チケットと集計をモード別にする

`sql_prediction_tickets` は `prediction_id` を通じてモードを得られるため、列追加は不要である。日次集計にはモードを追加し、厳格モードとエンタメモードの投資・払戻・収支を絶対に合算しない。

```sql
ALTER TABLE prediction_performance_daily
  ADD COLUMN prediction_mode ENUM('value_guard', 'score_story') NOT NULL DEFAULT 'value_guard' AFTER algorithm_version;

ALTER TABLE prediction_performance_daily
  DROP PRIMARY KEY,
  ADD PRIMARY KEY (settled_date, algorithm_version, prediction_mode, ticket_type),
  ADD KEY idx_ppd_mode_date (prediction_mode, settled_date, ticket_type);
```

日次再構築の `GROUP BY` と `INSERT` に `spr.prediction_mode` を加える。`score_story` に実際の投資額を表示しないプロダクト方針を採る場合は、同モードのチケットを `display_only` として別テーブルへ保存し、回収率集計から除外する選択肢もある。

### 3.3 根拠カードを保存する

```sql
CREATE TABLE IF NOT EXISTS sql_prediction_narratives (
  narrative_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  prediction_id BIGINT UNSIGNED NOT NULL,
  horse_number SMALLINT UNSIGNED NOT NULL,
  mode ENUM('value_guard', 'score_story') NOT NULL,
  headline VARCHAR(180) NOT NULL,
  positive_factors_json JSON NOT NULL,
  caution_factors_json JSON NOT NULL,
  data_quality ENUM('high', 'medium', 'low') NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_spn_prediction_horse_mode (prediction_id, horse_number, mode),
  CONSTRAINT fk_spn_prediction FOREIGN KEY (prediction_id)
    REFERENCES sql_prediction_runs (prediction_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

## 4. API・画面の変更案

APIのクエリには必ず `predictionMode` を入れる。既存の `algorithmVersion` だけで混在させない。

```ts
GET /api/top-page/prediction-summary?predictionMode=value_guard
GET /api/top-page/prediction-summary?predictionMode=score_story
```

| 画面要素 | `value_guard` | `score_story` |
| --- | --- | --- |
| ヒーロー表示 | 「本日は厳格条件を満たす買い目なし」が正常状態 | 上位3頭、注目ワイド、注目3連複、根拠カード |
| バッジ | `厳格EV判定済み`、`見送り`、`校正不足` | `AI本命`、`展開の鍵`、`血統の鍵`、`データ注意` |
| 成績 | モード単独の精算済み回収率・標本数・見送り率 | 予測の閲覧・保存・共有と、的中結果を別カードで表示 |
| 文言 | 「予測上の優位性が不足しているため見送り」 | 「エンタメ向けの注目フォーメーション。利益を保証しません」 |

説明カードは、スコアそのものだけではなく「寄与した特徴量」「不確実性」「データ取得時刻」を表示する。根拠が不足する馬には派手な断言を出さず、`data_quality=low` の注意を優先する。

## 5. 検証と導入順序

1. `value_guard` を既存の厳格ロジックとして固定し、`no_bet` の理由コードを追加する。
2. `score_story` を表示専用かつ別モードで保存する。既存収支ダッシュボードに接続しない。
3. 4週間以上の新規・発走前スナップショットを蓄積し、`value_guard` はウォークフォワード校正件数を満たすまで投資額0円を維持する。
4. モード別に、予測数、見送り率、精算済み回収率、標本数、データ欠損率を監視する。`score_story` は表示率・保存率・根拠カード閲覧率も計測する。
5. 実データでモードの混在が無いこと、`prediction_mode` を含む日次集計が原票と一致すること、表示上の「見送り」「データ確定待ち」「結果待ち」を混同しないことをテストする。

## 6. 実装上の優先順位

| 優先度 | 変更 | 理由 |
| --- | --- | --- |
| P0 | `prediction_mode`、`decision_status`、`decision_reasons_json` | モード混在と「見送り理由不明」を解消する基礎。 |
| P0 | 日次集計のモード分離 | 回収率を混ぜて誤認させないため。 |
| P1 | `generate_score_story_tickets()` と根拠構造体 | 表示頻度と納得感を独立させるため。 |
| P1 | モード別API・UIタブ | ユーザーが目的を理解して選べるようにするため。 |
| P2 | 特集レースフラグの正規化と閲覧イベント集計 | 主要レースの露出とプロダクト改善を測るため。 |

## 参考

JRAの設定払戻率は、ワイド77.5%、3連複75.0%、3連単72.5%である。[1]

[1] [JRA「馬券のルール」— 勝馬投票法ごとの設定払戻率](https://www.jra.go.jp/kouza/baken/index.html)
