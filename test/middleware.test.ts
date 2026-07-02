import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "events";
import http from "http";
import { constants } from "node:http2";
import { makeGetAllowedOrigin, makeCheckAuth, makeRateLimit,
         readBody, MAX_BODY_SIZE } from "../src/middleware";

const { HTTP_STATUS_UNAUTHORIZED, HTTP_STATUS_TOO_MANY_REQUESTS,
        HTTP_STATUS_PAYLOAD_TOO_LARGE } = constants;

// ── Test doubles ──────────────────────────────────────────────────────────────

type FakeRes = {
  writeHead(s: number, h?: Record<string, string>): void;
  end(b?: string): void;
  readonly status: number | null;
  readonly headers: Record<string, string>;
  readonly body: string | null;
};

function makeRes(): FakeRes {
  const captured: { status: number | null; headers: Record<string, string>; body: string | null } =
    { status: null, headers: {}, body: null };
  return {
    writeHead(s, h = {}) { captured.status = s; Object.assign(captured.headers, h); },
    end(b = "")           { captured.body = b; },
    get status()          { return captured.status; },
    get headers()         { return captured.headers; },
    get body()            { return captured.body; },
  };
}

function makeReq(opts: { headers?: Record<string, string>; remoteAddress?: string } = {}) {
  const { headers = {}, remoteAddress = "10.20.30.40" } = opts;
  return { headers, socket: { remoteAddress } };
}

function makeStreamReq(data: string | null): http.IncomingMessage {
  const e = new EventEmitter();
  Object.assign(e, { headers: {}, socket: { remoteAddress: "127.0.0.1" }, resume: () => {} });
  process.nextTick(() => {
    if (data != null) e.emit("data", Buffer.from(data));
    e.emit("end");
  });
  return e as unknown as http.IncomingMessage;
}

// ── makeGetAllowedOrigin ──────────────────────────────────────────────────────

test("getAllowedOrigin — fixed corsOrigin always returned regardless of request origin", () => {
  const fn = makeGetAllowedOrigin("https://myapp.com");
  assert.equal(fn(makeReq({ headers: { origin: "https://evil.com" } }) as unknown as http.IncomingMessage), "https://myapp.com");
});

test("getAllowedOrigin — localhost allowed when no fixed corsOrigin", () => {
  const fn = makeGetAllowedOrigin(null);
  assert.equal(fn(makeReq({ headers: { origin: "http://localhost:3000" } }) as unknown as http.IncomingMessage), "http://localhost:3000");
});

test("getAllowedOrigin — 127.0.0.1 allowed", () => {
  const fn = makeGetAllowedOrigin(null);
  assert.equal(fn(makeReq({ headers: { origin: "http://127.0.0.1:3000" } }) as unknown as http.IncomingMessage), "http://127.0.0.1:3000");
});

test("getAllowedOrigin — remote origin rejected (returns null)", () => {
  const fn = makeGetAllowedOrigin(null);
  assert.equal(fn(makeReq({ headers: { origin: "https://example.com" } }) as unknown as http.IncomingMessage), null);
});

test("getAllowedOrigin — missing origin header returns null", () => {
  const fn = makeGetAllowedOrigin(null);
  assert.equal(fn(makeReq() as unknown as http.IncomingMessage), null);
});

test("getAllowedOrigin — malformed origin returns null without throwing", () => {
  const fn = makeGetAllowedOrigin(null);
  assert.doesNotThrow(() => {
    const result = fn(makeReq({ headers: { origin: "not-a-url" } }) as unknown as http.IncomingMessage);
    assert.equal(result, null);
  });
});

// ── makeCheckAuth ─────────────────────────────────────────────────────────────

test("checkAuth — passes through when no apiKey configured", () => {
  const check = makeCheckAuth(null);
  const res   = makeRes();
  assert.equal(check(makeReq() as unknown as http.IncomingMessage, res as unknown as http.ServerResponse), true);
  assert.equal(res.status, null);
});

test("checkAuth — passes with valid Bearer token", () => {
  const check = makeCheckAuth("secret123");
  assert.equal(
    check(
      makeReq({ headers: { authorization: "Bearer secret123" } }) as unknown as http.IncomingMessage,
      makeRes() as unknown as http.ServerResponse,
    ),
    true,
  );
});

test("checkAuth — passes with valid x-api-key header", () => {
  const check = makeCheckAuth("secret123");
  assert.equal(
    check(
      makeReq({ headers: { "x-api-key": "secret123" } }) as unknown as http.IncomingMessage,
      makeRes() as unknown as http.ServerResponse,
    ),
    true,
  );
});

test("checkAuth — fails with wrong token and writes 401", () => {
  const check = makeCheckAuth("secret123");
  const res   = makeRes();
  assert.equal(
    check(
      makeReq({ headers: { authorization: "Bearer wrongtoken" } }) as unknown as http.IncomingMessage,
      res as unknown as http.ServerResponse,
    ),
    false,
  );
  assert.equal(res.status, HTTP_STATUS_UNAUTHORIZED);
});

test("checkAuth — fails with missing headers and writes 401", () => {
  const check = makeCheckAuth("secret123");
  const res   = makeRes();
  assert.equal(
    check(makeReq({ headers: {} }) as unknown as http.IncomingMessage, res as unknown as http.ServerResponse),
    false,
  );
  assert.equal(res.status, HTTP_STATUS_UNAUTHORIZED);
});

test("checkAuth — fails with empty Bearer value", () => {
  const check = makeCheckAuth("secret123");
  const res   = makeRes();
  assert.equal(
    check(
      makeReq({ headers: { authorization: "Bearer " } }) as unknown as http.IncomingMessage,
      res as unknown as http.ServerResponse,
    ),
    false,
  );
  assert.equal(res.status, HTTP_STATUS_UNAUTHORIZED);
});

test("checkAuth — response body contains 'unauthorized'", () => {
  const check = makeCheckAuth("key");
  const res   = makeRes();
  check(makeReq() as unknown as http.IncomingMessage, res as unknown as http.ServerResponse);
  assert.ok(res.body !== null && res.body.includes("unauthorized"));
});

// ── makeRateLimit ─────────────────────────────────────────────────────────────

test("checkRateLimit — disabled when limit is 0 (always passes)", () => {
  const { checkRateLimit, stopPurge } = makeRateLimit(0);
  try {
    for (let i = 0; i < 100; i++)
      assert.equal(
        checkRateLimit(makeReq() as unknown as http.IncomingMessage, makeRes() as unknown as http.ServerResponse),
        true,
      );
  } finally { stopPurge(); }
});

test("checkRateLimit — passes when under the limit", () => {
  const { checkRateLimit, stopPurge } = makeRateLimit(5);
  try {
    const req = makeReq();
    for (let i = 0; i < 5; i++)
      assert.equal(
        checkRateLimit(req as unknown as http.IncomingMessage, makeRes() as unknown as http.ServerResponse),
        true,
      );
  } finally { stopPurge(); }
});

test("checkRateLimit — blocks on request limit + 1 with 429", () => {
  const { checkRateLimit, stopPurge } = makeRateLimit(3);
  const req = makeReq();
  try {
    checkRateLimit(req as unknown as http.IncomingMessage, makeRes() as unknown as http.ServerResponse);
    checkRateLimit(req as unknown as http.IncomingMessage, makeRes() as unknown as http.ServerResponse);
    checkRateLimit(req as unknown as http.IncomingMessage, makeRes() as unknown as http.ServerResponse);
    const res = makeRes();
    assert.equal(
      checkRateLimit(req as unknown as http.IncomingMessage, res as unknown as http.ServerResponse),
      false,
    );
    assert.equal(res.status, HTTP_STATUS_TOO_MANY_REQUESTS);
  } finally { stopPurge(); }
});

test("checkRateLimit — Retry-After header set when blocked", () => {
  const { checkRateLimit, stopPurge } = makeRateLimit(1);
  const req = makeReq();
  try {
    checkRateLimit(req as unknown as http.IncomingMessage, makeRes() as unknown as http.ServerResponse);
    const res = makeRes();
    checkRateLimit(req as unknown as http.IncomingMessage, res as unknown as http.ServerResponse);
    assert.ok(res.headers["Retry-After"], "Retry-After must be set");
  } finally { stopPurge(); }
});

test("checkRateLimit — different IPs have independent buckets", () => {
  const { checkRateLimit, stopPurge } = makeRateLimit(1);
  try {
    const req1 = makeReq({ remoteAddress: "1.2.3.4" });
    const req2 = makeReq({ remoteAddress: "5.6.7.8" });
    assert.equal(
      checkRateLimit(req1 as unknown as http.IncomingMessage, makeRes() as unknown as http.ServerResponse),
      true,
    );
    assert.equal(
      checkRateLimit(req2 as unknown as http.IncomingMessage, makeRes() as unknown as http.ServerResponse),
      true,
    );
  } finally { stopPurge(); }
});

test("checkRateLimit — trustProxy reads x-forwarded-for", () => {
  const { checkRateLimit, stopPurge } = makeRateLimit(1, true);
  try {
    const req = makeReq({ headers: { "x-forwarded-for": "9.9.9.9, 1.1.1.1" } });
    assert.equal(
      checkRateLimit(req as unknown as http.IncomingMessage, makeRes() as unknown as http.ServerResponse),
      true,
    );
    assert.equal(
      checkRateLimit(req as unknown as http.IncomingMessage, makeRes() as unknown as http.ServerResponse),
      false,
    );
  } finally { stopPurge(); }
});

test("checkRateLimit — stopPurge does not throw", () => {
  const { stopPurge } = makeRateLimit(10);
  assert.doesNotThrow(() => stopPurge());
});

// ── readBody ──────────────────────────────────────────────────────────────────

test("readBody — resolves with body string", async () => {
  assert.equal(await readBody(makeStreamReq("hello world")), "hello world");
});

test("readBody — resolves with empty body", async () => {
  assert.equal(await readBody(makeStreamReq("")), "");
});

test("readBody — resolves with JSON payload", async () => {
  const payload = JSON.stringify({ url: "https://example.com" });
  const body    = await readBody(makeStreamReq(payload));
  assert.deepEqual(JSON.parse(body), { url: "https://example.com" });
});

test("readBody — rejects with AppError 413 when payload exceeds MAX_BODY_SIZE", async () => {
  const e   = new EventEmitter();
  Object.assign(e, { headers: {}, socket: { remoteAddress: "127.0.0.1" }, resume: () => {} });
  const big = Buffer.alloc(MAX_BODY_SIZE + 1, "x");
  process.nextTick(() => { e.emit("data", big); e.emit("end"); });
  await assert.rejects(() => readBody(e as unknown as http.IncomingMessage), (err: unknown) => {
    assert.equal((err as { statusCode: number }).statusCode, HTTP_STATUS_PAYLOAD_TOO_LARGE);
    return true;
  });
});

test("readBody — rejects with underlying error on stream error", async () => {
  const e = new EventEmitter();
  Object.assign(e, { headers: {}, socket: { remoteAddress: "127.0.0.1" }, resume: () => {} });
  process.nextTick(() => e.emit("error", new Error("connection reset")));
  await assert.rejects(() => readBody(e as unknown as http.IncomingMessage), /connection reset/);
});
