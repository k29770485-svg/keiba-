/**
 * horse_race_historyテーブルから馬の基本情報（馬体重・所属）をhorsesテーブルへ一括補完
 * 外部アクセス不要・クレジット消費ゼロで実行可能
 *
 * 【非推奨】後継スキルの同名スクリプトを使うこと:
 *   /home/ubuntu/skills/keiba-horse-db-pipeline/scripts/supplement_from_history.mjs
 *   （通算成績の算出、--dry-run、SSL付き接続文字列への対応が追加されている）
 *
 * 本スクリプトは外部アクセスを行わないため実行自体は安全だが、機能が少ない。
 * また `uri:` 形式の接続は `?ssl={...}` 付きURLでハングすることがある。
 */
import mysql from 'mysql2/promise';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

async function main() {
  const startTime = Date.now();
  console.log("[supplement] horse_race_historyからの基本情報補完開始...");

  const conn = await mysql.createConnection({
    uri: DATABASE_URL,
    connectTimeout: 30000,
  });

  try {
    // 1. 最新馬体重の補完
    console.log("[supplement] 最新馬体重を補完中...");
    const [weightResult] = await conn.query(`
      UPDATE horses h
      JOIN (
        SELECT horseName, horseWeight
        FROM horse_race_history
        WHERE horseWeight IS NOT NULL AND horseWeight > 0
        AND id IN (
          SELECT MAX(id) FROM horse_race_history
          WHERE horseWeight IS NOT NULL AND horseWeight > 0
          GROUP BY horseName
        )
      ) latest ON h.name = latest.horseName
      SET h.weight = latest.horseWeight, h.updatedAt = NOW()
      WHERE h.weight IS NULL OR h.weight = 0
    `);
    console.log(`  馬体重更新: ${weightResult.affectedRows}頭`);

    // 2. 所属（JRA/NAR）の補完
    console.log("[supplement] 所属（affiliation）を補完中...");
    const [affResult] = await conn.query(`
      UPDATE horses h
      JOIN (
        SELECT horseName,
          CASE WHEN venue IN ('東京','中山','阪神','京都','中京','小倉','新潟','福島','函館','札幌') THEN 'JRA' ELSE 'NAR' END as aff
        FROM horse_race_history
        WHERE id IN (
          SELECT MAX(id) FROM horse_race_history GROUP BY horseName
        )
      ) latest ON h.name = latest.horseName
      SET h.affiliation = latest.aff, h.updatedAt = NOW()
      WHERE h.affiliation IS NULL OR h.affiliation = ''
    `);
    console.log(`  所属更新: ${affResult.affectedRows}頭`);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n[supplement] 完了! (${elapsed}秒)`);

  } catch (error) {
    console.error("[supplement] エラー:", error.message);
    process.exit(1);
  } finally {
    await conn.end();
  }
}

main();
