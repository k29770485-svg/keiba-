# トラブルシューティング

## よくある問題と解決策

### 1. 枠番が着順と同じ値になっている

**症状**: bracketNumber=1の馬が全て1着、bracketNumber=2が全て2着。

**原因**: HTMLテーブルのtd[0]（着順）を枠番として取得している。

**修正**: `tds[1]`を枠番、`tds[2]`を馬番として取得する。

**検証SQL**:
```sql
SELECT bracketNumber, finishPosition, horseName
FROM horse_race_history
WHERE raceId = '<特定のraceId>'
ORDER BY finishPosition;
-- bracketNumberとfinishPositionが全て一致していたらバグ
```

**リカバリ手順**:
```sql
-- 1. 誤データをリセット
UPDATE horse_race_history SET bracketNumber = 0 WHERE bracketNumber > 0;
-- 2. 修正版スクリプトで再実行
```

### 2. スクリプトがタイムアウトする

**症状**: 10秒タイムアウトで失敗が多発。

**対策**:
- ネットワーク状態を確認
- DELAY_MSを2000msに増やす
- タイムアウトを15000msに延長

### 3. 馬名マッチングで更新されない

**症状**: fetchは成功するがaffectedRowsが0。

**原因**: DB内の馬名とnetkeiba上の馬名が異なる（全角/半角、スペース有無）。

**調査SQL**:
```sql
SELECT DISTINCT horseName FROM horse_race_history WHERE raceId = '<raceId>';
```

**対策**: 馬名の前後スペースをtrimして比較。

### 4. NARのレースIDでHTTPエラー

**症状**: NAR会場のfetchが404を返す。

**原因**: レースIDが古い形式、またはレースが中止。

**対策**: failCountが多い場合はログで確認し、該当レースをスキップ。

### 5. バッチ処理が途中で止まる

**対策**: `nohup`で実行してログファイルに出力。
```bash
nohup node scripts/complement_bracket.mjs > /tmp/bracket_log.txt 2>&1 &
tail -f /tmp/bracket_log.txt
```

## 充填率の目安

| 充填率 | 状態 |
|--------|------|
| 99.5%+ | 十分（一部中止レース等で100%にならないのは正常） |
| 95-99% | 良好（再実行で改善可能） |
| 90-95% | 要確認（特定会場のフェッチ失敗を調査） |
| <90% | 問題あり（スクリプトのパースロジックを確認） |
