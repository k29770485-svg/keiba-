#!/usr/bin/env node
/**
 * netkeiba の「現在の仕様」を実アクセスで確認する契約テスト。
 *
 * なぜ必要か:
 *   netkeiba は静的HTMLだった血統表・馬体写真を Ajax 後読みに移行しており、
 *   同種のスクレイパは仕様変更で「例外も出さずに NULL を書き続ける」形で壊れる。
 *   実装前とパーサ改修前に本スクリプトを1回走らせ、想定した構造が現存するかを確かめる。
 *
 * 使い方:
 *   node verify_netkeiba_contract.mjs [netkeibaId] [raceUrl]
 *   例: node verify_netkeiba_contract.mjs 2019105219 https://db.netkeiba.com/race/202305050812/
 *
 * 終了コード: 0 = 想定どおり / 1 = 想定と異なる（パーサ改修が必要）
 */
import https from "https";
import { TextDecoder } from "util";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const HORSE_ID = process.argv[2] || "2019105219"; // イクイノックス
const RACE_URL = process.argv[3] || "https://db.netkeiba.com/race/202305050812/"; // 2023 ジャパンカップ

const sleep = ms => new Promise(r => setTimeout(r, ms));

function get(url, decode = "euc-jp", depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 3) return reject(new Error("too many redirects"));
    const req = https.get(
      url,
      { headers: { "User-Agent": UA, Accept: "text/html,application/json" }, timeout: 15000 },
      res => {
        const code = res.statusCode ?? 0;
        if (code >= 300 && code < 400 && res.headers.location) {
          // 相対 Location を必ず URL で解決する（文字列連結だと別馬に飛ぶ事故が起きる）
          const redir = new URL(res.headers.location, url).toString();
          res.resume();
          return get(redir, decode, depth + 1).then(resolve, reject);
        }
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          const body =
            decode === "utf-8" ? buf.toString("utf8") : new TextDecoder(decode).decode(buf);
          resolve({ status: code, body });
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

const checks = [];
const record = (name, ok, detail) => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "OK  " : "NG  "} ${name}${detail ? ` — ${detail}` : ""}`);
};

async function main() {
  console.log(`netkeiba 仕様チェック  horse=${HORSE_ID}\n`);

  // 1. 馬個体ページは EUC-JP。UTF-8 で読むと馬名が化けて照合が常に失敗する
  let page;
  try {
    page = await get(`https://db.netkeiba.com/horse/${HORSE_ID}/`, "euc-jp");
  } catch (e) {
    record("馬個体ページ取得", false, `${e.message}（レート制限の可能性。数分待って再試行）`);
    return finish();
  }
  record("馬個体ページ HTTP 200", page.status === 200, `status=${page.status}`);

  const h1 = page.body.match(/<div class="horse_title">[\s\S]*?<h1>([^<]+)<\/h1>/);
  record("馬名が <div class=horse_title> の <h1> から取れる", Boolean(h1), h1 ? h1[1].trim() : "取得不可");

  record(
    "EUC-JP で復号すると日本語が読める",
    Boolean(h1 && /[ぁ-んァ-ヶ一-龥]/.test(h1[1])),
    "文字化けする場合は decode 指定を確認",
  );

  record(
    "プロフィール表 db_prof_table が存在する",
    /class="[^"]*db_prof_table/.test(page.body),
  );

  // 2. 血統表は静的HTMLに無い（Ajax 後読み）。ここが「常にNULL」の主因
  record(
    "血統表は静的HTMLに含まれない（Ajax 前提で実装すべき）",
    !page.body.includes("blood_table"),
    page.body.includes("blood_table") ? "静的HTMLに存在した（仕様が戻った可能性）" : "想定どおり",
  );

  await sleep(1500);

  // 3. 血統 Ajax は UTF-8 の JSON
  const ped = await get(
    `https://db.netkeiba.com/horse/ajax_horse_pedigree.html?input=UTF-8&output=json&id=${HORSE_ID}`,
    "utf-8",
  ).catch(e => ({ status: 0, body: e.message }));
  let pedOk = false;
  try {
    const obj = JSON.parse(ped.body);
    pedOk = obj.status === "OK" && typeof obj.data === "string" && obj.data.includes("blood_table");
  } catch {
    /* noop */
  }
  record("血統 Ajax が {status:'OK', data:'<table class=blood_table>'} を返す", pedOk);

  await sleep(1500);

  // 4. 馬体写真 Ajax。id が空のプレースホルダが混在する点が要注意
  const pho = await get(
    `https://db.netkeiba.com/horse/ajax_photo_paddock.html?input=UTF-8&output=json&block_name=horse_photo_paddock_top&id=${HORSE_ID}`,
    "utf-8",
  ).catch(e => ({ status: 0, body: e.message }));
  let photoUrls = [];
  try {
    const obj = JSON.parse(pho.body);
    if (obj.status === "OK" && obj.data) {
      photoUrls = obj.data.match(/batai_img\.php\?id=\d*/g) ?? [];
    }
  } catch {
    /* noop */
  }
  const numeric = photoUrls.filter(u => /id=\d+$/.test(u));
  record(
    "画像 Ajax から id が数値のURLが取れる",
    numeric.length > 0,
    `候補 ${photoUrls.length} 件 / 数値id ${numeric.length} 件`,
  );
  if (photoUrls.length > numeric.length) {
    console.log("     ※ id= が空のプレースホルダが混在。数値idのみ採用する実装が必須");
  }

  await sleep(1500);

  // 5. レース結果ページからの ID 逆引き（1リクエストで最大18頭）
  const race = await get(RACE_URL, "euc-jp").catch(e => ({ status: 0, body: e.message }));
  const map = {};
  for (const re of [
    /<a href="\/horse\/(\d{10})\/"[^>]*>([^<]+)<\/a>/g,
    /<a href="\/horse\/(\d{10})\/"[^>]*\stitle="([^"]+)"/g,
  ]) {
    let m;
    while ((m = re.exec(race.body)) !== null) {
      const name = m[2].trim();
      if (name && !map[name]) map[name] = m[1];
    }
  }
  const count = Object.keys(map).length;
  record("レース結果ページから馬名→IDが抽出できる", count > 0, `${count} 頭`);
  if (count > 0) {
    const sample = Object.entries(map).slice(0, 3);
    for (const [n, id] of sample) console.log(`     ${n} → ${id}`);
  }

  finish();
}

function finish() {
  const ng = checks.filter(c => !c.ok);
  console.log(`\n${checks.length - ng.length}/${checks.length} 件が想定どおり`);
  if (ng.length > 0) {
    console.log("\n想定と異なる項目:");
    for (const c of ng) console.log(`  - ${c.name}`);
    console.log("\nパーサの改修が必要。references/netkeiba-contract.md を更新すること。");
    process.exit(1);
  }
  console.log("パーサは現行仕様と整合している。");
}

main().catch(e => {
  console.error("実行に失敗:", e.message);
  process.exit(1);
});
