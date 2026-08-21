/**
 * 枠順有利不利テスト（全会場対応）
 * 枠番データ補完完了後に実行し、各会場×コースの枠順バイアスを検証
 *
 * 使い方:
 *   cd <project-dir> && node scripts/test_gate_bias.mjs
 *
 * 出力:
 *   - 全会場の荒れ頻度比較
 *   - JRA/NAR各会場の主要コースにおける枠順有利不利
 *   - 仮想レース予想テスト
 */
import mysql from 'mysql2/promise';
import { config } from 'dotenv';
config();

async function main() {
  const conn = await mysql.createConnection(process.env.DATABASE_URL);

  console.log('=== 枠順有利不利テスト ===\n');

  // 1. 全会場の荒れ頻度比較
  console.log('【1】全会場 荒れ頻度比較');
  console.log('─'.repeat(60));
  const [upsetAll] = await conn.execute(`
    SELECT
      venue, organizer,
      COUNT(DISTINCT raceId) as total_races,
      SUM(CASE WHEN finishPosition = 1 AND popularity >= 4 THEN 1 ELSE 0 END) as upset_wins,
      SUM(CASE WHEN finishPosition <= 3 AND popularity >= 6 THEN 1 ELSE 0 END) as big_upset_top3
    FROM horse_race_history
    WHERE finishPosition IS NOT NULL AND finishPosition > 0
    GROUP BY venue, organizer
    ORDER BY organizer, upset_wins / COUNT(DISTINCT raceId) DESC
  `);

  console.log('  区分  | 会場     | レース数 | 穴勝ち率 | 大穴入線 | 判定');
  console.log('  ------|----------|----------|----------|----------|--------');
  for (const v of upsetAll) {
    const races = parseInt(v.total_races);
    const upsets = parseInt(v.upset_wins);
    const bigUpsets = parseInt(v.big_upset_top3);
    const rate = races > 0 ? (upsets / races * 100).toFixed(1) : '0.0';
    const label = parseFloat(rate) > 25 ? '大穴狙い' : parseFloat(rate) > 15 ? '穴狙い' : '堅い';
    console.log(`  ${v.organizer.padEnd(5)} | ${v.venue.padEnd(8)} | ${String(races).padStart(8)} | ${rate.padStart(6)}% | ${String(bigUpsets).padStart(8)} | ${label}`);
  }

  // 2. 各会場の枠順有利不利
  console.log('\n【2】各会場 枠順有利不利（主要コース）');
  console.log('─'.repeat(60));

  const [venues] = await conn.execute(`
    SELECT DISTINCT venue, organizer FROM horse_race_history
    WHERE bracketNumber > 0
    ORDER BY organizer, venue
  `);

  for (const { venue, organizer } of venues) {
    const [topCourse] = await conn.execute(`
      SELECT distance, surface, COUNT(*) as cnt
      FROM horse_race_history
      WHERE venue = ? AND bracketNumber > 0
      GROUP BY distance, surface
      ORDER BY cnt DESC
      LIMIT 1
    `, [venue]);

    if (topCourse.length === 0) continue;

    const { distance, surface } = topCourse[0];
    const surfaceLabel = surface === 'turf' ? '芝' : 'ダート';

    const [gateData] = await conn.execute(`
      SELECT
        bracketNumber as gateNum,
        COUNT(*) as runs,
        SUM(CASE WHEN finishPosition = 1 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN finishPosition <= 3 THEN 1 ELSE 0 END) as top3
      FROM horse_race_history
      WHERE venue = ? AND distance = ? AND surface = ?
        AND bracketNumber > 0 AND finishPosition > 0
      GROUP BY bracketNumber
      ORDER BY bracketNumber
    `, [venue, distance, surface]);

    if (gateData.length === 0) continue;

    const avgWinRate = gateData.reduce((s, g) => s + (g.runs > 0 ? g.wins/g.runs : 0), 0) / gateData.length;

    let bestGate = null, bestBonus = -999;
    let worstGate = null, worstBonus = 999;

    for (const g of gateData) {
      const runs = parseInt(g.runs);
      const wins = parseInt(g.wins);
      const bonus = runs >= 10 ? Math.round((wins/runs - avgWinRate) * 100) : 0;
      if (bonus > bestBonus) { bestBonus = bonus; bestGate = g.gateNum; }
      if (bonus < worstBonus) { worstBonus = bonus; worstGate = g.gateNum; }
    }

    const totalRuns = gateData.reduce((s, g) => s + parseInt(g.runs), 0);
    console.log(`  ${organizer.padEnd(4)} ${venue.padEnd(6)} ${surfaceLabel}${distance}m (n=${totalRuns}) → 最有利:${bestGate}枠(+${bestBonus}) / 最不利:${worstGate}枠(${worstBonus})`);
  }

  // 3. 充填率サマリー
  console.log('\n【3】枠番充填率サマリー');
  console.log('─'.repeat(60));
  const [fillStats] = await conn.execute(`
    SELECT venue, organizer,
      COUNT(*) as total,
      SUM(CASE WHEN bracketNumber > 0 THEN 1 ELSE 0 END) as filled
    FROM horse_race_history
    GROUP BY venue, organizer
    ORDER BY organizer, venue
  `);

  let totalAll = 0, filledAll = 0;
  for (const s of fillStats) {
    const rate = (parseInt(s.filled) / parseInt(s.total) * 100).toFixed(1);
    totalAll += parseInt(s.total);
    filledAll += parseInt(s.filled);
    console.log(`  ${s.organizer} ${s.venue}: ${s.filled}/${s.total} (${rate}%)`);
  }
  console.log(`  ─── 全体: ${filledAll}/${totalAll} (${(filledAll/totalAll*100).toFixed(1)}%)`);

  console.log('\n=== テスト完了 ===');
  await conn.end();
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
