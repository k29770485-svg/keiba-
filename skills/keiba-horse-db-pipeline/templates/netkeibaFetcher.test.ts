import { describe, expect, it } from "vitest";
import {
  isRateLimitError,
  parseHorsePage,
  parsePedigree,
  parsePhoto,
  parseRaceHorseMap,
  RateLimitedError,
} from "./netkeibaFetcher";

/**
 * netkeiba の実レスポンスから抽出した最小構造。
 * Ajax は { status: "OK", data: "<html>" } の形で返る（実アクセスで確認済み）。
 */
const HORSE_PAGE = `
<html><head><title>イクイノックス | 競走馬データ - netkeiba</title></head>
<body>
<div class="horse_title">
  <h1>イクイノックス</h1>
  <p class="txt_01">牡　青鹿毛</p>
  <p class="eng_name"><a href="/horse/2019105219/">EQUINOX</a></p>
</div>
<table class="db_prof_table">
  <tr><th>生年月日</th><td>2019年3月23日</td></tr>
  <tr><th>調教師</th><td><a href="/trainer/01234/">木村哲也</a>(美浦)</td></tr>
  <tr><th>馬主</th><td><a href="/owner/xxx/">シルクレーシング</a></td></tr>
  <tr><th>生産者</th><td><a href="/breeder/yyy/">ノーザンファーム</a></td></tr>
  <tr><th>毛色</th><td>青鹿毛</td></tr>
</table>
</body></html>
`;

const ajax = (data: string) => JSON.stringify({ status: "OK", data });

describe("parseHorsePage", () => {
  it("馬名・性別・毛色・英字名・厩舎情報を抽出する", () => {
    const info = parseHorsePage(HORSE_PAGE);
    expect(info.pageName).toBe("イクイノックス");
    expect(info.sex).toBe("牡");
    expect(info.coatColor).toBe("青鹿毛");
    expect(info.nameEn).toBe("EQUINOX");
    expect(info.trainer).toBe("木村哲也");
    expect(info.owner).toBe("シルクレーシング");
    expect(info.breeder).toBe("ノーザンファーム");
    expect(info.birthDate).toBe("2019年3月23日");
  });

  it("抹消馬でも性別・毛色を正しく取る（トークン単位で判定する）", () => {
    const html = HORSE_PAGE.replace(
      '<p class="txt_01">牡　青鹿毛</p>',
      '<p class="txt_01">抹消　牝　鹿毛</p>',
    );
    const info = parseHorsePage(html);
    expect(info.sex).toBe("牝");
    expect(info.coatColor).toBe("鹿毛");
    expect(info.retired).toBe(true);
  });

  it("馬名が取れないHTMLでは pageName が空になる（照合で必ず弾ける）", () => {
    expect(parseHorsePage("<html><body>no horse here</body></html>").pageName).toBeFalsy();
  });
});

describe("parsePhoto", () => {
  it("id が数値の画像URLのみを採用する（空idのプレースホルダは無視）", () => {
    // netkeiba は遅延読み込み用に id= が空の img を先に置くことがある。
    // 空 id を拾うと末尾が欠けた壊れたURLが保存されてしまう。
    const json = ajax(
      `<img src="https://cdn.netkeiba.com/img.horse/batai_img.php?id=" class="lazy">
       <img src="https://cdn.netkeiba.com/img.horse/batai_img.php?id=2019105219">`,
    );
    const out = parsePhoto(json);
    expect(out.imageUrl).toContain("id=2019105219");
    expect(out.imageUrl?.endsWith("id=")).toBe(false);
  });

  it("有効な画像が無ければ imageUrl を返さない", () => {
    const json = ajax(`<img src="https://cdn.netkeiba.com/img.horse/batai_img.php?id=" class="lazy">`);
    expect(parsePhoto(json).imageUrl).toBeUndefined();
  });

  it("status が OK でないレスポンスは無視する", () => {
    expect(parsePhoto(JSON.stringify({ status: "NG" })).imageUrl).toBeUndefined();
    expect(parsePhoto("not json").imageUrl).toBeUndefined();
  });
});

describe("parsePedigree", () => {
  it("父・母・母父を Ajax JSON から抽出する", () => {
    const json = ajax(`<table class="blood_table">
      <tr><td class="b_ml">キタサンブラック</td><td class="b_ml">ブラックタイド</td></tr>
      <tr><td class="b_fml" rowspan="2">シャトーブランシュ</td><td class="b_ml">キングヘイロー</td></tr>
    </table>`);
    const ped = parsePedigree(json);
    expect(ped.sire).toBe("キタサンブラック");
    expect(ped.dam).toBe("シャトーブランシュ");
    expect(ped.damSire).toBe("キングヘイロー");
  });

  it("血統表が無ければ空を返す（静的HTMLには含まれないため）", () => {
    expect(parsePedigree(ajax("<div>no table</div>"))).toEqual({});
  });
});

describe("parseRaceHorseMap", () => {
  it("アンカーテキスト形式と title 属性形式の両方から馬名→IDを抽出する", () => {
    // 実際の netkeiba には両形式が混在しており、片方だけ見ると取りこぼす
    const html = `
      <a href="/horse/2019105219/">イクイノックス</a>
      <a href="/horse/2017101835/" title="コントレイル" class="x"></a>
    `;
    const map = parseRaceHorseMap(html);
    expect(map["イクイノックス"]).toBe("2019105219");
    expect(map["コントレイル"]).toBe("2017101835");
  });

  it("出走馬が取れないページでは空を返す（0件は異常として扱える）", () => {
    expect(Object.keys(parseRaceHorseMap("<html></html>"))).toHaveLength(0);
  });
});

describe("isRateLimitError", () => {
  it("TLS切断・ECONNRESET をレート制限として扱う", () => {
    expect(
      isRateLimitError(
        new Error("Client network socket disconnected before secure TLS connection was established"),
      ),
    ).toBe(true);
    expect(isRateLimitError(new Error("read ECONNRESET"))).toBe(true);
    expect(isRateLimitError(new RateLimitedError("x"))).toBe(true);
  });

  it("404 など恒久的な失敗はレート制限として扱わない", () => {
    expect(isRateLimitError(new Error("http_404"))).toBe(false);
  });
});
