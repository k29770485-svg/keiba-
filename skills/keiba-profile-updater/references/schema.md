# DB Schema Reference

## Required Tables

### horse_race_history (データソース)

| Column | Type | Description |
|--------|------|-------------|
| id | int | 主キー。ページネーションの `ORDER BY` に使う |
| horseName | varchar | 馬名 |
| venue | varchar | 競馬場名（札幌、東京、門別等） |
| distance | int | 距離(m) |
| surface | varchar | 芝/ダート/ダ |
| trackCondition | varchar | 馬場状態（良/稍重/重/不良） |
| finishPosition | int | 着順。競走中止は NULL |
| horseCount | int | 出走頭数 |
| last3f | varchar | 上がり3F（秒） |
| jockey | varchar | 騎手名 |
| organizer | varchar | 主催（JRA/NAR） |

### horses (更新対象)

| Column | Type | Description |
|--------|------|-------------|
| id | int | 主キー。**UPDATE の照合はこの列で行う** |
| name | varchar | 馬名。UNIQUE 制約が無い環境では同名が併存し得る |
| totalWins | int | 通算勝利数 |
| totalRuns | int | 通算出走数 |
| turfWinRate | decimal | 芝勝率 |
| dirtWinRate | decimal | ダート勝率 |
| heavyTrackScore | int | 重馬場適性スコア(0-100) |
| smallTrackScore | int | 小回り適性スコア(0-100) |
| straightScore | int | 直線適性スコア(0-100) |
| affiliation | enum | 所属（JRA/NAR） |
| distanceAptitude | enum | 距離適性（sprint/mile/middle/long） |
| runningStyle | enum | 脚質（escape/leading/stalking/closing） |

### jockeys (更新対象)

| Column | Type | Description |
|--------|------|-------------|
| id | int | 主キー。**UPDATE の照合はこの列で行う** |
| name | varchar | 騎手名 |
| affiliation | enum | 所属（JRA/NAR）。履歴の organizer から算出する |
| totalWins | int | 通算勝利数 |
| overallWinRate | decimal | 総合勝率 |
| turfWinRate | decimal | 芝勝率 |
| dirtWinRate | decimal | ダート勝率 |
| heavyTrackWinRate | decimal | 重馬場勝率 |

## 適性スコア計算式

```
winRate  = wins / races        # 0-1 の比率
top3Rate = top3 / races        # 0-1 の比率

score      = winRate * 60 + top3Rate * 40   # この時点で既に 0-100 スケール
confidence = min(races / 5, 1)
finalScore = clamp(round(50 + (score - 50) * confidence), 0, 100)
```

スコア50がデフォルト（データ不足時、`races = 0`）。レース数が増えるほど confidence が上がり、実績が反映される。

**`score` に `* 100` を掛けてはいけない。** `winRate` と `top3Rate` は既に 0-1 の比率であり、`winRate * 60 + top3Rate * 40` の時点で 0-100 スケールになっている。ここに `* 100` を掛けると 100 倍が二重に適用され、実測で最大 4030 の値が書き込まれた。races 0-12 の全 455 組合せのうち 442 通り（97.1%）が定義範囲 0-100 を外れる。カラム型は INT なので制約違反にならず、エラーも出ない。

最終的に `clamp(..., 0, 100)` を必ず適用する。計算式の変更時はこのクランプを外さない。

## 照合キーの扱い

`horses.name` / `jockeys.name` を UPDATE の `WHERE` 句に使ってはいけない。主キー `id` で照合する。理由は次の2点である。

第一に、`name` に UNIQUE 制約が無い環境では同名レコードが併存し得る。この場合 `UPDATE ... WHERE name = ?` が複数行に当たり、どの実体にも対応しない混合値で全行が塗り潰される。実測では同名2行（JRA所属とNAR所属）の両方が同一値で上書きされ、報告上は「1頭更新」と計上された。

第二に、MySQL の VARCHAR 比較は末尾空白を無視するが、JavaScript の文字列比較は無視しない。`'馬名'` と `'馬名 '` は SQL では等しく、JS の `Set.has()` では等しくない。この非対称性により、末尾空白付きレコードが「新規馬」と誤判定されて重複行が作られる。照合キーは JS 側で必ず `trim()` して揃える。

同名が複数行ある名前は、書き込まずに `ambiguousName` として隔離・報告する。誤った混合値を書くより、埋めずに報告するほうが被害が小さい。恒久的な解決には `horse_race_history` 側への馬ID（netkeibaId 等）の導入、または `name` への UNIQUE 制約の付与が必要である。

## surface の分類

芝・ダートの判定は馬側・騎手側で同一の基準を使う。「芝でなければダート」と分類してはいけない。`surface` が NULL・空文字・障害競走のレコードがダート出走に混入し、ダート未出走の対象に「ダート勝率 0.000」という誤った数値が記録される。値が NULL ではなく数値になるため、充填率チェックでは検出できない。

| 分類 | 該当する値 | 扱い |
|------|-----------|------|
| turf | 芝, turf | 芝勝率の分母 |
| dirt | ダート, dirt, ダ | ダート勝率の分母 |
| unknown | 上記以外（NULL, 空文字, 障 等） | どちらの分母にも入れない |

## 距離区分

| 区分 | 距離範囲 |
|------|----------|
| sprint | ～1400m |
| mile | 1401～1800m |
| middle | 1801～2200m |
| long | 2201m～ |

`distanceAptitude` は各区分の**複勝率（3着以内）**が最も高い区分を選ぶ。勝率ではない。2走以上ある区分のみを候補とする。

## 脚質判定（上がり3F平均）

| 脚質 | 上がり3F平均 |
|------|-------------|
| closing | ～34.5秒 |
| stalking | 34.6～35.5秒 |
| leading | 35.6～36.5秒 |
| escape | 36.6秒～ |

有効な上がり3Fデータが3件以上ある場合のみ判定する。3件未満は NULL のままにする。

## ページネーションの注意

`LIMIT ? OFFSET ?` には必ず `ORDER BY id` を付ける。順序が保証されないページングは、ページ境界でレコードの重複取得や取りこぼしを起こす。出走数や勝利数が静かにずれるため、発見が難しい。
