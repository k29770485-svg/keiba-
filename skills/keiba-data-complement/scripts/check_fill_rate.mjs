/**
 * 枠番充填率チェック（簡易版）
 * 補完スクリプト実行前後に使用して進捗を確認
 *
 * 使い方:
 *   cd <project-dir> && node scripts/check_fill_rate.mjs
 */
import mysql from 'mysql2/promise';
import { config } from 'dotenv';
config();

async function main() {
  const conn = await mysql.createConnection(process.env.DATABASE_URL);

  const [stats] = await conn.query(`
    SELECT venue, organizer,
      COUNT(*) as total,
      SUM(CASE WHEN bracketNumber > 0 THEN 1 ELSE 0 END) as filled,
      SUM(CASE WHEN bracketNumber = 0 OR bracketNumber IS NULL THEN 1 ELSE 0 END) as missing
    FROM horse_race_history
    GROUP BY venue, organizer
    ORDER BY organizer, venue
  `);

  console.log('=== 枠番充填率 ===');
  console.log('区分 | 会場     | 充填済 / 全体    | 充填率  | 残り');
  console.log('-----|----------|-----------------|---------|------');

  let totalAll = 0, filledAll = 0;
  for (const s of stats) {
    const total = parseInt(s.total);
    const filled = parseInt(s.filled);
    const missing = parseInt(s.missing);
    const rate = (filled / total * 100).toFixed(1);
    totalAll += total;
    filledAll += filled;
    console.log(`${s.organizer.padEnd(4)} | ${s.venue.padEnd(8)} | ${String(filled).padStart(5)}/${String(total).padStart(5)} | ${rate.padStart(5)}% | ${missing}`);
  }

  console.log('-----|----------|-----------------|---------|------');
  console.log(`全体 |          | ${String(filledAll).padStart(5)}/${String(totalAll).padStart(5)} | ${(filledAll/totalAll*100).toFixed(1).padStart(5)}% | ${totalAll - filledAll}`);

  // 残りレース数
  const [pending] = await conn.query(`
    SELECT COUNT(DISTINCT raceId) as cnt
    FROM horse_race_history
    WHERE (bracketNumber = 0 OR bracketNumber IS NULL)
      AND raceId IS NOT NULL AND raceId != ''
  `);
  console.log(`\n未補完レース数: ${pending[0].cnt}`);
  console.log(`推定所要時間: ${Math.ceil(parseInt(pending[0].cnt) * 1.2 / 60)}分`);

  await conn.end();
}

main().catch(e => { console.error(e); process.exit(1); });
