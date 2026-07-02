import crypto from "crypto";
import http    from "http";
import { constants } from "node:http2";
import { AppError }  from "./errors";

const { HTTP_STATUS_UNAUTHORIZED, HTTP_STATUS_TOO_MANY_REQUESTS, HTTP_STATUS_PAYLOAD_TOO_LARGE } = constants;

export const MAX_BODY_SIZE = 65_536;

// ── CORS ──────────────────────────────────────────────────────────────────────

export function makeGetAllowedOrigin(corsOrigin: string | null): (req: http.IncomingMessage) => string | null {
  return function getAllowedOrigin(req) {
    if (corsOrigin) return corsOrigin;
    const origin = req.headers.origin;
    if (!origin) return null;
    try {
      const { hostname } = new URL(origin);
      if (hostname === "localhost" || hostname === "127.0.0.1") return origin;
    } catch { /* malformed origin */ }
    return null;
  };
}

// ── Auth ──────────────────────────────────────────────────────────────────────

function _hmac(s: string): Buffer {
  return crypto.createHmac("sha256", "felicity-key-cmp").update(s).digest();
}

export function makeCheckAuth(apiKey: string | null): (req: http.IncomingMessage, res: http.ServerResponse) => boolean {
  return function checkAuth(req, res) {
    if (!apiKey) return true;

    const reqUrl = new URL(req.url ?? "/", "http://localhost");
    if (reqUrl.searchParams.has("key") || reqUrl.searchParams.has("api_key")) {
      res.writeHead(HTTP_STATUS_UNAUTHORIZED, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "API keys in query strings are not supported" }));
      return false;
    }

    const raw   = (req.headers["authorization"] ?? req.headers["x-api-key"] ?? "") as string;
    const token = raw.startsWith("Bearer ") ? raw.slice(7) : raw;
    const valid = token.length > 0 && crypto.timingSafeEqual(_hmac(token), _hmac(apiKey));
    if (!valid) {
      res.writeHead(HTTP_STATUS_UNAUTHORIZED, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return false;
    }
    return true;
  };
}

// ── Rate limiting ─────────────────────────────────────────────────────────────

interface RateBucket {
  count:   number;
  resetAt: number;
}

export function makeRateLimit(
  rateLimit:  number,
  trustProxy = false
): { checkRateLimit(req: http.IncomingMessage, res: http.ServerResponse): boolean; stopPurge(): void } {
  const _buckets = new Map<string, RateBucket>();
  const _purge   = setInterval(() => {
    const now = Date.now();
    for (const [ip, b] of _buckets) if (now > b.resetAt) _buckets.delete(ip);
  }, 5 * 60_000).unref();

  function _clientIp(req: http.IncomingMessage): string {
    if (trustProxy) {
      const fwd = req.headers["x-forwarded-for"];
      if (fwd) return (Array.isArray(fwd) ? fwd[0] : fwd).split(",")[0].trim();
    }
    return req.socket?.remoteAddress ?? "unknown";
  }

  function checkRateLimit(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    if (!rateLimit) return true;
    const ip  = _clientIp(req);
    const now = Date.now();
    let b = _buckets.get(ip);
    if (!b || now > b.resetAt) { b = { count: 0, resetAt: now + 60_000 }; _buckets.set(ip, b); }
    b.count++;
    if (b.count > rateLimit) {
      res.writeHead(HTTP_STATUS_TOO_MANY_REQUESTS, {
        "Content-Type": "application/json",
        "Retry-After":  String(Math.ceil((b.resetAt - now) / 1000)),
      });
      res.end(JSON.stringify({ error: "too many requests" }));
      return false;
    }
    return true;
  }

  function stopPurge(): void { clearInterval(_purge); }

  return { checkRateLimit, stopPurge };
}

// ── Body reader ───────────────────────────────────────────────────────────────

export function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ""; let size = 0; let done = false;
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        done = true;
        req.resume();
        req.once("end", () => reject(new AppError("Request body too large", HTTP_STATUS_PAYLOAD_TOO_LARGE)));
        return;
      }
      body += chunk;
    });
    req.on("end",   () => { if (!done) resolve(body); });
    req.on("error", (e) => { if (!done) reject(e); });
  });
}
