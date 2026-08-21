---
name: keiba-horse-db-pipeline
description: 競走馬（馬図鑑）データベースを段階的補完パイプラインで構築・運用するスキル。SQL一括補完 → レース結果からのID逆引き → 名前照合付きバッチ取得 → オンデマンド補完の順にコストの安い手法から実行し、netkeibaの現行仕様（EUC-JP・血統/画像のAjax後読み・レート制限のTLS切断）に対応する。Use when building or supplementing a horse encyclopedia database, fetching horse profiles or pedigree from netkeiba, resolving netkeibaId, implementing on-demand horse data completion, fixing horse image display or CORS/Referer issues, diagnosing wrong or mismatched horse data in the DB, or building a horse database web app.
---

# 馬図鑑DB 段階的補完パイプライン

競走馬データベースを、外部アクセスを最小化しながら構築する。
**最重要の原則は「取得結果の馬名をDBの馬名と照合し、不一致なら書き込まない」こと。**
この照合を省くと、誤ったIDのページ内容が別馬の行にそのまま書き込まれ、
例外もログも出さずにDBが汚染される（実測で22頭中19頭が別馬のデータになった事例がある）。

## コスト優先度（この順で実行する）

| 段階 | 手法 | 外部リクエスト | 埋まる項目 |
|---|---|---|---|
| 1 | SQL一括補完 | **0件** | 馬体重・所属(JRA/NAR)・通算成績 |
| 2 | レース結果からID逆引き | 1件で最大18頭 | netkeibaId |
| 3 | 名前照合付きバッチ取得 | 1頭3件 | 性別・毛色・生年月日・調教師・馬主・生産者・血統・画像 |
| 4 | オンデマンド補完 | 閲覧時のみ1頭3件 | 同上 |
| — | 全件スクレイピング | 極大・**非推奨** | 明示指示がある場合のみ |

段階1で埋まった馬は以降の外部取得対象から外れる。順序を守ることが総コストを決める。

## 実行手順

### 準備: 現行仕様の確認

netkeiba は静的HTMLだった血統表・馬体写真を Ajax 後読みに移行済み。
**実装前に必ず 1 回、現在も想定どおりかを確認する。**

```bash
node /home/ubuntu/skills/keiba-horse-db-pipeline/scripts/verify_netkeiba_contract.mjs
# 特定の馬とレースで確認する場合
node .../verify_netkeiba_contract.mjs 2019105219 https://db.netkeiba.com/race/202305050812/
```

全項目 OK なら既存パーサがそのまま使える。NG があれば
`references/netkeiba-contract.md` を読み、パーサを直してから進む。

### 段階0: 現状把握

スクリプトは**プロジェクト直下で実行する**（ESM は cwd の `node_modules` から `mysql2` を解決する）。
`DATABASE_URL` が必要。webdev プロジェクトでは既に env にある。

```bash
cd <project> && node /home/ubuntu/skills/keiba-horse-db-pipeline/scripts/coverage_report.mjs --label "初期状態"
```

項目別充填率・充填状況の3区分・手法別の消費リクエスト数・名前不一致の件数が出る。
**各段階の前後で実行し、どの手法が何を埋めたかを数値で残す。**

### 段階1: SQL一括補完（外部アクセス 0 件）

```bash
cd <project> && node .../scripts/supplement_from_history.mjs --dry-run   # 影響範囲の確認
cd <project> && node .../scripts/supplement_from_history.mjs
```

`horse_race_history` の最新出走から馬体重を、開催場が JRA10場かどうかで所属を、
着順から通算成績を埋める。**必ず最初に実行する。**

### 段階2: netkeibaId の逆引き

```bash
cd <project> && node .../scripts/resolve_ids_from_race.mjs --dry-run
cd <project> && node .../scripts/resolve_ids_from_race.mjs
cd <project> && node .../scripts/resolve_ids_from_race.mjs --races https://db.netkeiba.com/race/202305050812/
```

レース結果ページ1枚で出走全馬のIDが得られ、**馬名とIDが同一ページ内で対応しているため
取り違えが原理的に起きない。** 既存IDが誤っている馬の修正にも使う（`--keep-existing` で維持）。

馬名検索API（`pid=horse_search`）は EUC-JP のクエリ送信が必要で不安定なため使わない。

### 段階3: 詳細のバッチ取得（名前照合が必須）

`templates/netkeibaFetcher.ts` をプロジェクトの `server/netkeibaFetcher.ts` に配置して使う。
`fetchHorseDetails(netkeibaId, expectedName)` は照合に失敗すると
`{ ok: false, reason: "name_mismatch", pageName, payload }` を返す。
**呼び出し側は書き込まず、`mismatch_logs` に payload を退避する。**

```ts
const out = await fetchHorseDetails(horse.netkeibaId, horse.name);
if (!out.ok) {
  if (out.reason === "name_mismatch") {
    await logMismatch({ horseId: horse.id, dbName: horse.name,
      netkeibaId: horse.netkeibaId, actualName: out.pageName,
      rejectedPayload: JSON.stringify(out.payload), source: "batch" });
  }
  continue;   // 絶対に書き込まない
}
```

リクエスト間隔は 1500〜2000ms。1頭で3リクエスト消費する。

### 段階4: オンデマンド補完

詳細ページ閲覧時に、**未充填かつIDがある馬のみ**1頭取得する。
充填済みの馬では外部アクセスを一切発生させない。
実装の型は `references/webapp-integration.md` を読む。

## 必須の安全機構

1. **馬名照合** — 取得HTMLの `<h1>` とDBの `name` が完全一致しなければ書き込まない。部分一致は許さない
2. **隔離ログ** — 拒否したデータは `mismatch_logs` に payload ごと残し、後から検証できるようにする
3. **レート制限の区別** — TLS切断系エラーを `not_found` と混同しない。混同すると実在馬を恒久的に除外する
4. **相対リダイレクトの正しい解決** — `new URL(location, base)` を使う。文字列連結は別馬に飛ぶ
5. **画像プロキシの allowlist** — 任意URL中継はSSRFになる。netkeibaホストの末尾一致で限定する
6. **0件を異常として扱う** — HTTP 200 で出走馬0頭、血統が全NULL などは構造変化のサイン

## よくある失敗

| 症状 | 原因 |
|---|---|
| 別馬の英字名・調教師・性別が入っている | 名前照合をしていない。IDの紐付けが誤っている |
| 血統（父・母・母父）が常にNULL | 静的HTMLに `blood_table` は無い。Ajax エンドポイントを叩く |
| 画像URLが常に空 | 同じくAjax。加えて `id=` が空のプレースホルダを除外する必要がある |
| 画像URLの末尾が `id=` で切れている | 空idプレースホルダを拾っている。`id=\d+` のみ採用する |
| 馬名が文字化けして照合が全部失敗 | 馬個体ページは EUC-JP。UTF-8 で読んでいる |
| 性別が「セ」と誤判定される | 文字列全体への正規表現マッチ。全角スペースでトークン分割する |
| 馬主が空になる | `<a>` の無い未登録馬主。`img[alt]` をフォールバックにする |
| ブラウザで画像が表示されない | Referer 制限。サーバー側プロキシ経由にする |
| 突然すべての取得が失敗し始めた | レート制限。数分空けて再開する。並列数と間隔を見直す |
| `ERR_MODULE_NOT_FOUND: mysql2` | スキルディレクトリから直接実行している。プロジェクト直下で実行する |
| 1万頭規模で極端に遅い | 1頭ずつUPDATEしている。`INSERT ... ON DUPLICATE KEY UPDATE` でバルク化する |

## リソース

| ファイル | 用途 |
|---|---|
| `scripts/verify_netkeiba_contract.mjs` | 現行仕様の契約テスト。実装前と異常時に実行 |
| `scripts/coverage_report.mjs` | 充填率・手法別コスト・不一致件数のレポート |
| `scripts/supplement_from_history.mjs` | 段階1のSQL一括補完 |
| `scripts/resolve_ids_from_race.mjs` | 段階2のID逆引き |
| `templates/netkeibaFetcher.ts` | 名前照合・レート制限対応込みの取得モジュール（TypeScript） |
| `templates/imageProxy.ts` | Referer付与・allowlist・24時間キャッシュの画像プロキシ |
| `templates/netkeibaFetcher.test.ts` | パーサの単体テスト（実アクセス不要） |
| `templates/nameGuard.test.ts` | 名前照合による書き込み拒否のテスト |
| `templates/imageProxy.test.ts` | 画像プロキシのSSRF対策（ホストallowlist）テスト |
| `references/netkeiba-contract.md` | netkeibaの実仕様・検証済みレースURL。パーサを書く前に読む |
| `references/db-schema.md` | DBスキーマ定義と充填状況判定。DB設計時に読む |
| `references/webapp-integration.md` | tRPC構成・オンデマンド発火・UI表現。Webアプリ化する時に読む |
