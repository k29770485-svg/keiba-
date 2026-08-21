import { describe, expect, it } from "vitest";
import { parseHorsePage } from "./netkeibaFetcher";

/**
 * 名前照合による書き込み拒否は、このアプリで最も重要な安全機構である。
 *
 * netkeibaId の紐付けが誤っていると、そのIDのページ内容が別馬の行に
 * そのまま書き込まれ、DB が警告なしに汚染される（実際に旧実装では
 * イクイノックスの行にドウデュースの情報が書き込まれた）。
 *
 * fetchHorseDetails は expectedName と一致しない場合に
 * `ok: false / reason: "name_mismatch"` を返し、呼び出し側が
 * 書き込みを行わず隔離ログへ退避する。ここではその判定ロジックを、
 * 実HTMLの構造を模した入力で検証する。
 */

const page = (name: string) => `
<html><head><title>${name} | 競走馬データ - netkeiba</title></head>
<body>
<div class="horse_title">
  <h1>${name}</h1>
  <p class="txt_01">牡　青鹿毛</p>
  <p class="eng_name"><a href="/horse/x/">DO DEUCE</a></p>
</div>
<table class="db_prof_table">
  <tr><th>調教師</th><td><a href="/trainer/1/">友道康夫</a>(栗東)</td></tr>
</table>
</body></html>
`;

/** fetchHorseDetails 内の照合判定と同じ条件 */
function shouldReject(pageHtml: string, expectedName: string) {
  const info = parseHorsePage(pageHtml);
  if (!info.pageName) return { reject: true, reason: "name_not_found" as const };
  if (info.pageName !== expectedName) {
    return { reject: true, reason: "name_mismatch" as const, actualName: info.pageName };
  }
  return { reject: false as const, payload: info };
}

describe("名前照合による書き込み拒否", () => {
  it("DB馬名とページ馬名が一致する場合のみ書き込みを許可する", () => {
    const r = shouldReject(page("ドウデュース"), "ドウデュース");
    expect(r.reject).toBe(false);
    expect(r.payload?.trainer).toBe("友道康夫");
  });

  it("別馬のページだった場合は書き込まず name_mismatch を返す", () => {
    // イクイノックスの行に、ドウデュースのページ内容が来たケース
    const r = shouldReject(page("ドウデュース"), "イクイノックス");
    expect(r.reject).toBe(true);
    expect(r.reason).toBe("name_mismatch");
    expect(r.actualName).toBe("ドウデュース");
  });

  it("拒否時は取得済みの値を一切採用しない（payloadを返さない）", () => {
    const r = shouldReject(page("ドウデュース"), "イクイノックス");
    expect("payload" in r && r.payload).toBeFalsy();
  });

  it("馬名が読み取れないページも拒否する（照合できないため）", () => {
    const r = shouldReject("<html><body>maintenance</body></html>", "イクイノックス");
    expect(r.reject).toBe(true);
    expect(r.reason).toBe("name_not_found");
  });

  it("表記が僅かに異なる場合も別馬として拒否する（部分一致は許さない）", () => {
    expect(shouldReject(page("ドウデュース"), "ドウデユース").reject).toBe(true);
    expect(shouldReject(page("ドウデュース"), "ドウデュー").reject).toBe(true);
    expect(shouldReject(page("ドウデュース"), "ドウデュースII").reject).toBe(true);
  });
});
