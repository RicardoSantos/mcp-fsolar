import { test } from "node:test";
import assert from "node:assert/strict";
import os   from "os";
import path from "path";

process.env.SNAPSHOT_DIR = path.join(os.tmpdir(), "fsolar-hooks-test-" + process.pid);

import { HookStore, type HookDelivery } from "../src/hooks";
import { HookEvent, HealthStatus, ChargingState } from "../src/enums";
import { HEALTH_TEMP_WARN } from "../src/compute";
import { constants } from "node:http2";
import type { Battery } from "../src/battery";
import type { BatteryHealth } from "../src/compute";

const { HTTP_STATUS_BAD_REQUEST } = constants;

// ── Private-member access ─────────────────────────────────────────────────────

interface HookStorePrivate {
  _hooks:         Array<Record<string, unknown>>;
  _cooldowns:     Record<string, number>;
  _save:          () => void;
  _saveCooldowns: () => void;
  _deliveryLog:   Map<string, HookDelivery[]>;
  _deliver:       (hook: Record<string, unknown>, event: string, payload: Record<string, unknown>) => Promise<boolean>;
  _httpPost:      (url: string, body: string, headers: Record<string, string | number>) => Promise<{ ok: boolean; status: number }>;
  _dnsLookup:     (hostname: string) => Promise<{ address: string; family: number }>;
}

function priv(hs: HookStore): HookStorePrivate {
  return hs as unknown as HookStorePrivate;
}

// ── Test double — in-memory HookStore with no disk I/O ───────────────────────

function makeStore(): HookStore {
  const hs = new HookStore();
  priv(hs)._save          = () => {};
  priv(hs)._saveCooldowns = () => {};
  priv(hs)._hooks         = [];
  priv(hs)._cooldowns     = {};
  return hs;
}

// Battery / health fixture helpers
function makeBat(overrides: Record<string, unknown> = {}): Battery {
  return {
    sn: "SN1", alias: "Bat1", soc: 50,
    chargingState: ChargingState.DISCHARGING,
    power: -500,
    ...overrides,
  } as unknown as Battery;
}

function makeFullBat(overrides: Record<string, unknown> = {}): Battery {
  return {
    sn: "SN1", alias: "Bat1", soc: 50,
    chargingState: ChargingState.DISCHARGING,
    power: -500, cellDelta: null, tempMax: 25, soh: 95,
    warningCount: 0, batUnderVoltageCount: 0, dataTime: null,
    ...overrides,
  } as unknown as Battery;
}

function makeHealth(sn: string, overrides: Record<string, unknown> = {}): Record<string, BatteryHealth> {
  return {
    [sn]: {
      cellDeltaStatus: HealthStatus.OK, cellDelta: 50,
      tempStatus: HealthStatus.OK, tempMax: 30,
      sohStatus: HealthStatus.OK, soh: 95,
      outliers: [],
      ...overrides,
    } as unknown as BatteryHealth,
  };
}

function localTimeAgo(minutesAgo = 0): string {
  const d   = new Date(Date.now() - minutesAgo * 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function captureDelivers(hs: HookStore): Array<{ event: string; payload: Record<string, unknown> }> {
  const delivered: Array<{ event: string; payload: Record<string, unknown> }> = [];
  priv(hs)._deliver = (_hook, event, payload) => {
    delivered.push({ event, payload });
    return Promise.resolve(true);
  };
  return delivered;
}

// ── HookStore.add — URL validation ────────────────────────────────────────────

test("add — returns subscription without secret field", () => {
  const hs   = makeStore();
  const hook = hs.add({ url: "https://example.com/hook", secret: "s3cr3t" });
  assert.ok(hook.id);
  assert.equal(hook.url, "https://example.com/hook");
  assert.equal((hook as unknown as Record<string, unknown>).secret, undefined, "secret must not be returned");
});

test("add — http URL accepted", () => {
  const hs = makeStore();
  assert.doesNotThrow(() => hs.add({ url: "http://webhook.example.com/hook" }));
});

test("add — throws AppError 400 for invalid URL", () => {
  const hs = makeStore();
  assert.throws(() => hs.add({ url: "not-a-url" }),
    (e: Record<string, unknown>) => e.statusCode === HTTP_STATUS_BAD_REQUEST);
});

test("add — throws AppError 400 for non-http protocol", () => {
  const hs = makeStore();
  assert.throws(() => hs.add({ url: "ftp://example.com/hook" }),
    (e: Record<string, unknown>) => e.statusCode === HTTP_STATUS_BAD_REQUEST);
});

test("add — throws AppError 400 for 127.0.0.1 (SSRF)", () => {
  const hs = makeStore();
  assert.throws(() => hs.add({ url: "http://127.0.0.1/hook" }),
    (e: Record<string, unknown>) => e.statusCode === HTTP_STATUS_BAD_REQUEST);
});

test("add — throws AppError 400 for localhost (SSRF)", () => {
  const hs = makeStore();
  assert.throws(() => hs.add({ url: "http://localhost/hook" }),
    (e: Record<string, unknown>) => e.statusCode === HTTP_STATUS_BAD_REQUEST);
});

test("add — throws AppError 400 for 10.x private range (SSRF)", () => {
  const hs = makeStore();
  assert.throws(() => hs.add({ url: "http://10.0.0.1/hook" }),
    (e: Record<string, unknown>) => e.statusCode === HTTP_STATUS_BAD_REQUEST);
});

test("add — throws AppError 400 for 192.168.x (SSRF)", () => {
  const hs = makeStore();
  assert.throws(() => hs.add({ url: "http://192.168.1.1/hook" }),
    (e: Record<string, unknown>) => e.statusCode === HTTP_STATUS_BAD_REQUEST);
});

test("add — throws AppError 400 for 172.16.x private range (SSRF)", () => {
  const hs = makeStore();
  assert.throws(() => hs.add({ url: "http://172.16.0.1/hook" }),
    (e: Record<string, unknown>) => e.statusCode === HTTP_STATUS_BAD_REQUEST);
});

test("add — throws AppError 400 for ::1 IPv6 loopback (SSRF)", () => {
  const hs = makeStore();
  assert.throws(() => hs.add({ url: "http://[::1]/hook" }),
    (e: Record<string, unknown>) => e.statusCode === HTTP_STATUS_BAD_REQUEST);
});

test("add — throws AppError 400 for decimal IPv4 loopback (SSRF)", () => {
  const hs = makeStore();
  assert.throws(() => hs.add({ url: "http://2130706433/hook" }),
    (e: Record<string, unknown>) => e.statusCode === HTTP_STATUS_BAD_REQUEST);
});

test("add — throws AppError 400 for unknown events", () => {
  const hs = makeStore();
  assert.throws(() => hs.add({ url: "https://example.com/hook", events: ["not_a_real_event"] }),
    (e: Record<string, unknown>) => e.statusCode === HTTP_STATUS_BAD_REQUEST);
});

test("add — accepts a subset of valid events", () => {
  const hs = makeStore();
  assert.doesNotThrow(() => hs.add({
    url:    "https://example.com/hook",
    events: [HookEvent.LOW_SOC, HookEvent.FULL],
  }));
});

// ── DNS rebinding protection ──────────────────────────────────────────────────

test("deliver — blocks when hostname resolves to private IP (DNS rebinding)", async () => {
  const hs = new HookStore();
  priv(hs)._save          = () => {};
  priv(hs)._saveCooldowns = () => {};
  priv(hs)._hooks         = [];
  priv(hs)._cooldowns     = {};

  // Bypass registration SSRF check by injecting the hook directly
  const hook = { id: "x", url: "https://rebind.example.com/hook", events: [], secret: null, createdAt: new Date().toISOString() };
  priv(hs)._hooks = [hook as unknown as Record<string, unknown>];

  // Stub DNS lookup to return a private IP (simulates DNS rebinding)
  priv(hs)._dnsLookup = async () => ({ address: "192.168.1.100", family: 4 });

  // Stub _httpPost to confirm it is never reached
  let httpPostCalled = false;
  priv(hs)._httpPost = async () => { httpPostCalled = true; return { ok: true, status: 200 }; };

  const ok = await priv(hs)._deliver(hook as unknown as Record<string, unknown>, "test_event", {});
  assert.equal(ok, false, "deliver must return false when DNS resolves to private IP");
  assert.equal(httpPostCalled, false, "_httpPost must not be called for DNS-rebound address");
});

test("deliver — blocks when DNS lookup fails", async () => {
  const hs = new HookStore();
  priv(hs)._save          = () => {};
  priv(hs)._saveCooldowns = () => {};
  priv(hs)._hooks         = [];
  priv(hs)._cooldowns     = {};

  const hook = { id: "y", url: "https://unresolvable.example.com/hook", events: [], secret: null, createdAt: new Date().toISOString() };
  priv(hs)._hooks = [hook as unknown as Record<string, unknown>];

  priv(hs)._dnsLookup = async () => { throw new Error("ENOTFOUND"); };

  let httpPostCalled = false;
  priv(hs)._httpPost = async () => { httpPostCalled = true; return { ok: true, status: 200 }; };

  const ok = await priv(hs)._deliver(hook as unknown as Record<string, unknown>, "test_event", {});
  assert.equal(ok, false, "deliver must return false when DNS lookup fails");
  assert.equal(httpPostCalled, false, "_httpPost must not be called when DNS lookup fails");
});

test("deliver — proceeds when hostname resolves to public IP", async () => {
  const hs = new HookStore();
  priv(hs)._save          = () => {};
  priv(hs)._saveCooldowns = () => {};
  priv(hs)._hooks         = [];
  priv(hs)._cooldowns     = {};

  const hook = { id: "z", url: "https://webhook.example.com/hook", events: [], secret: null, createdAt: new Date().toISOString() };
  priv(hs)._hooks = [hook as unknown as Record<string, unknown>];

  // Resolves to a public IP — should proceed to delivery
  priv(hs)._dnsLookup = async () => ({ address: "93.184.216.34", family: 4 });
  priv(hs)._httpPost  = async () => ({ ok: true, status: 200 });

  const ok = await priv(hs)._deliver(hook as unknown as Record<string, unknown>, "test_event", {});
  assert.equal(ok, true, "deliver must proceed for public IPs");
});

// ── HookStore.remove ──────────────────────────────────────────────────────────

test("remove — returns true when hook exists", () => {
  const hs   = makeStore();
  const hook = hs.add({ url: "https://example.com/hook" });
  assert.equal(hs.remove(hook.id), true);
});

test("remove — returns false for unknown id", () => {
  const hs = makeStore();
  assert.equal(hs.remove("nonexistent"), false);
});

test("remove — hook no longer in list after removal", () => {
  const hs   = makeStore();
  const hook = hs.add({ url: "https://example.com/hook" });
  hs.remove(hook.id);
  assert.equal(hs.list().length, 0);
});

test("remove — cleans up delivery log entry", () => {
  const hs   = makeStore();
  const hook = hs.add({ url: "https://example.com/hook" });
  priv(hs)._deliveryLog.set(hook.id, [{ event: "test" } as HookDelivery]);
  hs.remove(hook.id);
  assert.equal(priv(hs)._deliveryLog.has(hook.id), false);
});

// ── HookStore.list ────────────────────────────────────────────────────────────

test("list — never exposes secret", () => {
  const hs = makeStore();
  hs.add({ url: "https://example.com/hook", secret: "hidden" });
  for (const h of hs.list()) assert.equal((h as unknown as Record<string, unknown>).secret, undefined);
});

test("list — returns all registered hooks", () => {
  const hs = makeStore();
  hs.add({ url: "https://a.example.com/hook" });
  hs.add({ url: "https://b.example.com/hook" });
  assert.equal(hs.list().length, 2);
});

// ── HookStore.getDeliveries ───────────────────────────────────────────────────

test("getDeliveries — returns empty array for unknown hookId", () => {
  assert.deepEqual(makeStore().getDeliveries("unknown"), []);
});

test("getDeliveries — returns deliveries newest-first", () => {
  const hs = makeStore();
  priv(hs)._deliveryLog.set("h1", [
    { ts: "2026-01-01T00:00:00Z" } as HookDelivery,
    { ts: "2026-01-01T01:00:00Z" } as HookDelivery,
  ]);
  const entries = hs.getDeliveries("h1");
  assert.equal(entries[0].ts, "2026-01-01T01:00:00Z");
  assert.equal(entries[1].ts, "2026-01-01T00:00:00Z");
});

// ── HookStore.fire — event dispatch ──────────────────────────────────────────

test("fire — no events dispatched when no hooks registered", async () => {
  const hs   = makeStore();
  const sent = captureDelivers(hs);
  await hs.fire([makeBat({ soc: 5 })], {});
  assert.equal(sent.length, 0);
});

test("fire — LOW_SOC event dispatched when soc is at or below threshold", async () => {
  const hs   = makeStore();
  hs.add({ url: "https://example.com/hook" });
  const sent = captureDelivers(hs);
  await hs.fire([makeBat({ soc: 10 })], {});
  assert.ok(sent.some((e) => e.event === HookEvent.LOW_SOC), "LOW_SOC should be dispatched");
});

test("fire — LOW_SOC not dispatched when soc is above threshold", async () => {
  const hs   = makeStore();
  hs.add({ url: "https://example.com/hook" });
  const sent = captureDelivers(hs);
  await hs.fire([makeBat({ soc: 50 })], {});
  assert.ok(!sent.some((e) => e.event === HookEvent.LOW_SOC));
});

test("fire — FULL event dispatched when soc == 100 and standby", async () => {
  const hs   = makeStore();
  hs.add({ url: "https://example.com/hook" });
  const sent = captureDelivers(hs);
  await hs.fire([makeBat({ soc: 100, chargingState: ChargingState.STANDBY, power: 0 })], {});
  assert.ok(sent.some((e) => e.event === HookEvent.FULL));
});

test("fire — CELL_DELTA_CRIT dispatched when health indicates CRIT", async () => {
  const hs   = makeStore();
  hs.add({ url: "https://example.com/hook" });
  const sent = captureDelivers(hs);
  await hs.fire(
    [makeBat()],
    makeHealth("SN1", { cellDeltaStatus: HealthStatus.CRIT }),
  );
  assert.ok(sent.some((e) => e.event === HookEvent.CELL_DELTA_CRIT));
});

test("fire — ONLINE event dispatched when a new battery appears", async () => {
  const hs   = makeStore();
  hs.add({ url: "https://example.com/hook" });
  const sent = captureDelivers(hs);
  await hs.fire([makeBat({ sn: "SN1", soc: 50 })], {});
  await hs.fire([makeBat({ sn: "SN1", soc: 50 }), makeBat({ sn: "SN2", soc: 50, alias: "Bat2" })], {});
  assert.ok(sent.some((e) => e.event === HookEvent.ONLINE && e.payload["sn"] === "SN2"));
});

test("fire — OFFLINE event dispatched when battery disappears", async () => {
  const hs   = makeStore();
  hs.add({ url: "https://example.com/hook" });
  const sent = captureDelivers(hs);
  await hs.fire([makeBat({ sn: "SN1", soc: 50 }), makeBat({ sn: "SN2", soc: 50, alias: "Bat2" })], {});
  await hs.fire([makeBat({ sn: "SN1", soc: 50 })], {});
  assert.ok(sent.some((e) => e.event === HookEvent.OFFLINE && e.payload["sn"] === "SN2"));
});

test("fire — cooldown prevents the same event from firing twice in a row", async () => {
  const hs   = makeStore();
  hs.add({ url: "https://example.com/hook" });
  const sent = captureDelivers(hs);
  await hs.fire([makeBat({ soc: 10 })], {});
  await hs.fire([makeBat({ soc: 10 })], {});
  assert.equal(sent.filter((e) => e.event === HookEvent.LOW_SOC).length, 1);
});

test("fire — hook filtered by events list (other events not sent)", async () => {
  const hs = makeStore();
  hs.add({ url: "https://example.com/hook", events: [HookEvent.FULL] });
  const sent = captureDelivers(hs);
  await hs.fire([makeBat({ soc: 5 })], {});
  assert.equal(sent.length, 0, "hook subscribed to FULL should not receive LOW_SOC");
});

// ── HookStore.fire — alert-derived per-battery events ─────────────────────────

test("fire — OUTLIER dispatched when health has outlier cells", async () => {
  const hs   = makeStore();
  hs.add({ url: "https://example.com/hook" });
  const sent = captureDelivers(hs);
  await hs.fire([makeFullBat()], makeHealth("SN1", { outliers: [4] }));
  assert.ok(sent.some((e) => e.event === HookEvent.OUTLIER));
});

test("fire — OUTLIER not dispatched when outliers empty", async () => {
  const hs   = makeStore();
  hs.add({ url: "https://example.com/hook" });
  const sent = captureDelivers(hs);
  await hs.fire([makeFullBat()], makeHealth("SN1", { outliers: [] }));
  assert.ok(!sent.some((e) => e.event === HookEvent.OUTLIER));
});

test("fire — BMS_WARNINGS dispatched when warningCount > 0", async () => {
  const hs   = makeStore();
  hs.add({ url: "https://example.com/hook" });
  const sent = captureDelivers(hs);
  await hs.fire([makeFullBat({ warningCount: 2 })], makeHealth("SN1"));
  assert.ok(sent.some((e) => e.event === HookEvent.BMS_WARNINGS));
});

test("fire — BMS_WARNINGS not dispatched when warningCount is 0", async () => {
  const hs   = makeStore();
  hs.add({ url: "https://example.com/hook" });
  const sent = captureDelivers(hs);
  await hs.fire([makeFullBat({ warningCount: 0 })], makeHealth("SN1"));
  assert.ok(!sent.some((e) => e.event === HookEvent.BMS_WARNINGS));
});

test("fire — UNDERVOLTAGE_EVENTS dispatched when batUnderVoltageCount > 0", async () => {
  const hs   = makeStore();
  hs.add({ url: "https://example.com/hook" });
  const sent = captureDelivers(hs);
  await hs.fire([makeFullBat({ batUnderVoltageCount: 3 })], makeHealth("SN1"));
  assert.ok(sent.some((e) => e.event === HookEvent.UNDERVOLTAGE_EVENTS));
});

test("fire — STALE_DATA dispatched when dataTime is > 30 min ago", async () => {
  const hs   = makeStore();
  hs.add({ url: "https://example.com/hook" });
  const sent = captureDelivers(hs);
  await hs.fire([makeFullBat({ dataTime: localTimeAgo(35) })], makeHealth("SN1"));
  assert.ok(sent.some((e) => e.event === HookEvent.STALE_DATA));
});

test("fire — STALE_DATA not dispatched when dataTime is recent", async () => {
  const hs   = makeStore();
  hs.add({ url: "https://example.com/hook" });
  const sent = captureDelivers(hs);
  await hs.fire([makeFullBat({ dataTime: localTimeAgo(5) })], makeHealth("SN1"));
  assert.ok(!sent.some((e) => e.event === HookEvent.STALE_DATA));
});

// ── HookStore.fire — ALERT catch-all ─────────────────────────────────────────

test("fire — ALERT dispatched with full alert list when any alert is active", async () => {
  const hs   = makeStore();
  hs.add({ url: "https://example.com/hook" });
  const sent = captureDelivers(hs);
  await hs.fire([makeFullBat({ warningCount: 1 })], makeHealth("SN1"));
  const alertEv = sent.find((e) => e.event === HookEvent.ALERT);
  assert.ok(alertEv, "ALERT event should be dispatched");
  assert.ok(Array.isArray((alertEv!.payload as Record<string, unknown>).alerts), "payload.alerts should be an array");
  assert.ok((alertEv!.payload as Record<string, unknown>).count as number > 0, "payload.count should be > 0");
});

test("fire — ALERT payload contains the triggering alert", async () => {
  const hs   = makeStore();
  hs.add({ url: "https://example.com/hook" });
  const sent = captureDelivers(hs);
  await hs.fire([makeFullBat({ warningCount: 2 })], makeHealth("SN1"));
  const alertEv = sent.find((e) => e.event === HookEvent.ALERT);
  assert.ok((alertEv?.payload.alerts as { code: string }[])?.some((a) => a.code === "bms_warnings"));
});

test("fire — ALERT not dispatched when no alerts are active", async () => {
  const hs   = makeStore();
  hs.add({ url: "https://example.com/hook" });
  const sent = captureDelivers(hs);
  await hs.fire([makeFullBat()], makeHealth("SN1"));
  assert.ok(!sent.some((e) => e.event === HookEvent.ALERT));
});

test("fire — ALERT respects cooldown and fires only once", async () => {
  const hs   = makeStore();
  hs.add({ url: "https://example.com/hook" });
  const sent = captureDelivers(hs);
  await hs.fire([makeFullBat({ warningCount: 1 })], makeHealth("SN1"));
  await hs.fire([makeFullBat({ warningCount: 1 })], makeHealth("SN1"));
  assert.equal(sent.filter((e) => e.event === HookEvent.ALERT).length, 1);
});

test("fire — hook subscribed only to ALERT does not receive per-battery events", async () => {
  const hs = makeStore();
  hs.add({ url: "https://example.com/hook", events: [HookEvent.ALERT] });
  const sent = captureDelivers(hs);
  await hs.fire([makeFullBat({ warningCount: 1 })], makeHealth("SN1"));
  assert.ok(!sent.some((e) => e.event === HookEvent.BMS_WARNINGS), "BMS_WARNINGS should not reach ALERT-only hook");
  assert.ok(sent.some((e) => e.event === HookEvent.ALERT), "ALERT should still be delivered");
});

// ── HMAC signing ──────────────────────────────────────────────────────────────

import crypto from "crypto";

function captureHttpPost(hs: HookStore): Array<{ url: string; body: string; headers: Record<string, string | number> }> {
  const captured: Array<{ url: string; body: string; headers: Record<string, string | number> }> = [];
  priv(hs)._httpPost = (url, body, headers) => {
    captured.push({ url, body, headers });
    return Promise.resolve({ ok: true, status: 200 });
  };
  return captured;
}

test("_deliver — per-hook secret adds X-Hub-Signature-256 header", async () => {
  const hs     = makeStore();
  const secret = "mysecret";
  const hook   = priv(hs)._hooks;
  hook.push({ id: "h1", url: "https://example.com/wh", events: [], secret, createdAt: new Date().toISOString() });
  const posts = captureHttpPost(hs);
  await priv(hs)._deliver(hook[0], "test_event", { value: 1 });
  assert.equal(posts.length, 1);
  const sig = posts[0].headers["X-Hub-Signature-256"] as string;
  assert.ok(sig?.startsWith("sha256="), "header should start with sha256=");
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(posts[0].body).digest("hex");
  assert.equal(sig, expected, "HMAC signature must match");
});

test("_deliver — no secret means no X-Hub-Signature-256 header", async () => {
  const hs   = makeStore();
  const hook = priv(hs)._hooks;
  hook.push({ id: "h2", url: "https://example.com/wh", events: [], secret: null, createdAt: new Date().toISOString() });
  delete process.env.FELICITY_WEBHOOK_SECRET;
  const posts = captureHttpPost(hs);
  await priv(hs)._deliver(hook[0], "test_event", {});
  assert.equal(posts.length, 1);
  assert.ok(!posts[0].headers["X-Hub-Signature-256"], "no secret → no HMAC header");
});

test("_deliver — FELICITY_WEBHOOK_SECRET env var signs delivery when hook has no per-hook secret", async () => {
  const hs     = makeStore();
  const secret = "global-secret";
  process.env.FELICITY_WEBHOOK_SECRET = secret;
  try {
    const hook = priv(hs)._hooks;
    hook.push({ id: "h3", url: "https://example.com/wh", events: [], secret: null, createdAt: new Date().toISOString() });
    const posts = captureHttpPost(hs);
    await priv(hs)._deliver(hook[0], "test_event", {});
    assert.equal(posts.length, 1);
    const sig      = posts[0].headers["X-Hub-Signature-256"] as string;
    const expected = "sha256=" + crypto.createHmac("sha256", secret).update(posts[0].body).digest("hex");
    assert.equal(sig, expected, "global FELICITY_WEBHOOK_SECRET must be used for signing");
  } finally {
    delete process.env.FELICITY_WEBHOOK_SECRET;
  }
});

test("_deliver — per-hook secret takes precedence over FELICITY_WEBHOOK_SECRET", async () => {
  const hs          = makeStore();
  const hookSecret  = "hook-secret";
  const globalSecret = "global-secret";
  process.env.FELICITY_WEBHOOK_SECRET = globalSecret;
  try {
    const hook = priv(hs)._hooks;
    hook.push({ id: "h4", url: "https://example.com/wh", events: [], secret: hookSecret, createdAt: new Date().toISOString() });
    const posts = captureHttpPost(hs);
    await priv(hs)._deliver(hook[0], "test_event", {});
    const sig      = posts[0].headers["X-Hub-Signature-256"] as string;
    const expected = "sha256=" + crypto.createHmac("sha256", hookSecret).update(posts[0].body).digest("hex");
    assert.equal(sig, expected, "per-hook secret must override global env var");
  } finally {
    delete process.env.FELICITY_WEBHOOK_SECRET;
  }
});
