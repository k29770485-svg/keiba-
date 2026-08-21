#!/usr/bin/env node
/**
 * ステージ2: レース結果ページからの netkeibaId 逆引き。
 *
 * 1リクエストで出走全馬（最大18頭）の「馬名 → ID」が得られるため、
 * 個体ページを1頭ずつ叩くより圧倒的に安い。
 * さらに、レース結果由来のIDは馬名と同一ページ内で対応しているので
 * 取り違えが原理的に起きない。誤ったIDが既に入っている馬の修正にも使う。
 *
 * 使い方（プロジェクト直下で実行）:
 *   cd <project> && node <skill>/scripts/resolve_ids_from_race.mjs
 *   cd <project> && node <skill>/scripts/resolve_ids_from_race.mjs --races https://db.netkeiba.com/race/202305050812/
 *   cd <project> && node <skill>/scripts/resolve_ids_from_race.mjs --dry-run
 *
 * 既存IDと異なるIDが見つかった場合は上書きする（--keep-existing で維持）。
 */
import { createRequire } from "module";
import path from "path";
import https from "https";
import { TextDecoder } from "util";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry-run");
const KEEP = argv.includes("--keep-existing");
const racesIdx = argv.indexOf("--races");
const SLEEP_MS = Number(process.env.SLEEP_MS ?? 2000);

/** 実アクセスで出走馬が解析できることを確認済みの代表レース */
const DEFAULT_RACES = [
  "https://db.netkeiba.com/race/202305050812/", // 2023 ジャパンカップ
  "https://db.netkeiba.com/race/202306050811/", // 2023 有馬記念
  "https://db.netkeiba.com/race/202206050811/", // 2022 有馬記念
  "https://db.netkeiba.com/race/202105050812/", // 2021 ジャパンカップ
  "https://db.netkeiba.com/race/202006050811/", // 2020 有馬記念
  "https://db.netkeiba.com/race/202305010811/", // 2023 フェブラリーS
];

const RACES =
  racesIdx >= 0
    ? argv
        .slice(racesIdx + 1)
        .filter(a => a.startsWith("http"))
    : DEFAULT_RACES;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function get(url, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 3) return reject(new Error("too many redirects"));
    const req = https.get(
      url,
      { headers: { "User-Agent": UA, Accept: "text/html" }, timeout: 15000 },
      res => {
        const code = res.statusCode ?? 0;
        if (code >= 300 && code < 400 && res.headers.location) {
          const redir = new URL(res.headers.location, url).toString();
          res.resume();
          return get(redir, depth + 1).then(resolve, reject);
        }
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () =>
          resolve({ status: code, body: new TextDecoder("euc-jp").decode(Buffer.concat(chunks)) }),
        );
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

/** 馬名→ID。アンカーテキスト形式と title 属性形式の両方に対応する */
function parseRaceHorseMap(html) {
  const map = {};
  for (const re of [
    /<a href="\/horse\/(\d{10})\/"[^>]*>([^<]+)<\/a>/g,
    /<a href="\/horse\/(\d{10})\/"[^>]*\stitle="([^"]+)"/g,
  ]) {
    let m;
    while ((m = re.exec(html)) !== null) {
      const name = m[2].trim();
      if (name && !map[name]) map[name] = m[1];
    }
  }
  return map;
}

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
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL が未設定。");
    process.exit(1);
  }
  const requireFromCwd = createRequire(path.join(process.cwd(), "package.json"));
  const mysql = requireFromCwd("mysql2/promise");
  const conn = await mysql.createConnection(buildConfig(url));

  let requests = 0;
  const resolved = {};

  try {
    for (const raceUrl of RACES) {
      let res;
      try {
        res = await get(raceUrl);
        requests += 1;
      } catch (e) {
        console.log(`NG ${raceUrl} — ${e.message}`);
        await sleep(SLEEP_MS);
        continue;
      }
      if (res.status !== 200) {
        console.log(`NG ${raceUrl} — HTTP ${res.status}`);
        await sleep(SLEEP_MS);
        continue;
      }
      const map = parseRaceHorseMap(res.body);
      const n = Object.keys(map).length;
      // HTTP 200 なのに 0 頭はページ構造変化を疑うべき異常
      console.log(`${n > 0 ? "OK" : "NG"} ${raceUrl} — ${n} 頭${n === 0 ? "（構造変化の可能性）" : ""}`);
      Object.assign(resolved, map);
      await sleep(SLEEP_MS);
    }

    console.log(`\n解決できた馬名: ${Object.keys(resolved).length} 件 / 外部リクエスト ${requests} 件`);

    const [rows] = await conn.query("SELECT id, name, netkeibaId FROM horses");
    let updated = 0;
    let corrected = 0;

    for (const h of rows) {
      const found = resolved[h.name];
      if (!found) continue;
      if (h.netkeibaId === found) continue;
      if (h.netkeibaId && KEEP) continue;

      const kind = h.netkeibaId ? "修正" : "新規";
      console.log(`  ${kind} ${h.name}: ${h.netkeibaId ?? "(なし)"} → ${found}`);
      if (!DRY) {
        await conn.query("UPDATE horses SET netkeibaId = ? WHERE id = ?", [found, h.id]);
      }
      updated += 1;
      if (h.netkeibaId) corrected += 1;
    }

    console.log(
      `\n${DRY ? "[dry-run] " : ""}netkeibaId を ${updated} 頭に設定（うち既存IDの修正 ${corrected} 頭）`,
    );
    if (corrected > 0) {
      console.log("既存IDが誤っていた馬がある。名前照合なしで取得していたらDBが汚染されていた。");
    }
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
