/**
 * Config / env var validation tests — no network, no server, no credentials required.
 *
 * Covers:
 *   - resolveSnapshotConfig()  — FELICITY_SNAPSHOT_* env vars (src/store.ts)
 *   - makeCheckAuth()          — API key resolution and query-string rejection (src/middleware.ts)
 *   - makeRateLimit()          — rate limit config (0 = disabled) (src/middleware.ts)
 *   - makeGetAllowedOrigin()   — CORS config (src/middleware.ts)
 *   - Query-string key rejection (new: middleware.ts)
 */

import { test, describe } from "node:test";
import assert              from "node:assert/strict";
import { EventEmitter }    from "events";
import http                from "http";
import { constants }       from "node:http2";
import { resolveSnapshotConfig } from "../src/store";
import { makeCheckAuth, makeRateLimit, makeGetAllowedOrigin } from "../src/middleware";

const { HTTP_STATUS_UNAUTHORIZED, HTTP_STATUS_TOO_MANY_REQUESTS } = constants;

// ── Test doubles ──────────────────────────────────────────────────────────────

type FakeRes = {
  writeHead(s: number, h?: Record<string, string>): void;
  end(b?: string): void;
  readonly status: number | null;
  readonly body: string | null;
};

function makeRes(): FakeRes {
  const c: { status: number | null; body: string | null } = { status: null, body: null };
  return {
    writeHead(s: number) { c.status = s; },
    end(b = "")  { c.body = b; },
    get status() { return c.status; },
    get body()   { return c.body; },
  } as unknown as FakeRes;
}

function makeReq(overrides: Partial<{
  url: string;
  headers: Record<string, string>;
  socket: { remoteAddress: string };
}>): http.IncomingMessage {
  const ee = new EventEmitter() as unknown as http.IncomingMessage;
  Object.assign(ee, {
    url:     "/test",
    headers: {},
    socket:  { remoteAddress: "127.0.0.1" },
    ...overrides,
  });
  return ee;
}

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const old: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    old[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k];
  }
  try { fn(); } finally {
    for (const k of Object.keys(old)) {
      if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k];
    }
  }
}

// ── resolveSnapshotConfig — defaults ─────────────────────────────────────────

describe("resolveSnapshotConfig — defaults", () => {
  test("enabled by default", () => {
    withEnv({ FELICITY_SNAPSHOT_ENABLED: undefined }, () => {
      assert.equal(resolveSnapshotConfig().enabled, true);
    });
  });

  test("ms defaults to 10 min", () => {
    withEnv({ FELICITY_SNAPSHOT_MS: undefined }, () => {
      assert.equal(resolveSnapshotConfig().ms, 10 * 60 * 1000);
    });
  });

  test("maxIntra derived from days (default 15 days)", () => {
    withEnv({ FELICITY_SNAPSHOT_DAYS: undefined, FELICITY_SNAPSHOT_MS: undefined }, () => {
      const { ms, maxIntra } = resolveSnapshotConfig();
      const expectedMax = Math.ceil((15 * 24 * 60 * 60 * 1000) / ms);
      assert.equal(maxIntra, expectedMax);
    });
  });

  test("ddays defaults to 90", () => {
    withEnv({ FELICITY_DAILY_DAYS: undefined }, () => {
      assert.equal(resolveSnapshotConfig().ddays, 90);
    });
  });
});

// ── resolveSnapshotConfig — env overrides ─────────────────────────────────────

describe("resolveSnapshotConfig — env overrides", () => {
  test("FELICITY_SNAPSHOT_ENABLED=false disables snapshots", () => {
    withEnv({ FELICITY_SNAPSHOT_ENABLED: "false" }, () => {
      assert.equal(resolveSnapshotConfig().enabled, false);
    });
  });

  test("FELICITY_SNAPSHOT_MS sets interval", () => {
    withEnv({ FELICITY_SNAPSHOT_MS: "300000" }, () => {
      assert.equal(resolveSnapshotConfig().ms, 300_000);
    });
  });

  test("FELICITY_SNAPSHOT_MS below minimum is clamped to 60s", () => {
    withEnv({ FELICITY_SNAPSHOT_MS: "1000" }, () => {
      assert.equal(resolveSnapshotConfig().ms, 60_000);
    });
  });

  test("FELICITY_SNAPSHOT_MS above maximum is clamped to 1h", () => {
    withEnv({ FELICITY_SNAPSHOT_MS: "9999999" }, () => {
      assert.equal(resolveSnapshotConfig().ms, 60 * 60 * 1000);
    });
  });

  test("FELICITY_SNAPSHOT_DAYS sets intraday retention", () => {
    withEnv({ FELICITY_SNAPSHOT_DAYS: "7", FELICITY_SNAPSHOT_MS: String(10 * 60 * 1000) }, () => {
      const { ms, maxIntra } = resolveSnapshotConfig();
      assert.equal(maxIntra, Math.ceil((7 * 24 * 60 * 60 * 1000) / ms));
    });
  });

  test("FELICITY_SNAPSHOT_DAYS below minimum is clamped to 1", () => {
    withEnv({ FELICITY_SNAPSHOT_DAYS: "0" }, () => {
      const { ms, maxIntra } = resolveSnapshotConfig();
      assert.equal(maxIntra, Math.ceil((1 * 24 * 60 * 60 * 1000) / ms));
    });
  });

  test("FELICITY_SNAPSHOT_DAYS above maximum is clamped to 30", () => {
    withEnv({ FELICITY_SNAPSHOT_DAYS: "999" }, () => {
      const { ms, maxIntra } = resolveSnapshotConfig();
      assert.equal(maxIntra, Math.ceil((30 * 24 * 60 * 60 * 1000) / ms));
    });
  });

  test("FELICITY_DAILY_DAYS overrides 90-day default", () => {
    withEnv({ FELICITY_DAILY_DAYS: "180" }, () => {
      assert.equal(resolveSnapshotConfig().ddays, 180);
    });
  });

  test("FELICITY_DAILY_DAYS below minimum is clamped to 7", () => {
    withEnv({ FELICITY_DAILY_DAYS: "3" }, () => {
      assert.equal(resolveSnapshotConfig().ddays, 7);
    });
  });

  test("FELICITY_DAILY_DAYS above maximum is clamped to 365", () => {
    withEnv({ FELICITY_DAILY_DAYS: "10000" }, () => {
      assert.equal(resolveSnapshotConfig().ddays, 365);
    });
  });

  test("non-numeric FELICITY_SNAPSHOT_MS produces NaN (clamp does not handle NaN)", () => {
    withEnv({ FELICITY_SNAPSHOT_MS: "abc" }, () => {
      // parseInt("abc") = NaN; Math.max/min with NaN propagates NaN — known limitation
      assert.ok(Number.isNaN(resolveSnapshotConfig().ms));
    });
  });
});

// ── makeCheckAuth — no key configured ─────────────────────────────────────────

describe("makeCheckAuth — no key configured", () => {
  test("allows all requests when apiKey is null", () => {
    const check = makeCheckAuth(null);
    const res   = makeRes();
    const req   = makeReq({ headers: {} });
    assert.equal(check(req, res as unknown as http.ServerResponse), true);
    assert.equal(res.status, null);
  });
});

// ── makeCheckAuth — key configured ───────────────────────────────────────────

describe("makeCheckAuth — key configured", () => {
  const KEY   = "test-api-key-abc123";
  const check = makeCheckAuth(KEY);

  test("missing header → 401", () => {
    const res = makeRes();
    const req = makeReq({ headers: {} });
    assert.equal(check(req, res as unknown as http.ServerResponse), false);
    assert.equal(res.status, HTTP_STATUS_UNAUTHORIZED);
  });

  test("wrong Bearer token → 401", () => {
    const res = makeRes();
    const req = makeReq({ headers: { authorization: "Bearer wrong-key" } });
    assert.equal(check(req, res as unknown as http.ServerResponse), false);
    assert.equal(res.status, HTTP_STATUS_UNAUTHORIZED);
  });

  test("correct Bearer token → passes", () => {
    const res = makeRes();
    const req = makeReq({ headers: { authorization: `Bearer ${KEY}` } });
    assert.equal(check(req, res as unknown as http.ServerResponse), true);
    assert.equal(res.status, null);
  });

  test("correct X-API-Key header → passes", () => {
    const res = makeRes();
    const req = makeReq({ headers: { "x-api-key": KEY } });
    assert.equal(check(req, res as unknown as http.ServerResponse), true);
    assert.equal(res.status, null);
  });

  test("wrong X-API-Key → 401", () => {
    const res = makeRes();
    const req = makeReq({ headers: { "x-api-key": "wrong" } });
    assert.equal(check(req, res as unknown as http.ServerResponse), false);
    assert.equal(res.status, HTTP_STATUS_UNAUTHORIZED);
  });

  test("empty Authorization header → 401", () => {
    const res = makeRes();
    const req = makeReq({ headers: { authorization: "" } });
    assert.equal(check(req, res as unknown as http.ServerResponse), false);
    assert.equal(res.status, HTTP_STATUS_UNAUTHORIZED);
  });
});

// ── makeCheckAuth — query-string key rejection ────────────────────────────────

describe("makeCheckAuth — query-string key rejection", () => {
  const KEY   = "test-api-key-abc123";
  const check = makeCheckAuth(KEY);

  test("?key=<correct> → 401 with explicit message", () => {
    const res = makeRes();
    const req = makeReq({ url: `/batteries?key=${KEY}`, headers: {} });
    assert.equal(check(req, res as unknown as http.ServerResponse), false);
    assert.equal(res.status, HTTP_STATUS_UNAUTHORIZED);
    const body = JSON.parse(res.body ?? "{}") as Record<string, string>;
    assert.match(body.error, /query string/i);
  });

  test("?api_key=<correct> → 401 with explicit message", () => {
    const res = makeRes();
    const req = makeReq({ url: `/batteries?api_key=${KEY}`, headers: {} });
    assert.equal(check(req, res as unknown as http.ServerResponse), false);
    assert.equal(res.status, HTTP_STATUS_UNAUTHORIZED);
  });

  test("?key= even with correct header → 401 (query string checked first)", () => {
    const res = makeRes();
    const req = makeReq({ url: `/batteries?key=wrong`, headers: { authorization: `Bearer ${KEY}` } });
    assert.equal(check(req, res as unknown as http.ServerResponse), false);
    assert.equal(res.status, HTTP_STATUS_UNAUTHORIZED);
  });

  test("?other_param= with correct header → passes (non-key param ignored)", () => {
    const res = makeRes();
    const req = makeReq({ url: `/batteries?id=123`, headers: { authorization: `Bearer ${KEY}` } });
    assert.equal(check(req, res as unknown as http.ServerResponse), true);
  });
});

// ── makeRateLimit ─────────────────────────────────────────────────────────────

describe("makeRateLimit", () => {
  test("rateLimit=0 disables rate limiting (always passes)", () => {
    const { checkRateLimit, stopPurge } = makeRateLimit(0);
    try {
      for (let i = 0; i < 200; i++) {
        const res = makeRes();
        const req = makeReq({ socket: { remoteAddress: "1.2.3.4" } });
        assert.equal(checkRateLimit(req, res as unknown as http.ServerResponse), true);
      }
    } finally { stopPurge(); }
  });

  test("exceeding limit returns 429", () => {
    const { checkRateLimit, stopPurge } = makeRateLimit(2);
    try {
      const ip = "5.6.7.8";
      let passed = 0;
      let rejected = 0;
      for (let i = 0; i < 5; i++) {
        const res = makeRes();
        const req = makeReq({ socket: { remoteAddress: ip } });
        if (checkRateLimit(req, res as unknown as http.ServerResponse)) passed++;
        else { rejected++; assert.equal(res.status, HTTP_STATUS_TOO_MANY_REQUESTS); }
      }
      assert.equal(passed, 2);
      assert.equal(rejected, 3);
    } finally { stopPurge(); }
  });

  test("different IPs have independent buckets", () => {
    const { checkRateLimit, stopPurge } = makeRateLimit(1);
    try {
      const res1 = makeRes();
      const res2 = makeRes();
      checkRateLimit(makeReq({ socket: { remoteAddress: "10.0.0.1" } }), res1 as unknown as http.ServerResponse);
      const r2 = makeRes();
      // ip1 is now exhausted (limit=1); ip2 should still pass
      assert.equal(checkRateLimit(makeReq({ socket: { remoteAddress: "10.0.0.2" } }), res2 as unknown as http.ServerResponse), true);
      assert.equal(checkRateLimit(makeReq({ socket: { remoteAddress: "10.0.0.1" } }), r2  as unknown as http.ServerResponse), false);
    } finally { stopPurge(); }
  });

  test("X-Forwarded-For used when trustProxy=true", () => {
    const { checkRateLimit, stopPurge } = makeRateLimit(1, true);
    try {
      const req = makeReq({
        socket:  { remoteAddress: "127.0.0.1" },
        headers: { "x-forwarded-for": "203.0.113.1" },
      });
      // First request passes
      assert.equal(checkRateLimit(req, makeRes() as unknown as http.ServerResponse), true);
      // Second request from same forwarded IP → rejected
      const res2 = makeRes();
      assert.equal(checkRateLimit(req, res2 as unknown as http.ServerResponse), false);
      assert.equal(res2.status, HTTP_STATUS_TOO_MANY_REQUESTS);
    } finally { stopPurge(); }
  });
});

// ── makeGetAllowedOrigin ──────────────────────────────────────────────────────

describe("makeGetAllowedOrigin", () => {
  test("no Origin header → returns null", () => {
    const fn  = makeGetAllowedOrigin(null);
    const req = makeReq({ headers: {} });
    assert.equal(fn(req), null);
  });

  test("localhost origin → reflected", () => {
    const fn  = makeGetAllowedOrigin(null);
    const req = makeReq({ headers: { origin: "http://localhost:3000" } });
    assert.equal(fn(req), "http://localhost:3000");
  });

  test("external origin → null (blocked)", () => {
    const fn  = makeGetAllowedOrigin(null);
    const req = makeReq({ headers: { origin: "https://evil.example.com" } });
    assert.equal(fn(req), null);
  });

  test("explicit corsOrigin overrides everything", () => {
    const fn  = makeGetAllowedOrigin("https://dashboard.internal");
    const req = makeReq({ headers: { origin: "https://evil.example.com" } });
    assert.equal(fn(req), "https://dashboard.internal");
  });

  test("malformed origin header → null (no throw)", () => {
    const fn  = makeGetAllowedOrigin(null);
    const req = makeReq({ headers: { origin: "not-a-url" } });
    assert.equal(fn(req), null);
  });

  test("null origin string → null (sandboxed iframe blocked)", () => {
    const fn  = makeGetAllowedOrigin(null);
    const req = makeReq({ headers: { origin: "null" } });
    assert.equal(fn(req), null);
  });
});
