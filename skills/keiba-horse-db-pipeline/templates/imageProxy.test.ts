import { describe, expect, it } from "vitest";
import { isAllowedImageHost } from "./imageProxy";

/**
 * 画像プロキシは任意URLを中継できてしまうと SSRF の踏み台になるため、
 * netkeiba 系ホストのみを許可する。
 */
describe("isAllowedImageHost", () => {
  it("netkeiba 系ホストを許可する", () => {
    expect(isAllowedImageHost("https://cdn.netkeiba.com/img.horse/batai_img.php?id=1")).toBe(true);
    expect(isAllowedImageHost("https://db.netkeiba.com/img/x.jpg")).toBe(true);
  });

  it("それ以外のホストは拒否する（SSRF対策）", () => {
    expect(isAllowedImageHost("https://example.com/x.jpg")).toBe(false);
    expect(isAllowedImageHost("http://169.254.169.254/latest/meta-data/")).toBe(false);
    expect(isAllowedImageHost("https://netkeiba.com.evil.example/x.jpg")).toBe(false);
  });

  it("URLとして壊れている入力は拒否する", () => {
    expect(isAllowedImageHost("not a url")).toBe(false);
    expect(isAllowedImageHost("")).toBe(false);
  });
});
