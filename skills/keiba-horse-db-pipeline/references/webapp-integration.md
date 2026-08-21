# Webアプリへの組み込み


馬図鑑を webdev フルスタックプロジェクト（tRPC + Drizzle + React）として作る場合の型。

## 画像プロキシ（必須）

netkeiba の馬体写真は Referer を見ており、ブラウザから直リンクすると表示できない。
`templates/imageProxy.ts` をそのまま `server/imageProxy.ts` に置き、Express に登録する。

```ts
// server/_core/index.ts
import { registerImageProxy } from "../imageProxy";
registerImageProxy(app);   // /api/image-proxy?url=... を提供
```

**allowlist を必ず入れる。** 任意URLを中継できると SSRF の踏み台になる。
`(^|\.)netkeiba\.com$` のように**末尾一致で**判定する（`netkeiba.com.evil.example` を弾くため）。
CORS 許可と 24 時間キャッシュを付ける。

フロント側は `imageUrl` を必ずプロキシ経由に変換して使う。

```tsx
const proxied = (u?: string | null) =>
  u ? `/api/image-proxy?url=${encodeURIComponent(u)}` : null;
```

画像が取れない馬（レート制限・未紐付）が必ず出るので、**頭文字などのプレースホルダに
フォールバックする**実装にしておく。壊れた img アイコンを見せない。

## tRPC プロシージャの構成

```
horses.list          一覧（充填状況を計算して返す）
horses.detail        詳細
horses.onDemandFetch 詳細ページ閲覧時の1頭補完
supplement.fromHistory   SQL一括補完（外部アクセス0）
supplement.resolveIds    レース結果からのID逆引き
supplement.batchFetch    未充填馬のバッチ取得
supplement.backfillImages 画像のみ欠けている馬の補完
stats.coverage       充填率と段階別スナップショット
logs.mismatches      隔離ログの閲覧
```

補完系は副作用があるので `mutation` にする。管理系を公開したままにしたくない場合は
`protectedProcedure` / `adminProcedure` に切り替える。

## オンデマンド補完の発火

詳細ページ表示時に、未充填かつ ID がある馬に限って発火させる。

```tsx
useEffect(() => {
  if (!horse) return;
  if (horse.fillStatus !== "pending") return;   // 充填済み・ID未紐付では叩かない
  if (fired.current) return;                    // 二重発火を防ぐ
  fired.current = true;
  onDemand.mutate({ id: horse.id });
}, [horse]);
```

**充填済みの馬では外部アクセスを一切発生させない**のがコスト設計の要。
実測で、充填済みの馬の応答は DB のみで完結し 2ms 程度、
未充填の馬は 3 リクエストで数秒かかる。

`detailFetchedAt` を見て「直近に失敗した馬を毎回叩き直さない」ようにするとさらに安全。

## レート制限のUI表現

レート制限は必ず起きる。**「取得失敗」ではなく「時間を置けば取れる」と伝わる文言にする。**

```
netkeiba 側から一時的に接続を制限されています。少し時間を置いて再度お試しください。
```

バッチ処理の結果には `rate_limited` の件数を含め、UI 側で警告として出す。

## 充填状況バッジ

3区分を UI に出すと、どのデータがなぜ空なのかがユーザーにも運用者にも分かる。

| バッジ | 条件 | 意味 |
|---|---|---|
| 充填済 | ID あり + 詳細あり | 外部アクセス不要 |
| 補完待ち | ID あり + 詳細なし | 閲覧時に自動取得 |
| ID未紐付 | ID なし | 先に ID 逆引きが必要 |

## 定期実行

週次で出走予定馬だけを補完するなど、スケジュール実行を入れる場合は
`/home/ubuntu/skills/webdev-periodic-updates/SKILL.md` を先に読む。
Autoscale ホスティングではリクエストを超えて生きるプロセスは使えないため、
長時間のバッチは 1 回あたりの件数を絞って複数回に分ける。

## テストの勘所

パーサとガードは**実HTMLの構造を模した固定文字列**に対する単体テストにする
（実アクセスに依存させると壊れやすく、レート制限でも落ちる）。
`templates/netkeibaFetcher.test.ts` と `templates/nameGuard.test.ts` をそのまま流用できる。

最低限おさえる観点:

- 馬名・性別・毛色の抽出（抹消馬の `抹消　牝　鹿毛` を含む）
- 空 id プレースホルダの除外
- 血統の父・母・母父の位置特定
- レース結果の2形式（アンカーテキスト / title属性）
- レート制限エラーと恒久的失敗（404）の判別
- 名前不一致時に payload を採用しないこと
- 画像プロキシのホスト allowlist（SSRF）
