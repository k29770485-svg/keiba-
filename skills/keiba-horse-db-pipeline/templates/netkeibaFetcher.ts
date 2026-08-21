/**
 * netkeiba 馬詳細取得モジュール
 *
 * 重要な安全機構:
 *   取得したページの馬名と DB 上の馬名を照合し、不一致なら書き込みを拒否する。
 *   netkeibaId の紐付けが誤っていると、そのIDのページ内容が
 *   別馬の行にそのまま書き込まれて DB が静かに汚染されるため。
 *
 * netkeiba の仕様上の注意:
 *   - 馬個体ページは EUC-JP
 *   - 血統表と馬体写真は Ajax 後読み（UTF-8 の JSON）で、静的HTMLには含まれない
 */
import https from "https";
import { TextDecoder } from "util";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

export const NETKEIBA_REFERER = "https://db.netkeiba.com/";

export type FetchResult = {
  status: number;
  body: string;
  finalUrl: string;
  redirected: boolean;
};

export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * netkeiba は短時間に多数のリクエストを送ると、HTTPステータスを返す前に
 * TLS ハンドシェイク段階で接続を切ってくる。この形のエラーは
 * 「取得対象が存在しない」ではなく「レート制限にかかった」ことを意味するため、
 * 呼び出し側が区別できるようにフラグを立てる。
 */
export class RateLimitedError extends Error {
  readonly rateLimited = true;
  constructor(cause: string) {
    super(`netkeiba側から接続を拒否されました（レート制限の可能性）: ${cause}`);
    this.name = "RateLimitedError";
  }
}

const RATE_LIMIT_SIGNS = [
  "socket disconnected before secure TLS",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "socket hang up",
];

export function isRateLimitError(err: unknown): boolean {
  if (err instanceof RateLimitedError) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return RATE_LIMIT_SIGNS.some(s => msg.includes(s));
}

/** EUC-JP / UTF-8 を切り替えられる HTTP GET。相対 Location も正しく解決する */
export function fetchUrl(
  url: string,
  opts: { decode?: "euc-jp" | "utf-8"; depth?: number } = {},
): Promise<FetchResult> {
  const { decode = "euc-jp", depth = 0 } = opts;
  return new Promise((resolve, reject) => {
    if (depth > 3) return reject(new Error("too many redirects"));
    const req = https.get(
      url,
      {
        headers: { "User-Agent": UA, Accept: "text/html,application/json" },
        timeout: 15000,
      },
      res => {
        const code = res.statusCode ?? 0;
        if (code >= 300 && code < 400 && res.headers.location) {
          const redir = new URL(res.headers.location, url).toString();
          res.resume();
          fetchUrl(redir, { decode, depth: depth + 1 })
            .then(r => resolve({ ...r, finalUrl: redir, redirected: true }))
            .catch(reject);
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", c => chunks.push(c as Buffer));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          const body =
            decode === "utf-8" ? buf.toString("utf8") : new TextDecoder(decode).decode(buf);
          resolve({ status: code, body, finalUrl: url, redirected: false });
        });
      },
    );
    req.on("error", err => {
      reject(isRateLimitError(err) ? new RateLimitedError(err.message) : err);
    });
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

/**
 * レート制限に当たった場合のみ、間隔を空けて再試行する。
 * 404 などの恒久的な失敗は再試行しない。
 */
export async function fetchWithRetry(
  url: string,
  opts: { decode?: "euc-jp" | "utf-8"; retries?: number; backoffMs?: number } = {},
): Promise<FetchResult> {
  const { decode = "euc-jp", retries = 2, backoffMs = 4000 } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetchUrl(url, { decode });
    } catch (err) {
      lastErr = err;
      if (!isRateLimitError(err) || attempt === retries) throw err;
      await sleep(backoffMs * (attempt + 1));
    }
  }
  throw lastErr;
}

const stripTags = (s: string) =>
  s
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export type HorseProfile = {
  pageName?: string;
  nameEn?: string;
  sex?: string;
  coatColor?: string;
  retired?: boolean;
  birthDate?: string;
  trainer?: string;
  trainerBase?: string;
  owner?: string;
  breeder?: string;
  sire?: string;
  dam?: string;
  damSire?: string;
  imageUrl?: string;
  totalRunsNk?: number;
  totalWinsNk?: number;
};

const COAT_COLORS =
  /^(鹿毛|黒鹿毛|青鹿毛|青毛|栗毛|栃栗毛|芦毛|白毛|粕毛|河原毛|佐目毛)$/;

/** 馬個体ページ（静的HTML部分）のパース */
export function parseHorsePage(html: string): HorseProfile {
  const info: HorseProfile = {};

  const titleBlock = html.match(/<div class="horse_title">([\s\S]*?)<\/div>/);
  if (titleBlock) {
    const h1 = titleBlock[1].match(/<h1>([^<]+)<\/h1>/);
    if (h1) info.pageName = h1[1].trim();

    const en = titleBlock[1].match(/eng_name[\s\S]*?<a[^>]*>([^<]+)<\/a>/);
    if (en) info.nameEn = en[1].trim();

    const txt = titleBlock[1].match(/<p class="txt_01">([\s\S]*?)<\/p>/);
    if (txt) {
      // 例: "抹消　牡　鹿毛" — 全角スペース区切りのトークンで厳密に判定する
      const tokens = stripTags(txt[1]).split(/[\s\u3000]+/).filter(Boolean);
      const sexTok = tokens.find(t => t === "牡" || t === "牝" || t === "セ");
      if (sexTok) info.sex = sexTok;
      const coatTok = tokens.find(t => COAT_COLORS.test(t));
      if (coatTok) info.coatColor = coatTok;
      if (tokens.includes("抹消")) info.retired = true;
    }
  }

  const prof = html.match(/<table[^>]*class="[^"]*db_prof_table[^"]*"[\s\S]*?<\/table>/);
  if (prof) {
    const rows = prof[0].match(/<tr>[\s\S]*?<\/tr>/g) ?? [];
    for (const row of rows) {
      const th = row.match(/<th[^>]*>([\s\S]*?)<\/th>/);
      const td = row.match(/<td[^>]*>([\s\S]*?)<\/td>/);
      if (!th || !td) continue;
      const label = stripTags(th[1]);
      const rawTd = td[1];
      const link = rawTd.match(/<a[^>]*>([^<]*)<\/a>/);
      // <a>優先 → img の alt（馬主のカラーシルク） → タグ除去テキスト
      const alt = rawTd.match(/<img[^>]*alt="([^"]*)"/);
      const val =
        link && link[1].trim()
          ? link[1].trim()
          : alt && alt[1].trim()
            ? alt[1].trim()
            : stripTags(rawTd);
      if (!val || val === "-") continue;

      switch (label) {
        case "生年月日":
          info.birthDate = val;
          break;
        case "調教師": {
          info.trainer = val;
          const base = rawTd.match(/\((栗東|美浦|地方|外国|[^)]{1,8})\)/);
          if (base) info.trainerBase = base[1];
          break;
        }
        case "馬主":
          info.owner = val;
          break;
        case "生産者":
          info.breeder = val;
          break;
        case "通算成績": {
          const m = stripTags(rawTd).match(/(\d+)戦(\d+)勝/);
          if (m) {
            info.totalRunsNk = Number(m[1]);
            info.totalWinsNk = Number(m[2]);
          }
          break;
        }
        default:
          break;
      }
    }
  }
  return info;
}

type BloodCell = { cls: string; rowspan: number; name: string };

/** 血統表（Ajax・UTF-8 JSON）のパース: 父・母・母父を取得 */
export function parsePedigree(json: string): Pick<HorseProfile, "sire" | "dam" | "damSire"> {
  let obj: { status?: string; data?: string };
  try {
    obj = JSON.parse(json);
  } catch {
    return {};
  }
  if (obj.status !== "OK" || !obj.data) return {};
  const table = obj.data.match(/<table[^>]*class="blood_table"[\s\S]*?<\/table>/);
  if (!table) return {};

  const rows = table[0].match(/<tr>[\s\S]*?<\/tr>/g) ?? [];
  const grid: BloodCell[][] = rows.map(r => {
    const cells = r.match(/<td[^>]*>[\s\S]*?<\/td>/g) ?? [];
    return cells.map(c => ({
      cls: (c.match(/class="([^"]*)"/) ?? [, ""])[1] as string,
      rowspan: Number((c.match(/rowspan="(\d+)"/) ?? [, "1"])[1]),
      name: stripTags(c),
    }));
  });

  const out: Pick<HorseProfile, "sire" | "dam" | "damSire"> = {};
  // blood_table は3代分。1行目先頭が父、rowspan=2 の b_fml が母、その隣が母父。
  if (grid[0]?.[0]) out.sire = grid[0][0].name;

  const damRowIdx = grid.findIndex(row =>
    row.some(c => c.cls.includes("b_fml") && c.rowspan === 2),
  );
  if (damRowIdx >= 0) {
    const damRow = grid[damRowIdx];
    const damPos = damRow.findIndex(c => c.cls.includes("b_fml") && c.rowspan === 2);
    out.dam = damRow[damPos].name;
    if (damRow[damPos + 1]) out.damSire = damRow[damPos + 1].name;
  }
  return out;
}

/** 馬体写真（Ajax・UTF-8 JSON）のパース */
export function parsePhoto(json: string): Pick<HorseProfile, "imageUrl"> {
  let obj: { status?: string; data?: string };
  try {
    obj = JSON.parse(json);
  } catch {
    return {};
  }
  if (obj.status !== "OK" || !obj.data) return {};
  // src / data-src の両方に加え、遅延読み込み用の空 id="" プレースホルダも混在する。
  // 「id が数値であるURL」だけを候補にし、最初の1件を採用する。
  const candidates = obj.data.match(
    /https:\/\/[\w.-]*netkeiba\.com\/[^"'\s]*batai_img\.php\?id=\d+/g,
  );
  const url = candidates?.find(u => /\bid=\d+$/.test(u) || /\bid=\d+(&|$)/.test(u));
  return url ? { imageUrl: url } : {};
}

export type DetailFetchOutcome =
  | { ok: true; data: HorseProfile; requestCount: number }
  | {
      ok: false;
      reason: "name_mismatch";
      pageName: string;
      expectedName: string;
      payload: HorseProfile;
      requestCount: number;
    }
  | { ok: false; reason: Exclude<string, "name_mismatch">; requestCount: number };

/**
 * 1頭分の詳細を取得する。
 * expectedName を渡した場合、ページ上の馬名と一致しなければ取り違えとして拒否する。
 */
export async function fetchHorseDetails(
  netkeibaId: string,
  expectedName?: string | null,
): Promise<DetailFetchOutcome> {
  let requestCount = 0;
  const pageUrl = `https://db.netkeiba.com/horse/${netkeibaId}/`;

  let page: FetchResult;
  try {
    page = await fetchWithRetry(pageUrl);
    requestCount += 1;
  } catch (e) {
    if (isRateLimitError(e)) {
      return { ok: false, reason: "rate_limited", requestCount: requestCount + 1 };
    }
    return { ok: false, reason: `network_error: ${(e as Error).message}`, requestCount };
  }
  if (page.status !== 200) return { ok: false, reason: `http_${page.status}`, requestCount };

  const info = parseHorsePage(page.body);
  if (!info.pageName) return { ok: false, reason: "name_not_found", requestCount };

  if (expectedName && info.pageName !== expectedName) {
    return {
      ok: false,
      reason: "name_mismatch",
      pageName: info.pageName,
      expectedName,
      payload: info,
      requestCount,
    };
  }

  const [pedRes, phoRes] = await Promise.all([
    fetchWithRetry(
      `https://db.netkeiba.com/horse/ajax_horse_pedigree.html?input=UTF-8&output=json&id=${netkeibaId}`,
      { decode: "utf-8", retries: 1, backoffMs: 3000 },
    ).catch(() => null),
    fetchWithRetry(
      `https://db.netkeiba.com/horse/ajax_photo_paddock.html?input=UTF-8&output=json&block_name=horse_photo_paddock_top&id=${netkeibaId}`,
      { decode: "utf-8", retries: 1, backoffMs: 3000 },
    ).catch(() => null),
  ]);
  requestCount += 2;

  const ped = pedRes?.status === 200 ? parsePedigree(pedRes.body) : {};
  const pho = phoRes?.status === 200 ? parsePhoto(phoRes.body) : {};

  return { ok: true, data: { ...info, ...ped, ...pho }, requestCount };
}

/**
 * レース結果ページのHTMLから「馬名 → netkeibaId」を抽出する。
 *
 * netkeiba のアンカーは2系統ある:
 *   A) <a href="/horse/2019105219/">イクイノックス</a>          … アンカーテキストが馬名
 *   B) <a href="/horse/2017101835/" title="コントレイル" ...>   … テキストが空で title に馬名
 * B のみのページも存在するため、両方を見る必要がある。
 */
export function parseRaceHorseMap(html: string): Record<string, string> {
  const map: Record<string, string> = {};

  // A) アンカーテキストが馬名のパターン
  const textRe = /<a href="\/horse\/(\d{10})\/"[^>]*>([^<]+)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = textRe.exec(html)) !== null) {
    const name = m[2].trim();
    if (name && !map[name]) map[name] = m[1];
  }

  // B) title 属性に馬名があるパターン
  const titleRe = /<a href="\/horse\/(\d{10})\/"[^>]*\stitle="([^"]+)"/g;
  while ((m = titleRe.exec(html)) !== null) {
    const name = m[2].trim();
    if (name && !map[name]) map[name] = m[1];
  }

  return map;
}

/**
 * レース結果ページから「馬名 → netkeibaId」の対応表を作る。
 * 1リクエストで出走全馬（最大18頭）のIDが得られるため、
 * 個体ページを1頭ずつ叩くより圧倒的にコスト効率が良い。
 */
export async function resolveIdsFromRace(
  raceUrl: string,
): Promise<{ ok: boolean; map: Record<string, string>; reason?: string; requestCount: number }> {
  let res: FetchResult;
  try {
    res = await fetchWithRetry(raceUrl);
  } catch (e) {
    return {
      ok: false,
      map: {},
      reason: isRateLimitError(e) ? "rate_limited" : (e as Error).message,
      requestCount: 1,
    };
  }
  if (res.status !== 200) {
    return { ok: false, map: {}, reason: `http_${res.status}`, requestCount: 1 };
  }

  const map = parseRaceHorseMap(res.body);
  // HTTP 200 なのに1頭も取れない場合はページ構造の変化を疑うべき異常として扱う
  if (Object.keys(map).length === 0) {
    return { ok: false, map, reason: "no_horses_parsed", requestCount: 1 };
  }
  return { ok: true, map, requestCount: 1 };
}
