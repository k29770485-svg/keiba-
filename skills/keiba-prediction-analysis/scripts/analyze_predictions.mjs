/**
 * 競馬予想的中率分析スクリプト
 *
 * 使用方法:
 *   cd <project-dir> && node <this-script> [--date YYYY-MM-DD] [--range N]
 *
 * オプション:
 *   --date   分析対象の終了日（デフォルト: 今日）
 *   --range  分析対象の日数（デフォルト: 2）
 *
 * 必要環境変数: DATABASE_URL
 */
import mysql from './node_modules/mysql2/promise.js';

// --- 設定 ---
const args = process.argv.slice(2);
const dateIdx = args.indexOf('--date');
const rangeIdx = args.indexOf('--range');
const endDate = dateIdx >= 0 ? args[dateIdx + 1] : new Date().toISOString().split('T')[0];
const rangeDays = rangeIdx >= 0 ? parseInt(args[rangeIdx + 1]) : 2;

const startDate = new Date(endDate);
startDate.setDate(startDate.getDate() - rangeDays + 1);
const startDateStr = startDate.toISOString().split('T')[0];

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error("DATABASE_URL not set"); process.exit(1); }

const url = new URL(DATABASE_URL);
const conn = await mysql.createConnection({
  host: url.hostname,
  port: parseInt(url.port) || 4000,
  user: url.username,
  password: decodeURIComponent(url.password),
  database: url.pathname.slice(1),
  ssl: { rejectUnauthorized: true }
});

console.log(`\n分析期間: ${startDateStr} 〜 ${endDate}\n`);

// --- 1. 日別的中率 ---
const [hitRate] = await conn.execute(`
  SELECT raceDate, COUNT(*) as total,
    SUM(CASE WHEN isHit = 1 THEN 1 ELSE 0 END) as hits,
    ROUND(SUM(CASE WHEN isHit = 1 THEN 1 ELSE 0 END) / COUNT(*) * 100, 1) as hit_rate
  FROM race_results WHERE raceDate BETWEEN ? AND ?
  GROUP BY raceDate ORDER BY raceDate
`, [startDateStr, endDate]);

console.log("━━━ 日別的中率 ━━━");
for (const r of hitRate) {
  console.log(`  ${r.raceDate}: ${r.hits}/${r.total} (${r.hit_rate}%)`);
}

// --- 2. 予想vs実際の突合 ---
const [comparison] = await conn.execute(`
  SELECT rr.raceDate, rr.raceName, rr.venue, rr.isHit,
    rr.actual1st, rr.actual2nd, rr.actual3rd,
    rr.trifectaPayout, rr.trioBoxPayout,
    rar.predicted1st, rar.predicted2nd, rar.predicted3rd,
    rar.weather, rar.trackCondition, rar.surface, rar.distance,
    rar.analysisJson
  FROM race_results rr
  JOIN race_analysis_results rar ON rr.analysisId = rar.id
  WHERE rr.raceDate BETWEEN ? AND ?
  ORDER BY rr.raceDate, rr.id
`, [startDateStr, endDate]);

let stats = { total: 0, hits: 0, overlap: [0,0,0,0], pred1stIn3: 0, pred1stWon: 0 };
let scoreStats = { base: 0, course: 0, history: 0, aptitude: 0, count: 0 };
let missedOdds = [];
let byVenue = {}, byTrack = {}, payoutsByDate = {};

for (const r of comparison) {
  stats.total++;
  if (r.isHit === 1) stats.hits++;

  const predicted = [r.predicted1st, r.predicted2nd, r.predicted3rd].filter(Boolean);
  const actual = [r.actual1st, r.actual2nd, r.actual3rd].filter(Boolean);
  const overlap = predicted.filter(p => actual.includes(p));
  stats.overlap[overlap.length]++;

  if (r.predicted1st && actual.includes(r.predicted1st)) stats.pred1stIn3++;
  if (r.predicted1st === r.actual1st) stats.pred1stWon++;

  // 会場別
  if (!byVenue[r.venue]) byVenue[r.venue] = { total: 0, hits: 0 };
  byVenue[r.venue].total++;
  if (r.isHit === 1) byVenue[r.venue].hits++;

  // 馬場別
  const tk = r.trackCondition || '不明';
  if (!byTrack[tk]) byTrack[tk] = { total: 0, hits: 0 };
  byTrack[tk].total++;
  if (r.isHit === 1) byTrack[tk].hits++;

  // 配当
  if (!payoutsByDate[r.raceDate]) payoutsByDate[r.raceDate] = [];
  if (r.trifectaPayout) payoutsByDate[r.raceDate].push(r.trifectaPayout);

  // スコア分析
  if (r.analysisJson) {
    try {
      const analysis = JSON.parse(r.analysisJson);
      if (Array.isArray(analysis)) {
        for (const a of analysis.slice(0, 3)) {
          scoreStats.base += a.baseScore || 0;
          scoreStats.course += a.courseBonus || 0;
          scoreStats.history += a.historyBonus || 0;
          scoreStats.aptitude += a.aptitudeBonus || 0;
          scoreStats.count++;
        }
        if (r.isHit !== 1 && analysis[0]?.odds) {
          missedOdds.push(analysis[0].odds);
        }
      }
    } catch {}
  }
}

// --- 3. 出力 ---
console.log("\n━━━ 的中精度サマリー ━━━");
console.log(`  総レース: ${stats.total} | 的中: ${stats.hits} (${(stats.hits/stats.total*100).toFixed(1)}%)`);
console.log(`  3頭一致: ${stats.overlap[3]} | 2頭: ${stats.overlap[2]} | 1頭: ${stats.overlap[1]} | 0頭: ${stats.overlap[0]}`);
console.log(`  予想◎が3着以内: ${stats.pred1stIn3}/${stats.total} (${(stats.pred1stIn3/stats.total*100).toFixed(1)}%)`);

console.log("\n━━━ 会場別 ━━━");
for (const [v, d] of Object.entries(byVenue)) {
  console.log(`  ${v}: ${d.hits}/${d.total} (${(d.hits/d.total*100).toFixed(1)}%)`);
}

console.log("\n━━━ 馬場状態別 ━━━");
for (const [t, d] of Object.entries(byTrack)) {
  console.log(`  ${t}: ${d.hits}/${d.total} (${(d.hits/d.total*100).toFixed(1)}%)`);
}

console.log("\n━━━ 3連単配当（荒れ具合） ━━━");
for (const [date, payouts] of Object.entries(payoutsByDate)) {
  if (!payouts.length) continue;
  const avg = payouts.reduce((a, b) => a + b, 0) / payouts.length;
  const manba = payouts.filter(p => p >= 10000).length;
  console.log(`  ${date}: 平均${Math.round(avg)}円 | 万馬券${manba}/${payouts.length} (${(manba/payouts.length*100).toFixed(0)}%)`);
}

console.log("\n━━━ アルゴリズム診断 ━━━");
if (scoreStats.count > 0) {
  const total = scoreStats.base + scoreStats.course + scoreStats.history + scoreStats.aptitude;
  console.log(`  baseScore(オッズ): ${(scoreStats.base/scoreStats.count).toFixed(1)} (${(scoreStats.base/total*100).toFixed(0)}%)`);
  console.log(`  courseBonus: ${(scoreStats.course/scoreStats.count).toFixed(1)} (${(scoreStats.course/total*100).toFixed(0)}%)`);
  console.log(`  historyBonus: ${(scoreStats.history/scoreStats.count).toFixed(1)} (${(scoreStats.history/total*100).toFixed(0)}%)`);
  console.log(`  aptitudeBonus: ${(scoreStats.aptitude/scoreStats.count).toFixed(1)} (${(scoreStats.aptitude/total*100).toFixed(0)}%)`);
}

if (missedOdds.length > 0) {
  const avg = missedOdds.reduce((a, b) => a + b, 0) / missedOdds.length;
  const low = missedOdds.filter(o => o <= 3.0).length;
  console.log(`\n  外れ◎の平均オッズ: ${avg.toFixed(1)}`);
  console.log(`  低オッズ(≤3.0)で外れ: ${low}/${missedOdds.length} (${(low/missedOdds.length*100).toFixed(0)}%)`);
}

// --- 4. 直近1週間推移 ---
const weekStart = new Date(endDate);
weekStart.setDate(weekStart.getDate() - 7);
const [weekly] = await conn.execute(`
  SELECT raceDate, COUNT(*) as total,
    SUM(CASE WHEN isHit = 1 THEN 1 ELSE 0 END) as hits,
    ROUND(SUM(CASE WHEN isHit = 1 THEN 1 ELSE 0 END) / COUNT(*) * 100, 1) as hit_rate
  FROM race_results WHERE raceDate BETWEEN ? AND ?
  GROUP BY raceDate ORDER BY raceDate
`, [weekStart.toISOString().split('T')[0], endDate]);

console.log("\n━━━ 直近1週間推移 ━━━");
for (const r of weekly) {
  const bar = "█".repeat(Math.round(parseFloat(r.hit_rate) / 5));
  console.log(`  ${r.raceDate}: ${r.hits}/${r.total} (${r.hit_rate}%) ${bar}`);
}

await conn.end();
