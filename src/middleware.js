"use strict";

const crypto = require("crypto");
const { constants: { HTTP_STATUS_UNAUTHORIZED, HTTP_STATUS_TOO_MANY_REQUESTS,
                     HTTP_STATUS_PAYLOAD_TOO_LARGE } } = require("node:http2");
const { AppError } = require("./errors");

const MAX_BODY_SIZE = 65_536; // 64 KB

// ── CORS ──────────────────────────────────────────────────────────────────────

function makeGetAllowedOrigin(corsOrigin) {
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

// Static key normalises input length for timingSafeEqual; the actual secret
// is what's compared, not this key.
function _hmac(s) {
  return crypto.createHmac("sha256", "felicity-key-cmp").update(s).digest();
}

function makeCheckAuth(apiKey) {
  return function checkAuth(req, res) {
    if (!apiKey) return true;
    const raw   = req.headers["authorization"] ?? req.headers["x-api-key"] ?? "";
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

function makeRateLimit(rateLimit, trustProxy) {
  const _buckets = new Map();
  const _purge   = setInterval(() => {
    const now = Date.now();
    for (const [ip, b] of _buckets) if (now > b.resetAt) _buckets.delete(ip);
  }, 5 * 60_000).unref();

  function _clientIp(req) {
    if (trustProxy) {
      const fwd = req.headers["x-forwarded-for"];
      if (fwd) return fwd.split(",")[0].trim();
    }
    return req.socket.remoteAddress ?? "unknown";
  }

  function checkRateLimit(req, res) {
    if (!rateLimit) return true;
    const ip  = _clientIp(req);
    const now = Date.now();
    let b = _buckets.get(ip);
    if (!b || now > b.resetAt) { b = { count: 0, resetAt: now + 60_000 }; _buckets.set(ip, b); }
    b.count++;
    if (b.count > rateLimit) {
      res.writeHead(HTTP_STATUS_TOO_MANY_REQUESTS, { "Content-Type": "application/json", "Retry-After": String(Math.ceil((b.resetAt - now) / 1000)) });
      res.end(JSON.stringify({ error: "too many requests" }));
      return false;
    }
    return true;
  }

  function stopPurge() { clearInterval(_purge); }

  return { checkRateLimit, stopPurge };
}

// ── Body reader ───────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ""; let size = 0; let done = false;
    req.on("data", (chunk) => {
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

module.exports = { makeGetAllowedOrigin, makeCheckAuth, makeRateLimit, readBody, MAX_BODY_SIZE };
