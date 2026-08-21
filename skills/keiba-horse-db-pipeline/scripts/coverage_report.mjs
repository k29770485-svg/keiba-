#!/usr/bin/env node
/**
 * 充填率レポート。段階的補完の各ステップ前後で実行し、
 * 「どの手法が何件を埋めたか」を数値で残すために使う。
 *
 * 使い方（プロジェクト直下で実行し、mysql2 を解決させる）:
 *   cd <project> && node <skill>/scripts/coverage_report.mjs
 *   cd <project> && node <skill>/scripts/coverage_report.mjs --label "SQL補完後"
 *
 * DATABASE_URL（mysql://user:pass@host:port/db）が必要。
 * webdev プロジェクトでは既に env に注入されている。
 *
 * 注意: ESM の import は「スクリプト自身の位置」から node_modules を探すため、
 * スキルディレクトリ内のスクリプトからは素の import で mysql2 を解決できない。
 * 本スクリプトは createRequire で cwd 基準に解決するため、
 * プロジェクト直下（node_modules がある場所）で実行すれば動く。
 */
import { createRequire } from "module";
import path from "path";

const args = process.argv.slice(2);
const labelIdx = args.indexOf("--label");
const LABEL = labelIdx >= 0 ? args[labelIdx + 1] : "現在";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL が未設定。プロジェクト直下で env を読み込んで実行すること。");
  process.exit(1);
}

let mysql;
try {
  // cwd を基準に解決する（スキルの位置ではなくプロジェクトの node_modules を見る）
  const requireFromCwd = createRequire(path.join(process.cwd(), "package.json"));
  mysql = requireFromCwd("mysql2/promise");
} catch {
  console.error(
    "mysql2 を解決できない。プロジェクト直下（node_modules がある場所）で実行すること。",
  );
  process.exit(1);
}

/** 充填率を見る項目。DBスキーマに合わせて調整する */
const FIELDS = [
  ["netkeibaId", "netkeiba ID"],
  ["sex", "性別"],
  ["coatColor", "毛色"],
  ["birthDate", "生年月日"],
  ["trainer", "調教師"],
  ["owner", "馬主"],
  ["breeder", "生産者"],
  ["sire", "父"],
  ["dam", "母"],
  ["damSire", "母父"],
  ["affiliation", "所属(JRA/NAR)"],
  ["weight", "最新馬体重"],
  ["imageUrl", "画像URL"],
];

/**
 * DATABASE_URL には `?ssl={"rejectUnauthorized":true}` が付くことがある
 * （TiDB Cloud など）。URL 文字列をそのまま渡すと接続がハングするため、
 * ssl だけ設定オブジェクトに移して渡す。
 */
function buildConfig(raw) {
  const u = new URL(raw);
  const cfg = {
    host: u.hostname,
    port: u.port ? Number(u.port) : 3306,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ""),
    connectTimeout: 15000,
  };
  const sslParam = u.searchParams.get("ssl");
  if (sslParam) {
    try {
      cfg.ssl = JSON.parse(sslParam);
    } catch {
      cfg.ssl = { rejectUnauthorized: true };
    }
  }
  return cfg;
}

/** 全角を2幅として数え、表示幅を揃える */
const padDisplay = (s, width) => {
  const w = [...s].reduce((n, ch) => n + (/[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1), 0);
  return s + " ".repeat(Math.max(0, width - w));
};

const conn = await mysql.createConnection(buildConfig(url));
try {
  const [[{ total }]] = await conn.query("SELECT COUNT(*) AS total FROM horses");
  if (total === 0) {
    console.log("horses テーブルが空。シード投入から始めること。");
    process.exit(0);
  }

  const sel = FIELDS.map(([f]) => `SUM(CASE WHEN \`${f}\` IS NOT NULL THEN 1 ELSE 0 END) AS \`${f}\``).join(", ");
  const [[counts]] = await conn.query(`SELECT ${sel} FROM horses`);

  // 充填状況の3区分。UI のバッジ表記と同じ基準で数える
  const [[status]] = await conn.query(`
    SELECT
      SUM(CASE WHEN netkeibaId IS NULL THEN 1 ELSE 0 END) AS unlinked,
      SUM(CASE WHEN netkeibaId IS NOT NULL AND trainer IS NOT NULL AND sire IS NOT NULL THEN 1 ELSE 0 END) AS filled,
      SUM(CASE WHEN netkeibaId IS NOT NULL AND (trainer IS NULL OR sire IS NULL) THEN 1 ELSE 0 END) AS pending
    FROM horses
  `);

  console.log(`\n=== 充填率レポート: ${LABEL} （全 ${total} 頭） ===\n`);
  for (const [f, label] of FIELDS) {
    const n = Number(counts[f] ?? 0);
    const rate = ((n / total) * 100).toFixed(1);
    const bar = "#".repeat(Math.round((n / total) * 30)).padEnd(30, ".");
    console.log(`${padDisplay(label, 18)} ${bar} ${String(n).padStart(5)}/${total} (${rate}%)`);
  }

  console.log(
    `\n充填状況: 充填済 ${status.filled} / 補完待ち ${status.pending} / ID未紐付 ${status.unlinked}`,
  );

  // 監査ログがあれば、手法別の外部リクエスト消費も出す
  const [logTables] = await conn.query("SHOW TABLES LIKE 'fetch_logs'");
  if (logTables.length > 0) {
    const [rows] = await conn.query(`
      SELECT source, status, COUNT(*) AS n, COALESCE(SUM(requestCount),0) AS reqs
      FROM fetch_logs GROUP BY source, status ORDER BY source, status
    `);
    if (rows.length > 0) {
      console.log("\n手法別の実行結果（source / status / 件数 / 外部リクエスト数）:");
      for (const r of rows) {
        console.log(`  ${String(r.source).padEnd(16)} ${String(r.status).padEnd(16)} ${String(r.n).padStart(4)} 件  ${r.reqs} req`);
      }
    }
  }

  const [misTables] = await conn.query("SHOW TABLES LIKE 'mismatch_logs'");
  if (misTables.length > 0) {
    const [[m]] = await conn.query("SELECT COUNT(*) AS n FROM mismatch_logs");
    console.log(`\n名前不一致で書き込みを拒否した件数: ${m.n}`);
    if (Number(m.n) > 0) {
      const [rows] = await conn.query(
        "SELECT dbName, netkeibaId, actualName FROM mismatch_logs ORDER BY id DESC LIMIT 5",
      );
      for (const r of rows) {
        console.log(`  DB:${r.dbName}  ID:${r.netkeibaId}  ページ上:${r.actualName}`);
      }
      console.log("  → 該当馬の netkeibaId は誤り。レース結果からの逆引きで修正すること。");
    }
  }
  console.log();
} finally {
  // TiDB Cloud などでは end() 後もソケットが残りプロセスが終了しないことがある。
  // レポート出力が終わったら明示的に落とす。
  try {
    await conn.end();
  } catch {
    /* noop */
  }
  conn.destroy?.();
  process.exit(0);
}
