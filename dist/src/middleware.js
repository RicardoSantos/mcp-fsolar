"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_BODY_SIZE = void 0;
exports.makeGetAllowedOrigin = makeGetAllowedOrigin;
exports.makeCheckAuth = makeCheckAuth;
exports.makeRateLimit = makeRateLimit;
exports.readBody = readBody;
const crypto_1 = __importDefault(require("crypto"));
const node_http2_1 = require("node:http2");
const errors_1 = require("./errors");
const { HTTP_STATUS_UNAUTHORIZED, HTTP_STATUS_TOO_MANY_REQUESTS, HTTP_STATUS_PAYLOAD_TOO_LARGE } = node_http2_1.constants;
exports.MAX_BODY_SIZE = 65536;
// ── CORS ──────────────────────────────────────────────────────────────────────
function makeGetAllowedOrigin(corsOrigin) {
    return function getAllowedOrigin(req) {
        if (corsOrigin)
            return corsOrigin;
        const origin = req.headers.origin;
        if (!origin)
            return null;
        try {
            const { hostname } = new URL(origin);
            if (hostname === "localhost" || hostname === "127.0.0.1")
                return origin;
        }
        catch { /* malformed origin */ }
        return null;
    };
}
// ── Auth ──────────────────────────────────────────────────────────────────────
function _hmac(s) {
    return crypto_1.default.createHmac("sha256", "felicity-key-cmp").update(s).digest();
}
function makeCheckAuth(apiKey) {
    return function checkAuth(req, res) {
        if (!apiKey)
            return true;
        const raw = (req.headers["authorization"] ?? req.headers["x-api-key"] ?? "");
        const token = raw.startsWith("Bearer ") ? raw.slice(7) : raw;
        const valid = token.length > 0 && crypto_1.default.timingSafeEqual(_hmac(token), _hmac(apiKey));
        if (!valid) {
            res.writeHead(HTTP_STATUS_UNAUTHORIZED, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "unauthorized" }));
            return false;
        }
        return true;
    };
}
function makeRateLimit(rateLimit, trustProxy) {
    const _buckets = new Map();
    const _purge = setInterval(() => {
        const now = Date.now();
        for (const [ip, b] of _buckets)
            if (now > b.resetAt)
                _buckets.delete(ip);
    }, 5 * 60000).unref();
    function _clientIp(req) {
        if (trustProxy) {
            const fwd = req.headers["x-forwarded-for"];
            if (fwd)
                return (Array.isArray(fwd) ? fwd[0] : fwd).split(",")[0].trim();
        }
        return req.socket?.remoteAddress ?? "unknown";
    }
    function checkRateLimit(req, res) {
        if (!rateLimit)
            return true;
        const ip = _clientIp(req);
        const now = Date.now();
        let b = _buckets.get(ip);
        if (!b || now > b.resetAt) {
            b = { count: 0, resetAt: now + 60000 };
            _buckets.set(ip, b);
        }
        b.count++;
        if (b.count > rateLimit) {
            res.writeHead(HTTP_STATUS_TOO_MANY_REQUESTS, {
                "Content-Type": "application/json",
                "Retry-After": String(Math.ceil((b.resetAt - now) / 1000)),
            });
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
        let body = "";
        let size = 0;
        let done = false;
        req.on("data", (chunk) => {
            if (done)
                return;
            size += chunk.length;
            if (size > exports.MAX_BODY_SIZE) {
                done = true;
                req.resume();
                req.once("end", () => reject(new errors_1.AppError("Request body too large", HTTP_STATUS_PAYLOAD_TOO_LARGE)));
                return;
            }
            body += chunk;
        });
        req.on("end", () => { if (!done)
            resolve(body); });
        req.on("error", (e) => { if (!done)
            reject(e); });
    });
}
