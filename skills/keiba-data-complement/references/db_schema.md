# horse_race_history テーブル スキーマ

枠番補完スクリプトが前提とするDBスキーマ。

## 必須カラム

| カラム名 | 型 | 説明 |
|---------|------|------|
| raceId | VARCHAR | レースID（netkeiba形式: 年4桁+場所2桁+回次2桁+日2桁+R番号2桁） |
| horseName | VARCHAR | 馬名（netkeibaと完全一致が必要） |
| organizer | VARCHAR | 主催者（'JRA' or 'NAR'） |
| venue | VARCHAR | 競馬場名（例: '福島', '盛岡'） |
| bracketNumber | INT | 枠番（1-8、未設定時は0またはNULL） |
| horseNumber | INT | 馬番（1-18程度） |
| finishPosition | INT | 着順（1着=1、未確定=0/NULL） |
| popularity | INT | 人気順位（1=1番人気） |
| distance | INT | 距離（メートル） |
| surface | VARCHAR | 馬場（'turf' or 'dirt'） |
| raceDate | DATE/VARCHAR | レース日 |

## レースID形式

- JRA: `2026` + `03`(場所) + `02`(回次) + `08`(日) + `07`(R番号) = `202603020807`
- NAR: `2026` + `44`(場所) + `06`(回次) + `04`(日) + `07`(R番号) = `202644060407`

## netkeiba URL形式

- JRA: `https://db.netkeiba.com/race/{raceId}/`（EUC-JPエンコーディング）
- NAR: `https://nar.netkeiba.com/race/result.html?race_id={raceId}`（UTF-8）

## レース結果テーブルのHTML構造

```
<tr>
  <td>着順</td>     ← td[0] ★着順であり枠番ではない！
  <td>枠番</td>     ← td[1] ★これが枠番
  <td>馬番</td>     ← td[2]
  <td>馬名リンク</td> ← td[3] (<a href="/horse/...">馬名</a>)
  ...
</tr>
```

## 既知の注意点

1. **td[0]は着順** — 枠番と混同しやすいが、最初のカラムは着順。枠番はtd[1]。
2. **JRAはEUC-JP** — TextDecoder('euc-jp')でデコードが必要。
3. **NARはUTF-8** — そのまま読める。
4. **レート制限** — 1.2秒以上のインターバルを推奨。短すぎると403/429が返る。
5. **馬名マッチング** — DBの馬名とnetkeibaの馬名が完全一致する必要がある。
