/**
 * horse_race_history から馬・騎手の統計を計算し、horses / jockeys を一括更新する。
 *
 * 使い方（プロジェクト直下で実行）:
 *   cd <project> && node <skill>/scripts/update_profiles.mjs
 *   cd <project> && node <skill>/scripts/update_profiles.mjs --dry-run
 *
 * mysql2 は createRequire で cwd（プロジェクト）基準に解決する。
 * スキルディレクトリに node_modules を置く必要はない。
 *
 * 設計上の約束（実測検証で不具合が出た箇所。変更する場合は必ず再検証する）:
 *  - UPDATE は主キー id で照合する。name は同名・末尾空白で衝突するため使わない
 *  - 同名が複数行ある名前は書き込まず、ambiguousName として隔離・報告する
 *  - 報告する件数は affectedRows の実測値のみ。バッチ長を成功数として加算しない
 *  - バッチ INSERT が失敗したら 1 件ずつ再試行し、問題行のみを隔離する
 *  - 失敗が 1 件以上あれば success:false と exit code 1 を返す（無人ジョブでの検知用）
 */
import { createRequire } from "module";
import path from "path";

const DRY = process.argv.includes("--dry-run");
const DATABASE_URL = process.env.DATABASE_URL;

const PAGE_SIZE = 5000;       // DB取得時のページサイズ
const BATCH_SIZE = 100;       // UPDATE/INSERTのバッチサイズ
const MIN_JOCKEY_RACES = 3;   // 騎手登録の最低出走数

/**
 * 適性スコア(0-100)。
 * winRate / top3Rate は 0-1 の比率なので winRate*60 + top3Rate*40 が既に 0-100 スケール。
 * ここに *100 を掛けると値が二重に膨張する（実測で最大 4030 を確認）。掛けてはいけない。
 */
function calcScore(races, wins, top3) {
  if (races === 0) return 50;
  const winRate = wins / races;
  const top3Rate = top3 / races;
  const score = winRate * 60 + top3Rate * 40;
  const confidence = Math.min(races / 5, 1);
  const raw = Math.round(50 + (score - 50) * confidence);
  return Math.max(0, Math.min(100, raw));
}

/**
 * surface の分類。馬側・騎手側の双方がこの関数だけを使う。
 * 「芝でなければダート」としてはいけない。NULL・空文字・障害がダート出走に混入する。
 */
const TURF = new Set(["芝", "turf"]);
const DIRT = new Set(["ダート", "dirt", "ダ"]);
function classifySurface(s) {
  if (s == null) return "unknown";
  const v = String(s).trim();
  if (TURF.has(v)) return "turf";
  if (DIRT.has(v)) return "dirt";
  return "unknown";
}

/** 照合キーの正規化。MySQL の VARCHAR 比較は末尾空白を無視するため JS 側も trim して揃える */
const normalizeKey = (s) => String(s ?? "").trim();

// 小回りコース
const SMALL_TRACK_VENUES = new Set([
  "福島", "小倉", "函館", "札幌",
  "門別", "川崎", "船橋", "浦和", "高知", "佐賀", "盛岡", "水沢", "金沢", "笠松", "名古屋", "園田", "姫路",
]);
// 直線が長いコース
const STRAIGHT_VENUES = new Set(["東京", "中京", "新潟", "大井"]);

function buildConfig(raw) {
  const u = new URL(raw);
  const cfg = {
    host: u.hostname,
    port: u.port ? Number(u.port) : 3306,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ""),
    connectTimeout: 30000,
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

/** name → id[] の対応表。同名を検出するため配列で持つ */
function buildNameIndex(rows) {
  const idx = new Map();
  for (const r of rows) {
    const key = normalizeKey(r.name);
    const arr = idx.get(key) || [];
    arr.push(r.id);
    idx.set(key, arr);
  }
  return idx;
}

async function main() {
  const startTime = Date.now();

  if (!DATABASE_URL) {
    console.error("[ERROR] DATABASE_URL が未設定。プロジェクト直下で実行しているか確認する。");
    process.exit(1);
  }

  let mysql;
  try {
    const requireFromCwd = createRequire(path.join(process.cwd(), "package.json"));
    mysql = requireFromCwd("mysql2/promise");
  } catch (e) {
    console.error("[ERROR] mysql2 を解決できない。プロジェクト直下（package.json がある場所）で実行する。");
    console.error(`        cwd=${process.cwd()} / ${e.message}`);
    process.exit(1);
  }

  console.log(`[updateProfiles] 全馬・全騎手プロフィール一括更新開始${DRY ? "（dry-run: 書き込みなし）" : ""}...`);
  const conn = await mysql.createConnection(buildConfig(DATABASE_URL));

  const failures = [];
  const rejected = { ambiguousName: [], notMatched: [], insertFailed: [] };

  try {
    // ========== Step 1: horse_race_history を分割取得 ==========
    // ORDER BY を必ず付ける。OFFSET ページングは順序が不定だと重複取得・取りこぼしを起こす
    console.log("[updateProfiles] Step 1: horse_race_history からレコードを分割取得中...");
    const [countResult] = await conn.query("SELECT COUNT(*) as cnt FROM horse_race_history");
    const totalRecords = countResult[0].cnt;
    console.log(`[updateProfiles] 総レコード数: ${totalRecords}`);

    const allRecords = [];
    for (let offset = 0; offset < totalRecords; offset += PAGE_SIZE) {
      const [rows] = await conn.query(
        `SELECT horseName, venue, distance, surface, trackCondition, finishPosition, horseCount, last3f, jockey, organizer
         FROM horse_race_history ORDER BY id LIMIT ? OFFSET ?`,
        [PAGE_SIZE, offset],
      );
      allRecords.push(...rows);
      if (totalRecords > PAGE_SIZE) console.log(`  取得済み: ${allRecords.length}/${totalRecords}`);
    }
    console.log(`[updateProfiles] ${allRecords.length}件のレース履歴を取得完了`);

    // ========== Step 2: 馬ごとに統計計算 ==========
    console.log("[updateProfiles] Step 2: 馬ごとの統計計算中...");
    const horseRecords = new Map();
    for (const rec of allRecords) {
      const key = normalizeKey(rec.horseName);
      if (!key) continue;
      const list = horseRecords.get(key) || [];
      list.push(rec);
      horseRecords.set(key, list);
    }

    const horseStatsMap = new Map();
    for (const [horseName, records] of horseRecords.entries()) {
      const totalRaces = records.length;
      const wins = records.filter((r) => r.finishPosition === 1).length;

      const turfRecs = records.filter((r) => classifySurface(r.surface) === "turf");
      const dirtRecs = records.filter((r) => classifySurface(r.surface) === "dirt");
      const turfWins = turfRecs.filter((r) => r.finishPosition === 1).length;
      const dirtWins = dirtRecs.filter((r) => r.finishPosition === 1).length;

      const heavyRecs = records.filter((r) => r.trackCondition === "重" || r.trackCondition === "不良");
      const heavyWins = heavyRecs.filter((r) => r.finishPosition === 1).length;
      const heavyTop3 = heavyRecs.filter((r) => r.finishPosition !== null && r.finishPosition <= 3).length;

      const smallRecs = records.filter((r) => SMALL_TRACK_VENUES.has(r.venue || ""));
      const smallWins = smallRecs.filter((r) => r.finishPosition === 1).length;
      const smallTop3 = smallRecs.filter((r) => r.finishPosition !== null && r.finishPosition <= 3).length;

      const straightRecs = records.filter((r) => STRAIGHT_VENUES.has(r.venue || ""));
      const straightWins = straightRecs.filter((r) => r.finishPosition === 1).length;
      const straightTop3 = straightRecs.filter((r) => r.finishPosition !== null && r.finishPosition <= 3).length;

      // 距離適性: 複勝率（3着以内）が最も高い距離帯。2走以上ある帯のみ対象
      const bands = {
        sprint: { top3: 0, runs: 0 },
        mile: { top3: 0, runs: 0 },
        middle: { top3: 0, runs: 0 },
        long: { top3: 0, runs: 0 },
      };
      for (const r of records) {
        if (!r.distance || !r.finishPosition) continue;
        let band;
        if (r.distance <= 1400) band = bands.sprint;
        else if (r.distance <= 1800) band = bands.mile;
        else if (r.distance <= 2200) band = bands.middle;
        else band = bands.long;
        band.runs++;
        if (r.finishPosition <= 3) band.top3++;
      }
      let bestDist = null;
      let bestRate = -1;
      for (const [key, val] of Object.entries(bands)) {
        if (val.runs >= 2) {
          const rate = val.top3 / val.runs;
          if (rate > bestRate) {
            bestRate = rate;
            bestDist = key;
          }
        }
      }

      // 脚質: 上がり3F平均。3件以上のデータが必要
      const last3fValues = records
        .map((r) => (r.last3f ? parseFloat(r.last3f) : NaN))
        .filter((v) => !isNaN(v) && v > 0);
      let runStyle = null;
      if (last3fValues.length >= 3) {
        const avg = last3fValues.reduce((a, b) => a + b, 0) / last3fValues.length;
        if (avg <= 34.5) runStyle = "closing";
        else if (avg <= 35.5) runStyle = "stalking";
        else if (avg <= 36.5) runStyle = "leading";
        else runStyle = "escape";
      }

      const narCount = records.filter((r) => r.organizer === "NAR").length;

      horseStatsMap.set(horseName, {
        totalWins: wins,
        totalRuns: totalRaces,
        turfWinRate: turfRecs.length > 0 ? Math.round((turfWins / turfRecs.length) * 1000) / 1000 : 0,
        dirtWinRate: dirtRecs.length > 0 ? Math.round((dirtWins / dirtRecs.length) * 1000) / 1000 : 0,
        heavyTrackScore: calcScore(heavyRecs.length, heavyWins, heavyTop3),
        smallTrackScore: calcScore(smallRecs.length, smallWins, smallTop3),
        straightScore: calcScore(straightRecs.length, straightWins, straightTop3),
        affiliation: narCount > totalRaces / 2 ? "NAR" : "JRA",
        distanceAptitude: bestRate > 0 ? bestDist : null,
        runningStyle: runStyle,
      });
    }
    console.log(`[updateProfiles] ${horseStatsMap.size}頭の統計計算完了`);

    // ========== Step 3: 既存馬の UPDATE（id 照合） ==========
    console.log("[updateProfiles] Step 3: 既存馬のUPDATE（id照合）...");
    const [existingHorses] = await conn.query("SELECT id, name FROM horses");
    const horseIndex = buildNameIndex(existingHorses);

    const toUpdate = [];
    const toInsert = [];
    for (const [name, stats] of horseStatsMap.entries()) {
      const ids = horseIndex.get(name);
      if (!ids) {
        toInsert.push([name, stats]);
        continue;
      }
      if (ids.length > 1) {
        // 同名が複数行。どの実体か判別できないので書き込まない。
        // 誤った混合値を両行に書くより、埋めずに報告するほうが被害が小さい
        rejected.ambiguousName.push({ table: "horses", name, ids });
        continue;
      }
      toUpdate.push([ids[0], name, stats]);
    }

    let horseUpdateTargets = 0;
    let horseRowsChanged = 0;
    if (!DRY) {
      for (let i = 0; i < toUpdate.length; i += BATCH_SIZE) {
        const batch = toUpdate.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(
          batch.map(async ([id, name, stats]) => {
            const setClauses = [
              "totalWins = ?", "totalRuns = ?", "turfWinRate = ?", "dirtWinRate = ?",
              "heavyTrackScore = ?", "smallTrackScore = ?", "straightScore = ?", "affiliation = ?",
            ];
            const params = [
              stats.totalWins, stats.totalRuns, stats.turfWinRate, stats.dirtWinRate,
              stats.heavyTrackScore, stats.smallTrackScore, stats.straightScore, stats.affiliation,
            ];
            if (stats.distanceAptitude) {
              setClauses.push("distanceAptitude = ?");
              params.push(stats.distanceAptitude);
            }
            if (stats.runningStyle) {
              setClauses.push("runningStyle = ?");
              params.push(stats.runningStyle);
            }
            params.push(id);
            try {
              const [r] = await conn.query(`UPDATE horses SET ${setClauses.join(", ")} WHERE id = ?`, params);
              if (r.affectedRows === 0) rejected.notMatched.push({ table: "horses", name, id });
              return r.affectedRows;
            } catch (err) {
              failures.push({ stage: "horse_update", key: name, reason: err.message?.slice(0, 200) });
              return 0;
            }
          }),
        );
        horseUpdateTargets += batch.length;
        horseRowsChanged += results.reduce((a, b) => a + b, 0);
        if (toUpdate.length > BATCH_SIZE) {
          console.log(`  馬更新: ${Math.min(i + BATCH_SIZE, toUpdate.length)}/${toUpdate.length}`);
        }
      }
    }
    console.log(
      `[updateProfiles] 馬UPDATE: 対象${DRY ? toUpdate.length : horseUpdateTargets}` +
      `${DRY ? "（dry-run）" : ` → 実変更${horseRowsChanged}行`} / 曖昧キーで拒否${rejected.ambiguousName.length}`,
    );

    // ========== Step 4: 新規馬の INSERT（失敗を沈黙させない） ==========
    console.log("[updateProfiles] Step 4: 新規馬のINSERT...");
    const HCOLS = "name, totalWins, totalRuns, turfWinRate, dirtWinRate, heavyTrackScore, smallTrackScore, straightScore, affiliation";
    const HROW = "(?, ?, ?, ?, ?, ?, ?, ?, ?)";
    const HDUP = `ON DUPLICATE KEY UPDATE
      totalWins = VALUES(totalWins), totalRuns = VALUES(totalRuns),
      turfWinRate = VALUES(turfWinRate), dirtWinRate = VALUES(dirtWinRate),
      heavyTrackScore = VALUES(heavyTrackScore), smallTrackScore = VALUES(smallTrackScore),
      straightScore = VALUES(straightScore), affiliation = VALUES(affiliation)`;
    const hFlat = ([name, s]) => [
      name, s.totalWins, s.totalRuns, s.turfWinRate, s.dirtWinRate,
      s.heavyTrackScore, s.smallTrackScore, s.straightScore, s.affiliation,
    ];

    let horseInserted = 0;
    if (!DRY) {
      for (let i = 0; i < toInsert.length; i += BATCH_SIZE) {
        const batch = toInsert.slice(i, i + BATCH_SIZE);
        if (batch.length === 0) continue;
        try {
          const [r] = await conn.query(
            `INSERT INTO horses (${HCOLS}) VALUES ${batch.map(() => HROW).join(", ")} ${HDUP}`,
            batch.flatMap(hFlat),
          );
          horseInserted += r.affectedRows;
        } catch (batchErr) {
          // バッチ全体を捨てると、不正 1 件で最大 BATCH_SIZE-1 件の正常データが沈黙して消える。
          // 1 件ずつ再試行して問題行だけを隔離する
          console.warn(`  馬バッチINSERT失敗 → 1件ずつ再試行 (${batch.length}件): ${batchErr.message?.slice(0, 80)}`);
          for (const item of batch) {
            try {
              const [r] = await conn.query(`INSERT INTO horses (${HCOLS}) VALUES ${HROW} ${HDUP}`, hFlat(item));
              horseInserted += r.affectedRows;
            } catch (rowErr) {
              rejected.insertFailed.push({
                table: "horses",
                name: String(item[0]).slice(0, 40),
                reason: rowErr.message?.slice(0, 120),
              });
              failures.push({
                stage: "horse_insert",
                key: String(item[0]).slice(0, 40),
                reason: rowErr.message?.slice(0, 200),
              });
            }
          }
        }
      }
    }
    console.log(
      `[updateProfiles] 馬INSERT: 対象${toInsert.length}` +
      `${DRY ? "（dry-run）" : ` → 書き込み${horseInserted}行 / 個別失敗${rejected.insertFailed.length}`}`,
    );

    // ========== Step 5: 騎手の統計計算 ==========
    console.log("[updateProfiles] Step 5: 騎手データ更新...");
    const jockeyMap = new Map();
    for (const rec of allRecords) {
      const key = normalizeKey(rec.jockey);
      if (!key) continue;
      const s = jockeyMap.get(key) || {
        wins: 0, races: 0, turfWins: 0, turfRaces: 0, dirtWins: 0, dirtRaces: 0,
        heavyWins: 0, heavyRaces: 0, unknownSurfaceRaces: 0, narRaces: 0,
      };
      s.races++;
      if (rec.finishPosition === 1) s.wins++;
      if (rec.organizer === "NAR") s.narRaces++;

      const cls = classifySurface(rec.surface);
      if (cls === "turf") {
        s.turfRaces++;
        if (rec.finishPosition === 1) s.turfWins++;
      } else if (cls === "dirt") {
        s.dirtRaces++;
        if (rec.finishPosition === 1) s.dirtWins++;
      } else {
        // 芝・ダートのいずれでもない。勝率の分母に入れない
        s.unknownSurfaceRaces++;
      }

      if (rec.trackCondition === "重" || rec.trackCondition === "不良") {
        s.heavyRaces++;
        if (rec.finishPosition === 1) s.heavyWins++;
      }
      jockeyMap.set(key, s);
    }
    console.log(`[updateProfiles] ${jockeyMap.size}名の騎手統計計算完了`);

    const rate = (w, r) => (r > 0 ? Math.round((w / r) * 1000) / 1000 : 0);
    // 騎手の所属も馬と同じく履歴から算出する。固定値を書いてはいけない
    const jockeyAffiliation = (s) => (s.narRaces > s.races / 2 ? "NAR" : "JRA");

    const [existingJockeys] = await conn.query("SELECT id, name FROM jockeys");
    const jockeyIndex = buildNameIndex(existingJockeys);

    const jToUpdate = [];
    const jToInsert = [];
    for (const [name, s] of jockeyMap.entries()) {
      if (s.races < MIN_JOCKEY_RACES) continue;
      const ids = jockeyIndex.get(name);
      if (!ids) {
        jToInsert.push([name, s]);
        continue;
      }
      if (ids.length > 1) {
        rejected.ambiguousName.push({ table: "jockeys", name, ids });
        continue;
      }
      jToUpdate.push([ids[0], name, s]);
    }

    let jockeyRowsChanged = 0;
    if (!DRY) {
      for (let i = 0; i < jToUpdate.length; i += BATCH_SIZE) {
        const batch = jToUpdate.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(
          batch.map(async ([id, name, s]) => {
            try {
              // affiliation を UPDATE 対象に含める。含めないと誤った所属が恒久化する
              const [r] = await conn.query(
                "UPDATE jockeys SET affiliation = ?, totalWins = ?, overallWinRate = ?, turfWinRate = ?, dirtWinRate = ?, heavyTrackWinRate = ? WHERE id = ?",
                [
                  jockeyAffiliation(s), s.wins, rate(s.wins, s.races),
                  rate(s.turfWins, s.turfRaces), rate(s.dirtWins, s.dirtRaces),
                  rate(s.heavyWins, s.heavyRaces), id,
                ],
              );
              if (r.affectedRows === 0) rejected.notMatched.push({ table: "jockeys", name, id });
              return r.affectedRows;
            } catch (err) {
              failures.push({ stage: "jockey_update", key: name, reason: err.message?.slice(0, 200) });
              return 0;
            }
          }),
        );
        jockeyRowsChanged += results.reduce((a, b) => a + b, 0);
      }
    }
    console.log(
      `[updateProfiles] 騎手UPDATE: 対象${jToUpdate.length}` +
      `${DRY ? "（dry-run）" : ` → 実変更${jockeyRowsChanged}行`}`,
    );

    // ========== Step 6: 新規騎手の INSERT ==========
    const JCOLS = "name, affiliation, totalWins, overallWinRate, turfWinRate, dirtWinRate, heavyTrackWinRate";
    const JROW = "(?, ?, ?, ?, ?, ?, ?)";
    const JDUP = `ON DUPLICATE KEY UPDATE
      affiliation = VALUES(affiliation), totalWins = VALUES(totalWins), overallWinRate = VALUES(overallWinRate),
      turfWinRate = VALUES(turfWinRate), dirtWinRate = VALUES(dirtWinRate), heavyTrackWinRate = VALUES(heavyTrackWinRate)`;
    const jFlat = ([name, s]) => [
      name, jockeyAffiliation(s), s.wins, rate(s.wins, s.races),
      rate(s.turfWins, s.turfRaces), rate(s.dirtWins, s.dirtRaces), rate(s.heavyWins, s.heavyRaces),
    ];

    let jockeyInserted = 0;
    if (!DRY) {
      for (let i = 0; i < jToInsert.length; i += BATCH_SIZE) {
        const batch = jToInsert.slice(i, i + BATCH_SIZE);
        if (batch.length === 0) continue;
        try {
          const [r] = await conn.query(
            `INSERT INTO jockeys (${JCOLS}) VALUES ${batch.map(() => JROW).join(", ")} ${JDUP}`,
            batch.flatMap(jFlat),
          );
          jockeyInserted += r.affectedRows;
        } catch (batchErr) {
          console.warn(`  騎手バッチINSERT失敗 → 1件ずつ再試行 (${batch.length}件): ${batchErr.message?.slice(0, 80)}`);
          for (const item of batch) {
            try {
              const [r] = await conn.query(`INSERT INTO jockeys (${JCOLS}) VALUES ${JROW} ${JDUP}`, jFlat(item));
              jockeyInserted += r.affectedRows;
            } catch (rowErr) {
              rejected.insertFailed.push({
                table: "jockeys",
                name: String(item[0]).slice(0, 40),
                reason: rowErr.message?.slice(0, 120),
              });
              failures.push({
                stage: "jockey_insert",
                key: String(item[0]).slice(0, 40),
                reason: rowErr.message?.slice(0, 200),
              });
            }
          }
        }
      }
    }
    console.log(
      `[updateProfiles] 騎手INSERT: 対象${jToInsert.length}` +
      `${DRY ? "（dry-run）" : ` → 書き込み${jockeyInserted}行`}`,
    );

    // ========== 完了サマリー（実測値のみを報告する） ==========
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const summary = {
      success: failures.length === 0,
      dryRun: DRY,
      elapsed: `${elapsed}s`,
      horses: {
        updateTargets: DRY ? toUpdate.length : horseUpdateTargets,
        rowsChanged: horseRowsChanged,
        insertTargets: toInsert.length,
        insertedRows: horseInserted,
        total: horseStatsMap.size,
      },
      jockeys: {
        updateTargets: jToUpdate.length,
        rowsChanged: jockeyRowsChanged,
        insertTargets: jToInsert.length,
        insertedRows: jockeyInserted,
        total: jockeyMap.size,
      },
      rejected: {
        ambiguousName: rejected.ambiguousName.length,
        notMatched: rejected.notMatched.length,
        insertFailed: rejected.insertFailed.length,
      },
      failures: failures.length,
      failureDetail: failures.slice(0, 20),
      rejectedDetail: {
        ambiguousName: rejected.ambiguousName.slice(0, 20),
        insertFailed: rejected.insertFailed.slice(0, 20),
      },
    };

    console.log("\n========================================");
    console.log(
      `[updateProfiles] ${DRY ? "dry-run 完了（書き込みなし）" : summary.success ? "完了（失敗なし）" : `完了（失敗 ${failures.length} 件あり）`}`,
    );
    console.log(`  処理時間: ${elapsed}秒`);
    console.log(`  馬: UPDATE対象${summary.horses.updateTargets} → 実変更${horseRowsChanged}行 / INSERT対象${toInsert.length} → ${horseInserted}行`);
    console.log(`  騎手: UPDATE対象${jToUpdate.length} → 実変更${jockeyRowsChanged}行 / INSERT対象${jToInsert.length} → ${jockeyInserted}行`);
    console.log(`  書き込み拒否: 曖昧キー${rejected.ambiguousName.length} / 未一致${rejected.notMatched.length} / INSERT失敗${rejected.insertFailed.length}`);
    if (rejected.ambiguousName.length > 0) {
      console.log("  ※ 曖昧キーは同名レコードが複数あるため書き込まなかった。手動での名寄せが必要:");
      for (const a of rejected.ambiguousName.slice(0, 5)) {
        console.log(`     ${a.table}: ${a.name} (id=${a.ids.join(",")})`);
      }
    }
    if (rejected.insertFailed.length > 0) {
      console.log("  ※ INSERT失敗の内訳:");
      for (const f of rejected.insertFailed.slice(0, 5)) {
        console.log(`     ${f.table}: ${f.name} — ${f.reason}`);
      }
    }
    console.log("========================================\n");
    console.log(JSON.stringify(summary));

    await conn.end();
    process.exit(summary.success ? 0 : 1);
  } catch (error) {
    console.error("[updateProfiles] エラー:", error);
    await conn.end();
    process.exit(1);
  }
}

main();
