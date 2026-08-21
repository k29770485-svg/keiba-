# 馬図鑑DB構築 実装ガイド（非推奨・誤りを含む）

> **このファイルの内容は現行仕様と一致しない箇所がある。**
> 参照する場合は `/home/ubuntu/skills/keiba-horse-db-pipeline/references/db-schema.md`
> および `netkeiba-contract.md` と照合すること。
> 以下、実測で誤りが確認された箇所に注記を入れてある。

## horsesテーブル主要カラム

| カラム | 型 | 説明 |
|--------|------|------|
| id | int (PK) | 内部ID |
| name | varchar | 馬名（ユニーク） |
| netkeibaId | varchar | netkeiba馬ID（10桁数字） |
| sex | varchar | 性別（牡/牝/セ） |
| age | int | 年齢 |
| trainer | varchar | 調教師名 |
| owner | varchar | 馬主名 |
| breeder | varchar | 生産者 |
| sire | varchar | 父 |
| dam | varchar | 母 |
| damSire | varchar | 母父 |
| coatColor | varchar | 毛色 |
| nameEn | varchar | 英字名 |
| imageUrl | varchar | 画像URL |
| weight | int | 最新馬体重 |
| affiliation | varchar | 所属（JRA/NAR） |
| totalWins / totalRuns | int | 通算勝利/出走数 |
| turfWinRate / dirtWinRate | float | 芝/ダート勝率 |
| heavyTrackScore | int | 重馬場適性(0-100) |
| smallTrackScore | int | 小回り適性(0-100) |
| straightScore | int | 直線適性(0-100) |
| distanceAptitude | varchar | 距離適性 |
| runningStyle | varchar | 脚質 |
| updatedAt | datetime | 最終更新日時 |

## オンデマンド補完の実装パターン

### サーバー側（horseRouter.ts内）

```typescript
fetchDetails: publicProcedure
  .input(z.object({ horseId: z.number() }))
  .mutation(async ({ input }) => {
    const horse = await getHorseById(input.horseId);
    if (!horse || !horse.netkeibaId) return { status: "not_found" };
    const details = await fetchHorseDetailsFromNetkeiba(horse.name, horse.netkeibaId);
    if (!details) return { status: "fetch_failed" };
    // DB更新
    await updateHorseDetails(horse.id, details);
    return { status: "ok", data: details };
  })
```

### フロントエンド側（HorseDetailPage.tsx内）

```tsx
// netkeibaIdがあり、かつtrainer/sireが未充填の場合のみ自動補完
const needsFetch = horse && horse.netkeibaId && !horse.trainer && !horse.sire;
const [fetchAttempted, setFetchAttempted] = useState(false);

useEffect(() => {
  if (needsFetch && !fetchAttempted) {
    setFetchAttempted(true);
    fetchDetailsMutation.mutate({ horseId: horse.id });
  }
}, [needsFetch, fetchAttempted]);
```

## 画像プロキシ対応

> **⚠ この方式は動作しない。** weserv.nl は netkeiba ドメインをポリシーでブロックしており、
> 実測で HTTP 400 `{"status":"error","code":400,"message":"Domain or TLD blocked by policy"}`
> が返る。Referer を付与した自前のサーバー側プロキシが必要
> （`keiba-horse-db-pipeline/templates/imageProxy.ts`）。

外部画像（netkeiba等）のCORS回避:
```typescript
// client/src/lib/imageProxy.ts
export function getProxiedImageUrl(url: string): string {
  if (!url || url.startsWith('/')) return url;
  return `https://images.weserv.nl/?url=${encodeURIComponent(url)}&w=400&h=400&fit=cover`;
}
```

## netkeibaのエンコーディング注意点

> **⚠ 記述が不足している。** 馬個体ページとレース結果ページは EUC-JP だが、
> **Ajax エンドポイント（血統・画像）は UTF-8 の JSON** である。
> また血統表・馬体写真は静的HTMLに存在せず Ajax 後読みのため、
> 本ガイドの前提では父・母・母父・画像URLが永久に NULL になる。

- netkeibaはEUC-JPエンコーディング
- Node.jsでは `TextDecoder('euc-jp')` を使用してデコード
- 検索APIはEUC-JPでのクエリが必要（動作不安定のため、netkeibaIdが既知の馬のみ直接アクセス推奨）

## コスト節約の原則

1. **horse_race_historyからの補完を最優先** — 外部アクセス不要
2. **netkeibaIdがある馬のみバッチ取得** — 検索APIは不安定
3. **オンデマンド補完** — ユーザーが閲覧した馬のみ取得（全件取得しない）
4. **リクエスト間隔1.5秒以上** — レート制限回避
