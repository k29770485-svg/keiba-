---
name: keiba-db-builder
description: 【非推奨・後継スキルへ移行済み】馬図鑑DB構築の旧スキル。実装が現行のnetkeiba仕様に追随しておらず、馬名照合を行わないため実行するとDBが静かに汚染される。馬図鑑DBの構築・補完・netkeibaからの取得・オンデマンド補完・画像プロキシに関する依頼では、本スキルではなく keiba-horse-db-pipeline を使用すること。本スキルは移行の経緯と旧実装の既知欠陥を参照するためにのみ残されている。
---

# keiba-db-builder（非推奨）

**このスキルは使用しない。後継の `keiba-horse-db-pipeline` を使うこと。**

馬図鑑DBの構築・補完、netkeibaからのデータ取得、オンデマンド補完、画像プロキシの
いずれの依頼でも、参照すべきは以下である。

```
/home/ubuntu/skills/keiba-horse-db-pipeline/SKILL.md
```

## 移行した理由

実測検証（2026-08-03、22頭規模）で、旧実装に実害のある欠陥が確認された。
設計思想（コスト優先度の段階化）は妥当だが、実装と手順が現行仕様で動作しない。

| 欠陥 | 内容 | 実測結果 |
|---|---|---|
| 馬名照合の欠如 | 取得ページの馬名とDBの馬名を突き合わせない | 22頭中19頭が別馬のデータで上書き。かつ「更新:5 失敗:0」と成功報告 |
| 血統がAjax後読み | 静的HTMLに `blood_table` は存在しない | 父・母・母父が全件NULL |
| 画像がAjax後読み | 同様。空idプレースホルダも混在 | 画像URL 0/22頭 |
| weserv.nl プロキシ | netkeibaドメインがポリシーでブロック済み | HTTP 400 `Domain or TLD blocked by policy` |
| 実在しない参照先 | 実装ファイル5件を手順で参照していた | 実体がなく手順が完了しない |
| ハードコードされたパス | `cd /home/ubuntu/keiba-kachisuji-web` 固定 | 別プロジェクトで実行不能 |
| モジュール解決 | ESMがスクリプト位置から `mysql2` を探す | `ERR_MODULE_NOT_FOUND` |

最も重大なのは**馬名照合の欠如**である。エラーを出さずに誤ったデータを書き込むため、
実行するほど静かにDBが壊れる。

## 後継スキルとの対応

以下のパスはすべて `/home/ubuntu/skills/keiba-horse-db-pipeline/` 配下を指す。

| 旧スキルの手順 | 後継スキルでの対応 |
|---|---|
| Step 1 SQL一括補完 | scripts 配下の supplement_from_history（通算成績の算出も追加） |
| Step 2 バッチ取得 | templates 配下の netkeibaFetcher（名前照合・Ajax対応・レート制限対応） |
| （旧スキルに手段なし） | scripts 配下の resolve_ids_from_race（正しいIDの逆引き） |
| Step 3 オンデマンド補完 | references 配下の webapp-integration |
| Step 4 画像プロキシ | templates 配下の imageProxy（自前プロキシ + allowlist） |
| （旧スキルに手段なし） | scripts 配下の verify_netkeiba_contract（仕様変更の検出） |

## 同梱スクリプトの状態

- `scripts/batch_fetch_details.mjs` — **実行を封鎖済み**。
  馬名照合がなくデータを汚染するため、`I_UNDERSTAND_THIS_CORRUPTS_DATA=1` がない限り起動しない
- `scripts/supplement_from_history.mjs` — 外部アクセスがなく安全だが、
  後継スキル版のほうが機能が多い（通算成績の算出、dry-run、SSL付き接続文字列対応）
- `references/implementation-guide.md` — 記述の一部が誤り。
  参照する場合は後継スキル keiba-horse-db-pipeline の references 配下にある
  スキーマ定義および netkeiba 仕様の記述と照合すること
