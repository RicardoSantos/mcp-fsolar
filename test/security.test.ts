/**
 * Security test suite — runs against a live server.
 *
 * Usage:
 *   FELICITY_USER=x FELICITY_PASS=y FELICITY_API_KEY=secret node --test dist/test/security.test.js
 *
 * The server must already be running on FELICITY_PORT (default 3010).
 * Set FELICITY_API_KEY in both the server env and this script's env.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { constants } from "node:http2";

const { HTTP_STATUS_OK, HTTP_STATUS_CREATED, HTTP_STATUS_NO_CONTENT,
        HTTP_STATUS_BAD_REQUEST, HTTP_STATUS_UNAUTHORIZED,
        HTTP_STATUS_NOT_FOUND, HTTP_STATUS_PAYLOAD_TOO_LARGE } = constants;

const PORT    = parseInt(process.env.FELICITY_PORT ?? "3010", 10);
const API_KEY = process.env.FELICITY_API_KEY ?? null;
const BASE    = `http://localhost:${PORT}`;

// ── helpers ───────────────────────────────────────────────────────────────────

interface ReqResult {
  status:  number;
  headers: http.IncomingHttpHeaders;
  body:    unknown;
  raw:     string;
  error?:  string;
}

function req(
  method: string,
  path: string,
  { headers = {}, body }: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<ReqResult> {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : undefined;
    let settled = false;
    const settle = (result: ReqResult) => { if (!settled) { settled = true; resolve(result); } };

    const r = http.request(
      {
        hostname: "localhost", port: PORT, path, method,
        headers: {
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c: Buffer) => (data += c));
        res.on("end", () => {
          let json: unknown;
          try { json = JSON.parse(data); } catch { json = data; }
          settle({ status: res.statusCode ?? 0, headers: res.headers, body: json, raw: data });
        });
      },
    );
    r.on("error", (e) => settle({ status: 0, headers: {}, body: null, raw: "", error: e.message }));
    if (payload) r.write(payload);
    r.end();
  });
}

function authHeaders(): Record<string, string> {
  return API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {};
}

let serverUp = false;

before(async () => {
  const r = await req("GET", "/batteries");
  serverUp = r.status !== 0;
  if (!serverUp)
    process.stderr.write(`[security] server not reachable on port ${PORT} — all live tests skipped\n`);
});

function guard(t: { skip(reason?: string): void }): boolean {
  if (!serverUp) { t.skip(`server not running on port ${PORT}`); return false; }
  return true;
}

// ── 1. Authentication ─────────────────────────────────────────────────────────

describe("authentication", () => {
  it("no API key set → GET /batteries returns 200", { skip: !!API_KEY }, async (t) => {
    if (!guard(t)) return;
    const r = await req("GET", "/batteries");
    assert.equal(r.status, HTTP_STATUS_OK);
  });

  it("wrong key → 401", { skip: !API_KEY }, async (t) => {
    if (!guard(t)) return;
    const r = await req("GET", "/batteries", { headers: { Authorization: "Bearer wrongkey" } });
    assert.equal(r.status, HTTP_STATUS_UNAUTHORIZED);
    assert.ok((r.body as Record<string, unknown>)?.error, "should return error field");
  });

  it("missing key → 401", { skip: !API_KEY }, async (t) => {
    if (!guard(t)) return;
    const r = await req("GET", "/batteries");
    assert.equal(r.status, HTTP_STATUS_UNAUTHORIZED);
  });

  it("correct key via Authorization: Bearer → 200", { skip: !API_KEY }, async (t) => {
    if (!guard(t)) return;
    const r = await req("GET", "/batteries", { headers: { Authorization: `Bearer ${API_KEY}` } });
    assert.notEqual(r.status, HTTP_STATUS_UNAUTHORIZED, "valid key should not be rejected");
  });

  it("correct key via X-API-Key → 200", { skip: !API_KEY }, async (t) => {
    if (!guard(t)) return;
    const r = await req("GET", "/batteries", { headers: { "X-API-Key": API_KEY! } });
    assert.notEqual(r.status, HTTP_STATUS_UNAUTHORIZED, "X-API-Key header should be accepted");
  });

  it("key embedded in URL query string → 401 (not supported)", { skip: !API_KEY }, async (t) => {
    if (!guard(t)) return;
    const r = await req("GET", `/batteries?key=${API_KEY}`);
    assert.equal(r.status, HTTP_STATUS_UNAUTHORIZED, "key in URL must not bypass auth");
  });

  it("API key timing: wrong key responds in similar time to correct key", { skip: !API_KEY }, async (t) => {
    if (!guard(t)) return;
    const RUNS = 10;
    async function measure(key: string) {
      const times: number[] = [];
      for (let i = 0; i < RUNS; i++) {
        const start = Date.now();
        await req("GET", "/batteries", { headers: { Authorization: `Bearer ${key}` } });
        times.push(Date.now() - start);
      }
      return times.reduce((a, b) => a + b, 0) / RUNS;
    }
    const correct = await measure(API_KEY!);
    const wrong   = await measure("a".repeat(API_KEY!.length));
    const diff    = Math.abs(correct - wrong);
    assert.ok(diff < 50, `timing difference too large: correct=${correct.toFixed(1)}ms wrong=${wrong.toFixed(1)}ms diff=${diff.toFixed(1)}ms`);
  });

  it("/sse endpoint does not require auth key", { skip: !API_KEY }, async (t) => {
    if (!guard(t)) return;
    const r = await new Promise<{ status: number }>((resolve) => {
      const req2 = http.request({ hostname: "localhost", port: PORT, path: "/sse", method: "GET" }, (res) => {
        res.destroy();
        resolve({ status: res.statusCode ?? 0 });
      });
      req2.on("error", () => resolve({ status: 0 }));
      req2.end();
    });
    assert.notEqual(r.status, 401, "/sse must be accessible without API key (used by MCP client)");
  });
});

// ── 2. CORS ───────────────────────────────────────────────────────────────────

describe("CORS", () => {
  it("no Origin header → no Access-Control-Allow-Origin in response", async (t) => {
    if (!guard(t)) return;
    const r = await req("GET", "/batteries", { headers: authHeaders() });
    assert.ok(!r.headers["access-control-allow-origin"], "should not set CORS header when no Origin sent");
  });

  it("localhost origin → reflected in response", async (t) => {
    if (!guard(t)) return;
    const r = await req("GET", "/batteries", { headers: { ...authHeaders(), Origin: "http://localhost:3000" } });
    assert.equal(r.headers["access-control-allow-origin"], "http://localhost:3000");
  });

  it("external origin → no Access-Control-Allow-Origin", async (t) => {
    if (!guard(t)) return;
    const r = await req("GET", "/batteries", { headers: { ...authHeaders(), Origin: "https://evil.com" } });
    assert.ok(
      !r.headers["access-control-allow-origin"] || r.headers["access-control-allow-origin"] === "null",
      "external origin must not be reflected",
    );
  });

  it("null origin (sandboxed iframe) → no Access-Control-Allow-Origin", async (t) => {
    if (!guard(t)) return;
    const r = await req("GET", "/batteries", { headers: { ...authHeaders(), Origin: "null" } });
    assert.ok(!r.headers["access-control-allow-origin"], "null origin must not be allowed");
  });

  it("OPTIONS preflight from localhost → 204 with allow header", async (t) => {
    if (!guard(t)) return;
    const r = await req("OPTIONS", "/batteries", { headers: { Origin: "http://localhost:4000", "Access-Control-Request-Method": "GET" } });
    assert.equal(r.status, HTTP_STATUS_NO_CONTENT);
    assert.equal(r.headers["access-control-allow-origin"], "http://localhost:4000");
  });

  it("OPTIONS preflight from external origin → no allow header", async (t) => {
    if (!guard(t)) return;
    const r = await req("OPTIONS", "/batteries", { headers: { Origin: "https://attacker.example", "Access-Control-Request-Method": "GET" } });
    assert.ok(!r.headers["access-control-allow-origin"], "preflight from external origin must not be granted");
  });
});

// ── 3. Path traversal ─────────────────────────────────────────────────────────

describe("path traversal", () => {
  const traversalIds = [
    "../etc/passwd",
    "..%2Fetc%2Fpasswd",
    "Bat1/../../etc/passwd",
    ".",
    "%2e%2e%2fetc%2fpasswd",
  ];

  for (const id of traversalIds) {
    it(`/batteries/${id} → 404 not found (not a file read)`, async (t) => {
      if (!guard(t)) return;
      const r = await req("GET", `/batteries/${encodeURIComponent(id)}`, { headers: authHeaders() });
      assert.ok(r.status === HTTP_STATUS_NOT_FOUND || (r.status === HTTP_STATUS_OK && !r.raw?.includes("root:")),
        `path traversal must not expose file contents (got ${r.status})`);
    });
  }

  const badStores = [
    "../etc/passwd",
    "..%2Fetc%2Fpasswd",
    "intraday/../../../etc/passwd",
    "unknown",
  ];

  for (const store of badStores) {
    it(`GET /snapshots/${store} → 404 unknown store`, async (t) => {
      if (!guard(t)) return;
      const r = await req("GET", `/snapshots/${store}`, { headers: authHeaders() });
      assert.equal(r.status, HTTP_STATUS_NOT_FOUND);
      assert.ok(!r.raw?.includes("root:"), "must not expose file contents");
    });
  }
});

// ── 4. Webhook SSRF & URL validation ──────────────────────────────────────────

describe("webhook URL validation", () => {
  const bad = [
    { url: "file:///etc/passwd",          label: "file:// protocol" },
    { url: "ftp://evil.com/",             label: "ftp:// protocol" },
    { url: "javascript:alert(1)",         label: "javascript: protocol" },
    { url: "data:text/plain,hello",       label: "data: protocol" },
    { url: "not-a-url",                   label: "not a URL" },
    { url: "",                            label: "empty string" },
    { url: "http://",                     label: "bare http://" },
  ];

  for (const { url, label } of bad) {
    it(`rejects ${label}`, async (t) => {
      if (!guard(t)) return;
      const r = await req("POST", "/hooks", { headers: authHeaders(), body: { url } });
      assert.equal(r.status, HTTP_STATUS_BAD_REQUEST, `expected 400 for "${url}" but got ${r.status}`);
    });
  }

  it("accepts valid https URL", async (t) => {
    if (!guard(t)) return;
    const r = await req("POST", "/hooks", { headers: authHeaders(), body: { url: "https://webhook.example.com/felicity" } });
    assert.ok(r.status === HTTP_STATUS_CREATED || r.status === HTTP_STATUS_OK, `expected 201 for valid https URL, got ${r.status}`);
    if (r.body) {
      const bodyId: string | null = typeof r.body === "string"
        ? r.body.replace(/"/g, "")
        : (r.body as { id?: string } | null)?.id ?? null;
      if (bodyId) await req("DELETE", `/hooks/${bodyId}`, { headers: authHeaders() });
    }
  });

  it("accepts valid http URL", async (t) => {
    if (!guard(t)) return;
    const r = await req("POST", "/hooks", { headers: authHeaders(), body: { url: "http://webhook.example.com/felicity" } });
    assert.ok(r.status === HTTP_STATUS_CREATED || r.status === HTTP_STATUS_OK, `expected 201 for valid http URL, got ${r.status}`);
    if (r.body) {
      const bodyId: string | null = typeof r.body === "string"
        ? r.body.replace(/"/g, "")
        : (r.body as { id?: string } | null)?.id ?? null;
      if (bodyId) await req("DELETE", `/hooks/${bodyId}`, { headers: authHeaders() });
    }
  });
});

// ── 5. Request body limits ────────────────────────────────────────────────────

describe("request size limits", () => {
  it("POST /hooks with body > 64 KB is rejected", async (t) => {
    if (!guard(t)) return;
    const hooksBefore = ((await req("GET", "/hooks", { headers: authHeaders() })).body ?? []) as unknown[];
    const r = await req("POST", "/hooks", {
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: { url: "https://x.com/large-body-test", padding: "x".repeat(66_000) },
    });
    assert.ok(r.status === HTTP_STATUS_PAYLOAD_TOO_LARGE || r.status === 0,
      `expected rejection (413 or connection reset) for oversized body, got ${r.status}`);
    const hooksAfter = ((await req("GET", "/hooks", { headers: authHeaders() })).body ?? []) as unknown[];
    assert.equal(hooksAfter.length, hooksBefore.length, "oversized body must not create a new hook");
  });
});

// ── 6. Security headers ───────────────────────────────────────────────────────

describe("security headers", () => {
  it("X-Content-Type-Options: nosniff present", async (t) => {
    if (!guard(t)) return;
    const r = await req("GET", "/batteries", { headers: authHeaders() });
    assert.equal(r.headers["x-content-type-options"], "nosniff",
      "missing X-Content-Type-Options: nosniff");
  });

  it("no Server header leaking implementation details", async (t) => {
    if (!guard(t)) return;
    const r      = await req("GET", "/batteries", { headers: authHeaders() });
    const server = (r.headers["server"] as string | undefined) ?? "";
    assert.ok(!server.toLowerCase().includes("node"), `Server header exposes runtime: ${server}`);
  });
});

// ── 7. DELETE /hooks/:id ──────────────────────────────────────────────────────

describe("DELETE /hooks/:id", () => {
  it("deleting non-existent id → 404", async (t) => {
    if (!guard(t)) return;
    const r = await req("DELETE", "/hooks/doesnotexist", { headers: authHeaders() });
    assert.equal(r.status, 404);
  });

  it("deleting existing hook → 200", async (t) => {
    if (!guard(t)) return;
    const add = await req("POST", "/hooks", { headers: authHeaders(), body: { url: "https://example.com/wh" } });
    assert.ok(add.status === HTTP_STATUS_OK || add.status === HTTP_STATUS_CREATED);
    const bodyId: string | null = typeof add.body === "string"
      ? add.body.replace(/"/g, "")
      : (add.body as { id?: string } | null)?.id ?? null;
    const del = await req("DELETE", `/hooks/${bodyId}`, { headers: authHeaders() });
    assert.equal(del.status, HTTP_STATUS_OK);
  });
});
