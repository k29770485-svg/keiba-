/**
 * netkeiba 画像の中継プロキシ。
 *
 * netkeiba の馬体写真は Referer を見ており、ブラウザから直リンクすると
 * CORS / 直リンク制限で表示できない。サーバー側で Referer を付けて
 * 中継し、CORS を許可した上で長めにキャッシュさせる。
 */
import type { Express, Request, Response } from "express";
import https from "https";
import { NETKEIBA_REFERER } from "./netkeibaFetcher";

/** 中継を許可するホスト。任意のURLを踏ませないための allowlist */
const ALLOWED_HOST = /(^|\.)netkeiba\.com$/;

const CACHE_SECONDS = 60 * 60 * 24; // 24時間

/**
 * 中継可否の判定。https かつ netkeiba 系ホストのみ許可する。
 * `netkeiba.com.evil.example` のようなサフィックス偽装も弾ける形にしてある。
 */
export function isAllowedImageHost(raw: string): boolean {
  if (!raw) return false;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && ALLOWED_HOST.test(u.hostname);
  } catch {
    return false;
  }
}

export function registerImageProxy(app: Express) {
  app.get("/api/image-proxy", (req: Request, res: Response) => {
    const raw = typeof req.query.url === "string" ? req.query.url : "";
    if (!raw) {
      res.status(400).json({ error: "url query parameter is required" });
      return;
    }

    let target: URL;
    try {
      target = new URL(raw);
    } catch {
      res.status(400).json({ error: "invalid url" });
      return;
    }
    if (!isAllowedImageHost(raw)) {
      res.status(403).json({ error: "host not allowed" });
      return;
    }

    const upstream = https.get(
      target.toString(),
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
          Referer: NETKEIBA_REFERER,
          Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        },
        timeout: 15000,
      },
      up => {
        const status = up.statusCode ?? 502;
        if (status !== 200) {
          up.resume();
          res.status(status).json({ error: `upstream returned ${status}` });
          return;
        }
        res.status(200);
        res.setHeader("Content-Type", up.headers["content-type"] ?? "image/jpeg");
        res.setHeader("Cache-Control", `public, max-age=${CACHE_SECONDS}, immutable`);
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
        if (up.headers["content-length"]) {
          res.setHeader("Content-Length", up.headers["content-length"]);
        }
        up.pipe(res);
      },
    );

    upstream.on("timeout", () => {
      upstream.destroy();
      if (!res.headersSent) res.status(504).json({ error: "upstream timeout" });
    });
    upstream.on("error", () => {
      if (!res.headersSent) res.status(502).json({ error: "proxy error" });
    });
  });
}
