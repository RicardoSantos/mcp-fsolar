import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { constants } from "node:http2";

import { createServer }    from "../server";
import { FelicityClient }  from "../src/client";

const { HTTP_STATUS_OK, HTTP_STATUS_NOT_FOUND, HTTP_STATUS_UNAUTHORIZED } = constants;

const API_KEY = "test-key-server";

// ── Minimal mock client ───────────────────────────────────────────────────────

function makeMockClient(): FelicityClient {
  return {
    getBatteries: async () => ({ batteries: [], fetchedAt: new Date().toISOString(), fromCache: false, trend: {} }),
    getBattery:   async () => ({ battery: null, fetchedAt: new Date().toISOString(), fromCache: false }),
  } as unknown as FelicityClient;
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

interface ReqResult {
  status:  number;
  headers: http.IncomingHttpHeaders;
  body:    unknown;
}

function req(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<ReqResult> {
  return new Promise((resolve, reject) => {
    const r = http.request({ hostname: "localhost", port, path, method, headers }, (res) => {
      let data = "";
      res.on("data", (c: Buffer) => (data += c));
      res.on("end", () => {
        let body: unknown;
        try { body = JSON.parse(data); } catch { body = data; }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
      });
    });
    r.on("error", reject);
    r.end();
  });
}

function auth(): Record<string, string> {
  return { Authorization: `Bearer ${API_KEY}` };
}

// ── Setup ─────────────────────────────────────────────────────────────────────

let port = 0;
let close: () => Promise<void>;

before(async () => {
  const result = createServer(makeMockClient(), { port: 0, apiKey: API_KEY, rateLimit: 0 });
  await new Promise<void>((resolve) => result.httpServer.listen(0, "127.0.0.1", resolve));
  port  = (result.httpServer.address() as { port: number }).port;
  close = result.close;
});

after(() => close());

// ── Auth enforcement ──────────────────────────────────────────────────────────

test("GET /batteries — no key → 401", async () => {
  const r = await req(port, "GET", "/batteries");
  assert.equal(r.status, HTTP_STATUS_UNAUTHORIZED);
});

test("GET /batteries — wrong key → 401", async () => {
  const r = await req(port, "GET", "/batteries", { Authorization: "Bearer wrong" });
  assert.equal(r.status, HTTP_STATUS_UNAUTHORIZED);
});

test("GET /batteries — valid key → 200", async () => {
  const r = await req(port, "GET", "/batteries", auth());
  assert.equal(r.status, HTTP_STATUS_OK);
  const body = r.body as Record<string, unknown>;
  assert.ok(Array.isArray(body.batteries), "body.batteries should be an array");
});

// ── Route correctness ─────────────────────────────────────────────────────────

test("GET /batteries — returns empty array when no batteries", async () => {
  const r    = await req(port, "GET", "/batteries", auth());
  const body = r.body as Record<string, unknown>;
  assert.deepEqual(body.batteries, []);
});

test("GET /batteries/:id — unknown battery → 404", async () => {
  const r = await req(port, "GET", "/batteries/UNKNOWN", auth());
  assert.equal(r.status, HTTP_STATUS_NOT_FOUND);
});

test("GET /health — returns ok=true and 200 (no auth required)", async () => {
  const r    = await req(port, "GET", "/health");
  assert.equal(r.status, HTTP_STATUS_OK);
  assert.equal((r.body as Record<string, unknown>).ok, true);
});

test("GET /hooks — returns array", async () => {
  const r = await req(port, "GET", "/hooks", auth());
  assert.equal(r.status, HTTP_STATUS_OK);
  assert.ok(Array.isArray(r.body), "hooks list should be an array");
});

test("GET /unknown-route — 404", async () => {
  const r = await req(port, "GET", "/unknown-route", auth());
  assert.equal(r.status, HTTP_STATUS_NOT_FOUND);
});

test("response has JSON content-type", async () => {
  const r = await req(port, "GET", "/batteries", auth());
  assert.ok(
    (r.headers["content-type"] ?? "").includes("application/json"),
    `expected JSON content-type, got: ${r.headers["content-type"]}`,
  );
});
