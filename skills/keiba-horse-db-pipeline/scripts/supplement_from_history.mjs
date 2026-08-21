#!/usr/bin/env node
/**
 * ステージ1: SQL 一括補完（外部アクセス 0 件）。
 *
 * horse_race_history だけを使い、馬体重・所属(JRA/NAR)・通算成績を埋める。
 * 段階的補完の最初に必ず実行する。ここで埋まった馬は
 * 以降の外部取得の対象から外れるため、総リクエスト数が大きく減る。
 *
 * 使い方（プロジェクト直下で実行）:
 *   cd <project> && node <skill>/scripts/supplement_from_history.mjs
 *   cd <project> && node <skill>/scripts/supplement_from_history.mjs --dry-run
 */
import { createRequire } from "module";
import path from "path";

const DRY = process.argv.includes("--dry-run");

const url = process.env.DATABASE_URL;

/** JRA の10場。これ以外の開催場は地方（NAR）と判定する */
const JRA_VENUES = ["東京", "中山", "阪神", "京都", "中京", "小倉", "新潟", "福島", "函館", "札幌"];

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

async function main() {
  if (!url) {
    console.error("DATABASE_URL が未設定。");
    process.exit(1);
  }
  const requireFromCwd = createRequire(path.join(process.cwd(), "package.json"));
  const mysql = requireFromCwd("mysql2/promise");
  const conn = await mysql.createConnection(buildConfig(url));

  const t0 = Date.now();
  const placeholders = JRA_VENUES.map(() => "?").join(", ");

  try {
    if (DRY) {
      const [[w]] = await conn.query(`
        SELECT COUNT(*) AS n FROM horses h
        JOIN horse_race_history hr ON h.name = hr.horseName
        WHERE h.weight IS NULL AND hr.horseWeight IS NOT NULL
      `);
      const [[a]] = await conn.query(
        `SELECT COUNT(*) AS n FROM horses WHERE affiliation IS NULL`,
      );
      console.log(`[dry-run] 馬体重を補完できる可能性のある馬: ${w.n} 行の履歴が該当`);
      console.log(`[dry-run] 所属が未設定の馬: ${a.n} 頭`);
      return;
    }

    // 1. 最新出走の馬体重を採用
    const [w] = await conn.query(`
      UPDATE horses h
      JOIN (
        SELECT hr.horseName, hr.horseWeight
        FROM horse_race_history hr
        JOIN (
          SELECT horseName, MAX(raceDate) AS latest
          FROM horse_race_history
          WHERE horseWeight IS NOT NULL
          GROUP BY horseName
        ) m ON hr.horseName = m.horseName AND hr.raceDate = m.latest
        WHERE hr.horseWeight IS NOT NULL
        GROUP BY hr.horseName, hr.horseWeight
      ) x ON h.name = x.horseName
      SET h.weight = x.horseWeight
      WHERE h.weight IS NULL
    `);

    // 2. 最新出走の開催場から所属(JRA/NAR)を判定
    const [a] = await conn.query(
      `
      UPDATE horses h
      JOIN (
        SELECT hr.horseName, hr.venue
        FROM horse_race_history hr
        JOIN (
          SELECT horseName, MAX(raceDate) AS latest
          FROM horse_race_history GROUP BY horseName
        ) m ON hr.horseName = m.horseName AND hr.raceDate = m.latest
        GROUP BY hr.horseName, hr.venue
      ) v ON h.name = v.horseName
      SET h.affiliation = CASE WHEN v.venue IN (${placeholders}) THEN 'JRA' ELSE 'NAR' END
      WHERE h.affiliation IS NULL
    `,
      JRA_VENUES,
    );

    // 3. 通算成績（出走数・勝利数）も履歴から算出できる
    const [s] = await conn.query(`
      UPDATE horses h
      JOIN (
        SELECT horseName,
               COUNT(*) AS runs,
               SUM(CASE WHEN finishPosition = 1 THEN 1 ELSE 0 END) AS wins
        FROM horse_race_history GROUP BY horseName
      ) x ON h.name = x.horseName
      SET h.totalRuns = x.runs, h.totalWins = x.wins
    `);

    console.log(`SQL 一括補完 完了（外部アクセス 0 件 / ${Date.now() - t0}ms）`);
    console.log(`  馬体重:   ${w.affectedRows} 頭`);
    console.log(`  所属:     ${a.affectedRows} 頭`);
    console.log(`  通算成績: ${s.affectedRows} 頭`);
  } finally {
    try {
      await conn.end();
    } catch {
      /* noop */
    }
    conn.destroy?.();
  }
  process.exit(0);
}

main().catch(e => {
  console.error("失敗:", e.message);
  process.exit(1);
});
