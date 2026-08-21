# DBスキーマ（Drizzle / MySQL・TiDB 互換）


段階的補完を前提とした設計。**詳細カラムはすべて nullable にする**のが要点で、
`name` と `netkeibaId` だけの骨組みから始めて徐々に埋める。

## horses（中核テーブル）

```ts
export const horses = mysqlTable("horses", {
  id: int("id").autoincrement().primaryKey(),
  /** netkeiba の馬個体ID（10桁）。誤った紐付けがあり得るため必ず馬名照合と併用する */
  netkeibaId: varchar("netkeibaId", { length: 16 }),
  name: varchar("name", { length: 64 }).notNull(),
  nameEn: varchar("nameEn", { length: 128 }),
  sex: varchar("sex", { length: 8 }),            // 牡 / 牝 / セ
  coatColor: varchar("coatColor", { length: 16 }),
  birthDate: varchar("birthDate", { length: 32 }),
  trainer: varchar("trainer", { length: 64 }),
  trainerBase: varchar("trainerBase", { length: 16 }),  // 栗東 / 美浦
  owner: varchar("owner", { length: 128 }),
  breeder: varchar("breeder", { length: 128 }),
  sire: varchar("sire", { length: 64 }),
  dam: varchar("dam", { length: 64 }),
  damSire: varchar("damSire", { length: 64 }),
  affiliation: mysqlEnum("affiliation", ["JRA", "NAR"]),
  weight: int("weight"),
  imageUrl: varchar("imageUrl", { length: 512 }),
  totalRuns: int("totalRuns").default(0).notNull(),
  totalWins: int("totalWins").default(0).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  /** 詳細取得が最後に成功した時刻。オンデマンド補完の重複発火防止に使う */
  detailFetchedAt: timestamp("detailFetchedAt"),
}, table => ({
  nameIdx: index("horses_name_idx").on(table.name),
  netkeibaIdx: index("horses_netkeiba_idx").on(table.netkeibaId),
}));
```

## horse_race_history（SQL一括補完の情報源）

`venue` があることで、外部アクセスなしに所属(JRA/NAR)を判定できる。
`horseWeight` から最新馬体重、`finishPosition` から通算成績が算出できる。

```ts
export const horseRaceHistory = mysqlTable("horse_race_history", {
  id: int("id").autoincrement().primaryKey(),
  horseId: int("horseId").notNull(),
  horseName: varchar("horseName", { length: 64 }).notNull(),
  raceDate: varchar("raceDate", { length: 16 }).notNull(),
  raceName: varchar("raceName", { length: 128 }).notNull(),
  venue: varchar("venue", { length: 32 }).notNull(),   // 東京 / 中山 / 大井 ...
  distance: int("distance"),
  surface: varchar("surface", { length: 8 }),
  finishPosition: int("finishPosition"),
  horseWeight: int("horseWeight"),
  jockey: varchar("jockey", { length: 64 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => ({
  horseIdx: index("history_horse_idx").on(table.horseId),
  dateIdx: index("history_date_idx").on(table.raceDate),
}));
```

## fetch_logs（監査ログ）

「どの手法で何リクエスト使い、どういう結果になったか」を必ず残す。
これがないと段階的補完の効果を数値で示せず、壊れていることにも気付けない。

```ts
export const fetchLogs = mysqlTable("fetch_logs", {
  id: int("id").autoincrement().primaryKey(),
  horseId: int("horseId"),
  horseName: varchar("horseName", { length: 64 }),
  netkeibaId: varchar("netkeibaId", { length: 16 }),
  /** on_demand / batch / resolve_id / sql_supplement */
  source: varchar("source", { length: 32 }).notNull(),
  /** ok / name_mismatch / not_found / rate_limited / error / skipped */
  status: varchar("status", { length: 32 }).notNull(),
  actualName: varchar("actualName", { length: 64 }),
  filledFields: int("filledFields").default(0).notNull(),
  requestCount: int("requestCount").default(0).notNull(),
  durationMs: int("durationMs").default(0).notNull(),
  message: text("message"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
```

## mismatch_logs（隔離ログ・必須）

名前不一致で拒否したデータの退避先。**`rejectedPayload` に取得内容を丸ごと残す**ことで、
後から「どちらのIDが正しいか」を人間が検証できる。

```ts
export const mismatchLogs = mysqlTable("mismatch_logs", {
  id: int("id").autoincrement().primaryKey(),
  horseId: int("horseId").notNull(),
  dbName: varchar("dbName", { length: 64 }).notNull(),
  netkeibaId: varchar("netkeibaId", { length: 16 }).notNull(),
  actualName: varchar("actualName", { length: 64 }).notNull(),
  rejectedPayload: text("rejectedPayload"),
  source: varchar("source", { length: 32 }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
```

## coverage_snapshots（充填率の推移）

段階ごとの充填率を記録しておくと、ダッシュボードで「どの手法が何を埋めたか」を可視化できる。

```ts
export const coverageSnapshots = mysqlTable("coverage_snapshots", {
  id: int("id").autoincrement().primaryKey(),
  stage: varchar("stage", { length: 32 }).notNull(),   // step0 / step1 / step2 / step3
  label: varchar("label", { length: 128 }).notNull(),
  totalHorses: int("totalHorses").notNull(),
  metrics: text("metrics").notNull(),                  // 項目別充填率のJSON
  requestCount: int("requestCount").default(0).notNull(),
  recordedAt: bigint("recordedAt", { mode: "number" }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
```

## 充填状況の3区分

UI のバッジ表記と判定ロジックを1対1にしておく。表示と挙動が食い違うと調査が困難になる。

```ts
export function computeFillStatus(h) {
  if (!h.netkeibaId) return "unlinked";                  // ID未紐付
  if (h.trainer && h.sire) return "filled";              // 充填済
  return "pending";                                       // 補完待ち
}
/** オンデマンド補完の発火条件は computeFillStatus === "pending" と完全に一致させる */
export const needsFetch = h => computeFillStatus(h) === "pending";
```

## マイグレーション手順（webdev プロジェクト）

```
1. drizzle/schema.ts を編集
2. pnpm drizzle-kit generate
3. 生成された .sql を読む
4. webdev_execute_sql で適用
```
