"use strict";

const { test } = require("node:test");
const assert   = require("node:assert/strict");
const os       = require("os");
const path     = require("path");

// Point SNAPSHOT_DIR at a throwaway temp location so HookStore disk I/O
// goes nowhere useful and can't interfere with a running server instance.
process.env.SNAPSHOT_DIR = path.join(os.tmpdir(), "fsolar-hooks-test-" + process.pid);

const { HookStore }               = require("../src/hooks");
const { HookEvent, HealthStatus, ChargingState } = require("../src/enums");
const { HEALTH_TEMP_WARN }        = require("../src/compute");
const { constants: { HTTP_STATUS_BAD_REQUEST } }  = require("node:http2");

// ── Test double — in-memory HookStore with no disk I/O ───────────────────────

function makeStore() {
  const hs          = new HookStore();
  hs._save          = () => {};
  hs._saveCooldowns = () => {};
  hs._hooks         = [];      // start empty regardless of leftover files
  hs._cooldowns     = {};
  return hs;
}

// Battery / health fixture helpers
function makeBat(overrides = {}) {
  return { sn: "SN1", alias: "Bat1", soc: 50, chargingState: ChargingState.DISCHARGING,
           power: -500, ...overrides };
}

// Full Battery fixture — includes all fields that computeAlerts inspects
function makeFullBat(overrides = {}) {
  return {
    sn: "SN1", alias: "Bat1", soc: 50, chargingState: ChargingState.DISCHARGING,
    power: -500, cellDelta: null, tempMax: 25, soh: 95,
    warningCount: 0, batUnderVoltageCount: 0, dataTime: null,
    ...overrides,
  };
}

function makeHealth(sn, overrides = {}) {
  return {
    [sn]: {
      cellDeltaStatus: HealthStatus.OK, cellDelta: 50,
      tempStatus: HealthStatus.OK, tempMax: 30,
      sohStatus: HealthStatus.OK, soh: 95,
      outliers: [],
      ...overrides,
    },
  };
}

// Produces "YYYY-MM-DD HH:MM:SS" in local time — matches bat.dataTime format
function localTimeAgo(minutesAgo = 0) {
  const d   = new Date(Date.now() - minutesAgo * 60_000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ── HookStore.add — URL validation ────────────────────────────────────────────

test("add — returns subscription without secret field", () => {
  const hs   = makeStore();
  const hook = hs.add({ url: "https://example.com/hook", secret: "s3cr3t" });
  assert.ok(hook.id);
  assert.equal(hook.url, "https://example.com/hook");
  assert.equal(hook.secret, undefined, "secret must not be returned");
});

test("add — http URL accepted", () => {
  const hs = makeStore();
  assert.doesNotThrow(() => hs.add({ url: "http://webhook.example.com/hook" }));
});

test("add — throws AppError 400 for invalid URL", () => {
  const hs = makeStore();
  assert.throws(() => hs.add({ url: "not-a-url" }),
    (e) => e.statusCode === HTTP_STATUS_BAD_REQUEST);
});

test("add — throws AppError 400 for non-http protocol", () => {
  const hs = makeStore();
  assert.throws(() => hs.add({ url: "ftp://example.com/hook" }),
    (e) => e.statusCode === HTTP_STATUS_BAD_REQUEST);
});

test("add — throws AppError 400 for 127.0.0.1 (SSRF)", () => {
  const hs = makeStore();
  assert.throws(() => hs.add({ url: "http://127.0.0.1/hook" }),
    (e) => e.statusCode === HTTP_STATUS_BAD_REQUEST);
});

test("add — throws AppError 400 for localhost (SSRF)", () => {
  const hs = makeStore();
  assert.throws(() => hs.add({ url: "http://localhost/hook" }),
    (e) => e.statusCode === HTTP_STATUS_BAD_REQUEST);
});

test("add — throws AppError 400 for 10.x private range (SSRF)", () => {
  const hs = makeStore();
  assert.throws(() => hs.add({ url: "http://10.0.0.1/hook" }),
    (e) => e.statusCode === HTTP_STATUS_BAD_REQUEST);
});

test("add — throws AppError 400 for 192.168.x (SSRF)", () => {
  const hs = makeStore();
  assert.throws(() => hs.add({ url: "http://192.168.1.1/hook" }),
    (e) => e.statusCode === HTTP_STATUS_BAD_REQUEST);
});

test("add — throws AppError 400 for 172.16.x private range (SSRF)", () => {
  const hs = makeStore();
  assert.throws(() => hs.add({ url: "http://172.16.0.1/hook" }),
    (e) => e.statusCode === HTTP_STATUS_BAD_REQUEST);
});

test("add — throws AppError 400 for ::1 IPv6 loopback (SSRF)", () => {
  const hs = makeStore();
  assert.throws(() => hs.add({ url: "http://[::1]/hook" }),
    (e) => e.statusCode === HTTP_STATUS_BAD_REQUEST);
});

test("add — throws AppError 400 for decimal IPv4 loopback (SSRF)", () => {
  // 2130706433 = 127.0.0.1
  const hs = makeStore();
  assert.throws(() => hs.add({ url: "http://2130706433/hook" }),
    (e) => e.statusCode === HTTP_STATUS_BAD_REQUEST);
});

test("add — throws AppError 400 for unknown events", () => {
  const hs = makeStore();
  assert.throws(() => hs.add({ url: "https://example.com/hook", events: ["not_a_real_event"] }),
    (e) => e.statusCode === HTTP_STATUS_BAD_REQUEST);
});

test("add — accepts a subset of valid events", () => {
  const hs = makeStore();
  assert.doesNotThrow(() => hs.add({
    url:    "https://example.com/hook",
    events: [HookEvent.LOW_SOC, HookEvent.FULL],
  }));
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
  hs._deliveryLog.set(hook.id, [{ event: "test" }]);
  hs.remove(hook.id);
  assert.equal(hs._deliveryLog.has(hook.id), false);
});

// ── HookStore.list ────────────────────────────────────────────────────────────

test("list — never exposes secret", () => {
  const hs = makeStore();
  hs.add({ url: "https://example.com/hook", secret: "hidden" });
  for (const h of hs.list()) assert.equal(h.secret, undefined);
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
  hs._deliveryLog.set("h1", [
    { ts: "2026-01-01T00:00:00Z" },
    { ts: "2026-01-01T01:00:00Z" },
  ]);
  const entries = hs.getDeliveries("h1");
  assert.equal(entries[0].ts, "2026-01-01T01:00:00Z");
  assert.equal(entries[1].ts, "2026-01-01T00:00:00Z");
});

// ── HookStore.fire — event dispatch ──────────────────────────────────────────

function captureDelivers(hs) {
  const delivered = [];
  hs._deliver = (hook, event, payload) => {
    delivered.push({ event, payload });
    return Promise.resolve();
  };
  return delivered;
}

test("fire — no events dispatched when no hooks registered", async () => {
  const hs      = makeStore();
  const sent    = captureDelivers(hs);
  await hs.fire([makeBat({ soc: 5 })], {}); // LOW_SOC would normally fire
  assert.equal(sent.length, 0);
});

test("fire — LOW_SOC event dispatched when soc is at or below threshold", async () => {
  const hs = makeStore();
  hs.add({ url: "https://example.com/hook" });
  const sent = captureDelivers(hs);
  await hs.fire([makeBat({ soc: 10 })], {});
  assert.ok(sent.some((e) => e.event === HookEvent.LOW_SOC), "LOW_SOC should be dispatched");
});

test("fire — LOW_SOC not dispatched when soc is above threshold", async () => {
  const hs = makeStore();
  hs.add({ url: "https://example.com/hook" });
  const sent = captureDelivers(hs);
  await hs.fire([makeBat({ soc: 50 })], {});
  assert.ok(!sent.some((e) => e.event === HookEvent.LOW_SOC));
});

test("fire — FULL event dispatched when soc == 100 and standby", async () => {
  const hs = makeStore();
  hs.add({ url: "https://example.com/hook" });
  const sent = captureDelivers(hs);
  await hs.fire([makeBat({ soc: 100, chargingState: ChargingState.STANDBY, power: 0 })], {});
  assert.ok(sent.some((e) => e.event === HookEvent.FULL));
});

test("fire — CELL_DELTA_CRIT dispatched when health indicates CRIT", async () => {
  const hs = makeStore();
  hs.add({ url: "https://example.com/hook" });
  const sent = captureDelivers(hs);
  await hs.fire(
    [makeBat()],
    makeHealth("SN1", { cellDeltaStatus: HealthStatus.CRIT }),
  );
  assert.ok(sent.some((e) => e.event === HookEvent.CELL_DELTA_CRIT));
});

test("fire — ONLINE event dispatched when a new battery appears", async () => {
  const hs = makeStore();
  hs.add({ url: "https://example.com/hook" });
  const sent = captureDelivers(hs);
  await hs.fire([makeBat({ sn: "SN1", soc: 50 })], {}); // first poll — no ONLINE yet
  await hs.fire([makeBat({ sn: "SN1", soc: 50 }), makeBat({ sn: "SN2", soc: 50, alias: "Bat2" })], {});
  assert.ok(sent.some((e) => e.event === HookEvent.ONLINE && e.payload.sn === "SN2"));
});

test("fire — OFFLINE event dispatched when battery disappears", async () => {
  const hs = makeStore();
  hs.add({ url: "https://example.com/hook" });
  const sent = captureDelivers(hs);
  await hs.fire([makeBat({ sn: "SN1", soc: 50 }), makeBat({ sn: "SN2", soc: 50, alias: "Bat2" })], {});
  await hs.fire([makeBat({ sn: "SN1", soc: 50 })], {}); // SN2 gone
  assert.ok(sent.some((e) => e.event === HookEvent.OFFLINE && e.payload.sn === "SN2"));
});

test("fire — cooldown prevents the same event from firing twice in a row", async () => {
  const hs = makeStore();
  hs.add({ url: "https://example.com/hook" });
  const sent = captureDelivers(hs);
  await hs.fire([makeBat({ soc: 10 })], {}); // fires LOW_SOC
  await hs.fire([makeBat({ soc: 10 })], {}); // cooldown blocks it
  assert.equal(sent.filter((e) => e.event === HookEvent.LOW_SOC).length, 1);
});

test("fire — hook filtered by events list (other events not sent)", async () => {
  const hs = makeStore();
  // Subscribe only to FULL — LOW_SOC should be ignored
  hs.add({ url: "https://example.com/hook", events: [HookEvent.FULL] });
  const sent = captureDelivers(hs);
  await hs.fire([makeBat({ soc: 5 })], {}); // only LOW_SOC triggered
  assert.equal(sent.length, 0, "hook subscribed to FULL should not receive LOW_SOC");
});

// ── HookStore.fire — alert-derived per-battery events ─────────────────────────

test("fire — OUTLIER dispatched when health has outlier cells", async () => {
  const hs = makeStore();
  hs.add({ url: "https://example.com/hook" });
  const sent = captureDelivers(hs);
  await hs.fire([makeFullBat()], makeHealth("SN1", { outliers: [4] }));
  assert.ok(sent.some((e) => e.event === HookEvent.OUTLIER));
});

test("fire — OUTLIER not dispatched when outliers empty", async () => {
  const hs = makeStore();
  hs.add({ url: "https://example.com/hook" });
  const sent = captureDelivers(hs);
  await hs.fire([makeFullBat()], makeHealth("SN1", { outliers: [] }));
  assert.ok(!sent.some((e) => e.event === HookEvent.OUTLIER));
});

test("fire — BMS_WARNINGS dispatched when warningCount > 0", async () => {
  const hs = makeStore();
  hs.add({ url: "https://example.com/hook" });
  const sent = captureDelivers(hs);
  await hs.fire([makeFullBat({ warningCount: 2 })], makeHealth("SN1"));
  assert.ok(sent.some((e) => e.event === HookEvent.BMS_WARNINGS));
});

test("fire — BMS_WARNINGS not dispatched when warningCount is 0", async () => {
  const hs = makeStore();
  hs.add({ url: "https://example.com/hook" });
  const sent = captureDelivers(hs);
  await hs.fire([makeFullBat({ warningCount: 0 })], makeHealth("SN1"));
  assert.ok(!sent.some((e) => e.event === HookEvent.BMS_WARNINGS));
});

test("fire — UNDERVOLTAGE_EVENTS dispatched when batUnderVoltageCount > 0", async () => {
  const hs = makeStore();
  hs.add({ url: "https://example.com/hook" });
  const sent = captureDelivers(hs);
  await hs.fire([makeFullBat({ batUnderVoltageCount: 3 })], makeHealth("SN1"));
  assert.ok(sent.some((e) => e.event === HookEvent.UNDERVOLTAGE_EVENTS));
});

test("fire — STALE_DATA dispatched when dataTime is > 30 min ago", async () => {
  const hs = makeStore();
  hs.add({ url: "https://example.com/hook" });
  const sent = captureDelivers(hs);
  await hs.fire([makeFullBat({ dataTime: localTimeAgo(35) })], makeHealth("SN1"));
  assert.ok(sent.some((e) => e.event === HookEvent.STALE_DATA));
});

test("fire — STALE_DATA not dispatched when dataTime is recent", async () => {
  const hs = makeStore();
  hs.add({ url: "https://example.com/hook" });
  const sent = captureDelivers(hs);
  await hs.fire([makeFullBat({ dataTime: localTimeAgo(5) })], makeHealth("SN1"));
  assert.ok(!sent.some((e) => e.event === HookEvent.STALE_DATA));
});

// ── HookStore.fire — ALERT catch-all ─────────────────────────────────────────

test("fire — ALERT dispatched with full alert list when any alert is active", async () => {
  const hs = makeStore();
  hs.add({ url: "https://example.com/hook" });
  const sent = captureDelivers(hs);
  await hs.fire([makeFullBat({ warningCount: 1 })], makeHealth("SN1"));
  const alertEv = sent.find((e) => e.event === HookEvent.ALERT);
  assert.ok(alertEv, "ALERT event should be dispatched");
  assert.ok(Array.isArray(alertEv.payload.alerts), "payload.alerts should be an array");
  assert.ok(alertEv.payload.count > 0, "payload.count should be > 0");
});

test("fire — ALERT payload contains the triggering alert", async () => {
  const hs = makeStore();
  hs.add({ url: "https://example.com/hook" });
  const sent = captureDelivers(hs);
  await hs.fire([makeFullBat({ warningCount: 2 })], makeHealth("SN1"));
  const alertEv = sent.find((e) => e.event === HookEvent.ALERT);
  assert.ok(alertEv?.payload.alerts.some((a) => a.code === "bms_warnings"));
});

test("fire — ALERT not dispatched when no alerts are active", async () => {
  const hs = makeStore();
  hs.add({ url: "https://example.com/hook" });
  const sent = captureDelivers(hs);
  await hs.fire([makeFullBat()], makeHealth("SN1")); // all fields in healthy range
  assert.ok(!sent.some((e) => e.event === HookEvent.ALERT));
});

test("fire — ALERT respects cooldown and fires only once", async () => {
  const hs = makeStore();
  hs.add({ url: "https://example.com/hook" });
  const sent = captureDelivers(hs);
  await hs.fire([makeFullBat({ warningCount: 1 })], makeHealth("SN1"));
  await hs.fire([makeFullBat({ warningCount: 1 })], makeHealth("SN1")); // cooldown blocks
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
