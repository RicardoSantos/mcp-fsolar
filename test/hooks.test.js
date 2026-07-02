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

function makeHealth(sn, overrides = {}) {
  return {
    [sn]: {
      cellDeltaStatus: HealthStatus.OK, cellDelta: 50,
      tempStatus: HealthStatus.OK, tempMax: 30,
      sohStatus: HealthStatus.OK, soh: 95,
      ...overrides,
    },
  };
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
