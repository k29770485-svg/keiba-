/**
 * netkeibaから馬の詳細情報（性別・調教師・馬主・血統・画像URL）をバッチ取得
 *
 * 環境変数:
 *   DATABASE_URL - MySQL接続文字列（必須）
 *   MAX_FETCH   - 1回の実行で取得する最大数（デフォルト: 500）
 *   SLEEP_MS    - リクエスト間隔ms（デフォルト: 1500）
 *
 * ⚠ 非推奨・実行封鎖済み ⚠
 *
 * このスクリプトは馬名照合を行わないため、netkeibaId が誤っている馬に対して
 * 別馬のデータをそのまま書き込む。しかも「更新:N 失敗:0」と成功を報告するため
 * 汚染に気付けない（実測: 22頭中19頭が別馬のデータで上書きされた）。
 * 加えて血統・画像は Ajax 後読みに移行済みのため永久に NULL になる。
 *
 * 後継スキルを使うこと:
 *   /home/ubuntu/skills/keiba-horse-db-pipeline/
 *   - templates/netkeibaFetcher.ts  （名前照合・Ajax対応・レート制限対応込み）
 *   - scripts/resolve_ids_from_race.mjs （正しい netkeibaId の解決）
 *
 * どうしても本スクリプトを実行する必要がある場合のみ:
 *   I_UNDERSTAND_THIS_CORRUPTS_DATA=1 node batch_fetch_details.mjs
 */

if (process.env.I_UNDERSTAND_THIS_CORRUPTS_DATA !== '1') {
  console.error([
    '',
    '=== 実行を中止した（このスクリプトは非推奨） ===',
    '',
    '理由: 取得したページの馬名とDBの馬名を照合しないため、',
    '      netkeibaId が誤っている馬に別馬のデータを書き込む。',
    '      エラーを出さず「成功」と報告するため汚染に気付けない。',
    '',
    '代替: /home/ubuntu/skills/keiba-horse-db-pipeline/ を使用する。',
    '      1) scripts/resolve_ids_from_race.mjs で正しいIDを解決',
    '      2) templates/netkeibaFetcher.ts で名前照合付きに取得',
    '',
  ].join('\n'));
  process.exit(1);
}

// 注: 静的 import は評価順が巻き上げられ、上のガードより先に解決されてしまう。
// ガードを確実に先に効かせるため動的 import を使う。
// mysql2 は cwd（プロジェクト直下）の node_modules から解決する。
const { createRequire } = await import('module');
const { join } = await import('path');
const mysql = createRequire(join(process.cwd(), 'package.json'))('mysql2/promise');
const https = (await import('https')).default;
const { TextDecoder } = await import('util');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('DATABASE_URL is not set'); process.exit(1); }

const MAX_FETCH = parseInt(process.env.MAX_FETCH || '500');
const SLEEP_MS = parseInt(process.env.SLEEP_MS || '1500');
const BATCH_SIZE = 50;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html',
      },
      timeout: 15000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redir = res.headers.location.startsWith('http') ? res.headers.location : `https://db.netkeiba.com${res.headers.location}`;
        fetchUrl(redir).then(resolve).catch(reject);
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const body = new TextDecoder('euc-jp').decode(buf);
        resolve({ status: res.statusCode || 0, body });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function parseHorsePage(html) {
  const info = {};
  // 性別・毛色
  const titleInfo = html.match(/horse_title[\s\S]*?<p class="txt_01">([\s\S]*?)<\/p>/);
  if (titleInfo) {
    const t = titleInfo[1].replace(/<[^>]+>/g, '').trim();
    const s = t.match(/(牡|牝|セ)/); if (s) info.sex = s[1];
    const c = t.match(/(鹿毛|黒鹿毛|青鹿毛|青毛|栗毛|栃栗毛|芦毛|白毛|粕毛|河原毛|佐目毛)/);
    if (c) info.coatColor = c[1];
  }
  // 英字名
  const en = html.match(/eng_name[\s\S]*?<a[^>]*>([^<]+)<\/a>/);
  if (en) info.nameEn = en[1].trim();
  // プロフィールテーブル
  const prof = html.match(/db_prof_table[\s\S]*?<\/table>/);
  if (prof) {
    const rows = prof[0].match(/<tr>[\s\S]*?<\/tr>/g) || [];
    for (const row of rows) {
      const th = row.match(/<th[^>]*>([^<]*)<\/th>/);
      const td = row.match(/<td[^>]*>([\s\S]*?)<\/td>/);
      if (!th || !td) continue;
      const label = th[1].trim();
      const link = td[1].match(/<a[^>]*>([^<]+)<\/a>/);
      const val = link ? link[1].trim() : td[1].replace(/<[^>]+>/g, '').trim();
      if (label === '調教師') info.trainer = val;
      else if (label === '馬主') info.owner = val;
      else if (label === '生産者') info.breeder = val;
      else if (label === '生年月日') info.birthDate = val;
    }
  }
  // 血統
  const blood = html.match(/blood_table[\s\S]*?<\/table>/);
  if (blood) {
    const links = [];
    const re = /<a[^>]*>([^<]+)<\/a>/g;
    let m; while ((m = re.exec(blood[0])) !== null) links.push(m[1].trim());
    if (links[0]) info.sire = links[0];
    if (links[1]) info.dam = links[1];
    if (links[3]) info.damSire = links[3];
  }
  // 画像
  const img = html.match(/horse_photo[\s\S]*?<img[^>]+src="([^"]+)"/);
  if (img && !img[1].includes('gif_loader')) info.imageUrl = img[1];
  return info;
}

async function main() {
  const startTime = Date.now();
  console.log(`[batch-fetch] netkeibaから馬詳細バッチ取得 (最大${MAX_FETCH}頭, 間隔${SLEEP_MS}ms)`);

  const conn = await mysql.createConnection({ uri: DATABASE_URL, connectTimeout: 30000 });

  try {
    // netkeibaIdがあるが詳細未取得の馬を優先
    const [horses] = await conn.query(
      `SELECT id, name, netkeibaId FROM horses
       WHERE netkeibaId IS NOT NULL AND netkeibaId != ''
       AND (trainer IS NULL OR trainer = '')
       ORDER BY totalWins DESC LIMIT ?`, [MAX_FETCH]
    );
    console.log(`[batch-fetch] 対象: ${horses.length}頭`);

    let updated = 0, failed = 0;
    const updateBatch = [];

    for (let i = 0; i < horses.length; i++) {
      const horse = horses[i];
      try {
        const url = `https://db.netkeiba.com/horse/${horse.netkeibaId}/`;
        const res = await fetchUrl(url);
        await sleep(SLEEP_MS);
        if (res.status !== 200) { failed++; continue; }
        const details = parseHorsePage(res.body);
        if (Object.keys(details).length === 0) { failed++; continue; }
        updateBatch.push({ id: horse.id, ...details });

        if (updateBatch.length >= BATCH_SIZE) {
          await flushBatch(conn, updateBatch);
          updated += updateBatch.length;
          updateBatch.length = 0;
          console.log(`  進捗: ${i+1}/${horses.length} (更新:${updated} 失敗:${failed})`);
        }
      } catch (e) { failed++; }
    }
    if (updateBatch.length > 0) { await flushBatch(conn, updateBatch); updated += updateBatch.length; }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n[batch-fetch] 完了! 更新:${updated} 失敗:${failed} (${elapsed}秒)`);
  } finally { await conn.end(); }
}

async function flushBatch(conn, batch) {
  for (const item of batch) {
    const sets = [], values = [];
    for (const [k, v] of Object.entries(item)) {
      if (k === 'id' || !v) continue;
      sets.push(`${k} = ?`); values.push(v);
    }
    if (sets.length > 0) {
      sets.push('updatedAt = NOW()'); values.push(item.id);
      await conn.query(`UPDATE horses SET ${sets.join(', ')} WHERE id = ?`, values);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
