"use strict";

/**
 * Security test suite — runs against a live server.
 *
 * Usage:
 *   FELICITY_USER=x FELICITY_PASS=y FELICITY_API_KEY=secret node --test test/security.test.js
 *
 * The server must already be running on FELICITY_PORT (default 3010).
 * Set FELICITY_API_KEY in both the server env and this script's env.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const http   = require("node:http");
const { constants: { HTTP_STATUS_OK, HTTP_STATUS_CREATED, HTTP_STATUS_NO_CONTENT, HTTP_STATUS_BAD_REQUEST, HTTP_STATUS_UNAUTHORIZED, HTTP_STATUS_NOT_FOUND, HTTP_STATUS_PAYLOAD_TOO_LARGE } } = require("node:http2");

const PORT    = parseInt(process.env.FELICITY_PORT ?? "3010", 10);
const API_KEY = process.env.FELICITY_API_KEY ?? null;
const BASE    = `http://localhost:${PORT}`;

// ── helpers ───────────────────────────────────────────────────────────────────

function req(method, path, { headers = {}, body } = {}) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : undefined;
    let settled = false;
    const settle = (result) => { if (!settled) { settled = true; resolve(result); } };

    const r = http.request(
      { hostname: "localhost", port: PORT, path, method,
        headers: { ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}), ...headers } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        // Resolve as soon as we have a complete response — even if the write-side
        // later gets "socket hang up" (common when server closes mid-upload).
        res.on("end", () => {
          let json;
          try { json = JSON.parse(data); } catch { json = data; }
          settle({ status: res.statusCode, headers: res.headers, body: json, raw: data });
        });
      }
    );
    // Only resolve with error if no response was received at all.
    r.on("error", (e) => settle({ status: 0, error: e.message }));
    if (payload) r.write(payload);
    r.end();
  });
}

function authHeaders() {
  return API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {};
}

// ── 1. Authentication ─────────────────────────────────────────────────────────

describe("authentication", () => {
  it("no API key set → GET /batteries returns 200", { skip: !!API_KEY }, async () => {
    const r = await req("GET", "/batteries");
    assert.equal(r.status, HTTP_STATUS_OK);
  });

  it("wrong key → 401", { skip: !API_KEY }, async () => {
    const r = await req("GET", "/batteries", { headers: { Authorization: "Bearer wrongkey" } });
    assert.equal(r.status, HTTP_STATUS_UNAUTHORIZED);
    assert.ok(r.body?.error, "should return error field");
  });

  it("missing key → 401", { skip: !API_KEY }, async () => {
    const r = await req("GET", "/batteries");
    assert.equal(r.status, HTTP_STATUS_UNAUTHORIZED);
  });

  it("correct key via Authorization: Bearer → 200", { skip: !API_KEY }, async () => {
    const r = await req("GET", "/batteries", { headers: { Authorization: `Bearer ${API_KEY}` } });
    assert.notEqual(r.status, HTTP_STATUS_UNAUTHORIZED, "valid key should not be rejected");
  });

  it("correct key via X-API-Key → 200", { skip: !API_KEY }, async () => {
    const r = await req("GET", "/batteries", { headers: { "X-API-Key": API_KEY } });
    assert.notEqual(r.status, HTTP_STATUS_UNAUTHORIZED, "X-API-Key header should be accepted");
  });

  it("key embedded in URL query string → 401 (not supported)", { skip: !API_KEY }, async () => {
    const r = await req("GET", `/batteries?key=${API_KEY}`);
    assert.equal(r.status, HTTP_STATUS_UNAUTHORIZED, "key in URL must not bypass auth");
  });

  it("API key timing: wrong key responds in similar time to correct key", { skip: !API_KEY }, async () => {
    const RUNS = 10;
    async function measure(key) {
      const times = [];
      for (let i = 0; i < RUNS; i++) {
        const t = Date.now();
        await req("GET", "/batteries", { headers: { Authorization: `Bearer ${key}` } });
        times.push(Date.now() - t);
      }
      return times.reduce((a, b) => a + b, 0) / RUNS;
    }
    const correct = await measure(API_KEY);
    const wrong   = await measure("a".repeat(API_KEY.length));
    const diff    = Math.abs(correct - wrong);
    // Allow 50 ms variance — network + event loop jitter. A timing leak would be >> 50 ms.
    assert.ok(diff < 50, `timing difference too large: correct=${correct.toFixed(1)}ms wrong=${wrong.toFixed(1)}ms diff=${diff.toFixed(1)}ms`);
  });

  it("/sse endpoint does not require auth key", { skip: !API_KEY }, async () => {
    // SSE opens a long-lived connection; just check it doesn't 401 immediately.
    const r = await new Promise((resolve) => {
      const req2 = http.request({ hostname: "localhost", port: PORT, path: "/sse", method: "GET" }, (res) => {
        res.destroy();
        resolve({ status: res.statusCode });
      });
      req2.on("error", () => resolve({ status: 0 }));
      req2.end();
    });
    assert.notEqual(r.status, 401, "/sse must be accessible without API key (used by MCP client)");
  });
});

// ── 2. CORS ───────────────────────────────────────────────────────────────────

describe("CORS", () => {
  it("no Origin header → no Access-Control-Allow-Origin in response", async () => {
    const r = await req("GET", "/batteries", { headers: authHeaders() });
    assert.ok(!r.headers["access-control-allow-origin"], "should not set CORS header when no Origin sent");
  });

  it("localhost origin → reflected in response", async () => {
    const r = await req("GET", "/batteries", { headers: { ...authHeaders(), Origin: "http://localhost:3000" } });
    assert.equal(r.headers["access-control-allow-origin"], "http://localhost:3000");
  });

  it("external origin → no Access-Control-Allow-Origin", async () => {
    const r = await req("GET", "/batteries", { headers: { ...authHeaders(), Origin: "https://evil.com" } });
    assert.ok(
      !r.headers["access-control-allow-origin"] || r.headers["access-control-allow-origin"] === "null",
      "external origin must not be reflected"
    );
  });

  it("null origin (sandboxed iframe) → no Access-Control-Allow-Origin", async () => {
    const r = await req("GET", "/batteries", { headers: { ...authHeaders(), Origin: "null" } });
    assert.ok(!r.headers["access-control-allow-origin"], "null origin must not be allowed");
  });

  it("OPTIONS preflight from localhost → 204 with allow header", async () => {
    const r = await req("OPTIONS", "/batteries", { headers: { Origin: "http://localhost:4000", "Access-Control-Request-Method": "GET" } });
    assert.equal(r.status, HTTP_STATUS_NO_CONTENT);
    assert.equal(r.headers["access-control-allow-origin"], "http://localhost:4000");
  });

  it("OPTIONS preflight from external origin → no allow header", async () => {
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
    it(`/batteries/${id} → 404 not found (not a file read)`, async () => {
      const r = await req("GET", `/batteries/${encodeURIComponent(id)}`, { headers: authHeaders() });
      // Must not leak file contents; 404 or 200 with "not found" battery is both acceptable
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
    it(`GET /snapshots/${store} → 404 unknown store`, async () => {
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
    it(`rejects ${label}`, async () => {
      const r = await req("POST", "/hooks", { headers: authHeaders(), body: { url } });
      assert.equal(r.status, HTTP_STATUS_BAD_REQUEST, `expected 400 for "${url}" but got ${r.status}`);
    });
  }

  it("accepts valid https URL", async () => {
    const r = await req("POST", "/hooks", { headers: authHeaders(), body: { url: "https://webhook.example.com/felicity" } });
    assert.ok(r.status === HTTP_STATUS_CREATED || r.status === HTTP_STATUS_OK, `expected 201 for valid https URL, got ${r.status}`);
    // clean up
    if (r.body) {
      const id = typeof r.body === "string" ? r.body.replace(/"/g, "") : r.body.id;
      if (id) await req("DELETE", `/hooks/${id}`, { headers: authHeaders() });
    }
  });

  it("accepts valid http URL", async () => {
    const r = await req("POST", "/hooks", { headers: authHeaders(), body: { url: "http://webhook.example.com/felicity" } });
    assert.ok(r.status === HTTP_STATUS_CREATED || r.status === HTTP_STATUS_OK, `expected 201 for valid http URL, got ${r.status}`);
    if (r.body) {
      const id = typeof r.body === "string" ? r.body.replace(/"/g, "") : r.body.id;
      if (id) await req("DELETE", `/hooks/${id}`, { headers: authHeaders() });
    }
  });
});

// ── 5. Request body limits ────────────────────────────────────────────────────

describe("request size limits", () => {
  it("POST /hooks with body > 64 KB is rejected", async () => {
    // MAX_BODY_SIZE = 65_536. 66_000 padding chars → ~66_038 byte body.
    const hooksBefore = (await req("GET", "/hooks", { headers: authHeaders() })).body ?? [];
    const r = await req("POST", "/hooks", {
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: { url: "https://x.com/large-body-test", padding: "x".repeat(66_000) },
    });
    // Server may respond 413, or close the connection (status 0 = socket hang-up).
    // Both mean the request was rejected. The key assertion: no new hook was created.
    assert.ok(r.status === HTTP_STATUS_PAYLOAD_TOO_LARGE || r.status === 0,
      `expected rejection (413 or connection reset) for oversized body, got ${r.status}`);
    const hooksAfter = (await req("GET", "/hooks", { headers: authHeaders() })).body ?? [];
    assert.equal(hooksAfter.length, hooksBefore.length, "oversized body must not create a new hook");
  });
});

// ── 6. Security headers ───────────────────────────────────────────────────────

describe("security headers", () => {
  it("X-Content-Type-Options: nosniff present", async () => {
    const r = await req("GET", "/batteries", { headers: authHeaders() });
    assert.equal(r.headers["x-content-type-options"], "nosniff",
      "missing X-Content-Type-Options: nosniff");
  });

  it("no Server header leaking implementation details", async () => {
    const r = await req("GET", "/batteries", { headers: authHeaders() });
    const server = r.headers["server"] ?? "";
    assert.ok(!server.toLowerCase().includes("node"), `Server header exposes runtime: ${server}`);
  });
});

// ── 7. DELETE /hooks/:id ──────────────────────────────────────────────────────

describe("DELETE /hooks/:id", () => {
  it("deleting non-existent id → 404", async () => {
    const r = await req("DELETE", "/hooks/doesnotexist", { headers: authHeaders() });
    assert.equal(r.status, 404);
  });

  it("deleting existing hook → 200", async () => {
    const add = await req("POST", "/hooks", { headers: authHeaders(), body: { url: "https://example.com/wh" } });
    assert.ok(add.status === HTTP_STATUS_OK || add.status === HTTP_STATUS_CREATED);
    const id = typeof add.body === "string" ? add.body.replace(/"/g, "") : add.body.id ?? add.body;
    const del = await req("DELETE", `/hooks/${id}`, { headers: authHeaders() });
    assert.equal(del.status, HTTP_STATUS_OK);
  });
});
