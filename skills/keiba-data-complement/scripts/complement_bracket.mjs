/**
 * 全会場の枠番（bracketNumber）・馬番（horseNumber）を補完するスクリプト
 * netkeibaのレース結果ページからスクレイピングして取得
 *
 * 使い方:
 *   cd <project-dir> && node scripts/complement_bracket.mjs
 *
 * 前提:
 *   - DATABASE_URL環境変数が設定されていること（.envまたはプロセス環境）
 *   - horse_race_historyテーブルにraceId, horseName, organizer列が存在すること
 *   - mysql2パッケージがインストールされていること
 *
 * 注意:
 *   - BATCH_SIZEを500に設定（1回の実行で500レースまで処理）
 *   - 全レース完了まで複数回実行が必要な場合あり
 *   - DELAY_MSを1200ms以上に設定してレート制限を回避
 */
import mysql from 'mysql2/promise';
import { config } from 'dotenv';
config();

const DELAY_MS = 1200; // レート制限対策（最低1200ms推奨）
const BATCH_SIZE = 500; // 一度に取得するレースID数

/**
 * netkeibaからレース結果ページをフェッチし、枠番・馬番・馬名を抽出
 * @param {string} raceId - レースID（例: 202603020807）
 * @param {string} organizer - 'JRA' or 'NAR'
 * @returns {Array|null} [{bracket, horseNum, horseName}, ...] or null
 */
async function fetchRaceBrackets(raceId, organizer) {
  // JRA: https://db.netkeiba.com/race/{raceId}/
  // NAR: https://nar.netkeiba.com/race/result.html?race_id={raceId}
  let url;
  if (organizer === 'JRA') {
    url = `https://db.netkeiba.com/race/${raceId}/`;
  } else {
    url = `https://nar.netkeiba.com/race/result.html?race_id=${raceId}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Language': 'ja,en;q=0.9'
      }
    });
    clearTimeout(timeout);

    if (!res.ok) return null;

    const buf = await res.arrayBuffer();
    // JRAはEUC-JP、NARはUTF-8
    let html;
    if (organizer === 'JRA') {
      const decoder = new TextDecoder('euc-jp');
      html = decoder.decode(buf);
    } else {
      html = new TextDecoder('utf-8').decode(buf);
    }

    // レース結果テーブルから枠番・馬番を抽出
    const results = [];
    const rowRegex = /<tr[^>]*>[\s\S]*?<\/tr>/gi;
    const rows = html.match(rowRegex) || [];

    for (const row of rows) {
      if (row.includes('<th')) continue;

      const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      const tds = [];
      let m;
      while ((m = tdRegex.exec(row)) !== null) {
        tds.push(m[1].replace(/<[^>]+>/g, '').trim());
      }

      if (tds.length >= 4) {
        // ★重要: td[0]=着順, td[1]=枠番, td[2]=馬番
        // td[0]を枠番と誤認しないこと！
        const bracket = parseInt(tds[1]);
        const horseNum = parseInt(tds[2]);
        const nameMatch = row.match(/horse\/[^"]*"[^>]*>([^<]+)/);
        const horseName = nameMatch ? nameMatch[1].trim() : '';

        if (bracket > 0 && horseNum > 0 && horseName) {
          results.push({ bracket, horseNum, horseName });
        }
      }
    }

    return results.length > 0 ? results : null;
  } catch (e) {
    clearTimeout(timeout);
    return null;
  }
}

async function main() {
  const conn = await mysql.createConnection(process.env.DATABASE_URL);

  // 未補完のレースIDを取得（JRA優先→NAR）
  const [pendingRaces] = await conn.query(`
    SELECT DISTINCT raceId, organizer, venue
    FROM horse_race_history
    WHERE (bracketNumber = 0 OR bracketNumber IS NULL)
      AND raceId IS NOT NULL AND raceId != ''
    ORDER BY
      CASE WHEN organizer = 'JRA' THEN 0 ELSE 1 END,
      raceId DESC
    LIMIT ${BATCH_SIZE}
  `);

  console.log(`=== 枠番補完開始: ${pendingRaces.length}レース ===`);

  if (pendingRaces.length === 0) {
    console.log('補完対象なし。全レースの枠番が入力済みです。');
    await conn.end();
    return;
  }

  let successCount = 0;
  let failCount = 0;
  let updatedRows = 0;

  for (let i = 0; i < pendingRaces.length; i++) {
    const { raceId, organizer, venue } = pendingRaces[i];

    const results = await fetchRaceBrackets(raceId, organizer);

    if (results && results.length > 0) {
      for (const { bracket, horseNum, horseName } of results) {
        const [updateResult] = await conn.query(
          `UPDATE horse_race_history
           SET bracketNumber = ?, horseNumber = ?
           WHERE raceId = ? AND horseName = ? AND (bracketNumber = 0 OR bracketNumber IS NULL)`,
          [bracket, horseNum, raceId, horseName]
        );
        updatedRows += updateResult.affectedRows;
      }
      successCount++;
    } else {
      failCount++;
    }

    if ((i + 1) % 20 === 0) {
      console.log(`[${i + 1}/${pendingRaces.length}] ${venue}(${organizer}) 成功:${successCount} 失敗:${failCount} 更新行:${updatedRows}`);
    }

    await new Promise(r => setTimeout(r, DELAY_MS));
  }

  console.log(`\n=== 完了 ===`);
  console.log(`成功: ${successCount}レース`);
  console.log(`失敗: ${failCount}レース`);
  console.log(`更新行数: ${updatedRows}`);

  // 充填率を表示
  const [stats] = await conn.query(`
    SELECT venue, organizer,
      COUNT(*) as total,
      SUM(CASE WHEN bracketNumber > 0 THEN 1 ELSE 0 END) as filled
    FROM horse_race_history
    GROUP BY venue, organizer
    ORDER BY organizer, venue
  `);

  console.log('\n--- 充填率 ---');
  for (const s of stats) {
    const rate = (s.filled / s.total * 100).toFixed(1);
    console.log(`  ${s.organizer} ${s.venue}: ${s.filled}/${s.total} (${rate}%)`);
  }

  await conn.end();
}

main().catch(e => { console.error(e); process.exit(1); });
