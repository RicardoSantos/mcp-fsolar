import { test } from "node:test";
import assert from "node:assert/strict";
import { BatterySnapshotStore, DailySnapshotStore, type BatterySnapshot } from "../index";
import type { SnapshotEntry } from "../src/helpers";

interface StorePrivate {
  _load(): BatterySnapshot[];
}

function priv(s: BatterySnapshotStore | DailySnapshotStore): StorePrivate {
  return s as unknown as StorePrivate;
}

function makeSnap(sn: string): SnapshotEntry {
  return {
    sn, alias: sn, cellDelta: 10, isBalancing: false,
    soc: 80, soh: 100, power: 0, cellMin: null, cellMax: null,
    maxCellNum: null, minCellNum: null, voltages: [], temps: [],
    tempMax: 25, tempMin: 25, warningCount: 0, batCycleIndex: 0,
  };
}

// Five snapshots, oldest first, 10 minutes apart, ending "now".
function fixedSnapshots(): BatterySnapshot[] {
  return [40, 30, 20, 10, 0].map((minsAgo) => ({
    ts: new Date(Date.now() - minsAgo * 60_000).toISOString(),
    batteries: [makeSnap("SN1")],
  }));
}

test("getSnapshots() — no query returns everything, unchanged behaviour", () => {
  const store = new BatterySnapshotStore();
  const fixed = fixedSnapshots();
  priv(store)._load = () => fixed;

  assert.deepEqual(store.getSnapshots(), fixed);
});

test("getSnapshots({}) — empty query object also returns everything", () => {
  const store = new BatterySnapshotStore();
  const fixed = fixedSnapshots();
  priv(store)._load = () => fixed;

  assert.deepEqual(store.getSnapshots({}), fixed);
});

test("getSnapshots({ limit }) — caps to the most recent N, preserving order", () => {
  const store = new BatterySnapshotStore();
  const fixed = fixedSnapshots();
  priv(store)._load = () => fixed;

  const result = store.getSnapshots({ limit: 2 });
  assert.equal(result.length, 2);
  assert.deepEqual(result, fixed.slice(-2));
});

test("getSnapshots({ limit }) — limit >= total length is a no-op", () => {
  const store = new BatterySnapshotStore();
  const fixed = fixedSnapshots();
  priv(store)._load = () => fixed;

  assert.deepEqual(store.getSnapshots({ limit: 999 }), fixed);
});

test("getSnapshots({ limit }) — non-positive limit is ignored", () => {
  const store = new BatterySnapshotStore();
  const fixed = fixedSnapshots();
  priv(store)._load = () => fixed;

  assert.deepEqual(store.getSnapshots({ limit: 0 }), fixed);
  assert.deepEqual(store.getSnapshots({ limit: -5 }), fixed);
});

test("getSnapshots({ since }) — ISO string filters out older entries", () => {
  const store = new BatterySnapshotStore();
  const fixed = fixedSnapshots();
  priv(store)._load = () => fixed;

  const since = new Date(Date.now() - 25 * 60_000).toISOString();
  const result = store.getSnapshots({ since });
  assert.deepEqual(result, fixed.slice(-3)); // the 20/10/0-min-ago entries
});

test("getSnapshots({ since }) — epoch ms works the same as ISO string", () => {
  const store = new BatterySnapshotStore();
  const fixed = fixedSnapshots();
  priv(store)._load = () => fixed;

  const sinceMs = Date.now() - 25 * 60_000;
  assert.deepEqual(store.getSnapshots({ since: sinceMs }), fixed.slice(-3));
});

test("getSnapshots({ since }) — unparseable value is ignored, not thrown", () => {
  const store = new BatterySnapshotStore();
  const fixed = fixedSnapshots();
  priv(store)._load = () => fixed;

  assert.deepEqual(store.getSnapshots({ since: "not-a-date" }), fixed);
});

test("getSnapshots({ since, limit }) — since narrows first, then limit caps the remainder", () => {
  const store = new BatterySnapshotStore();
  const fixed = fixedSnapshots();
  priv(store)._load = () => fixed;

  const since = new Date(Date.now() - 35 * 60_000).toISOString(); // keeps last 4
  const result = store.getSnapshots({ since, limit: 2 });
  assert.deepEqual(result, fixed.slice(-2));
});

test("getSnapshots({ since }) — future timestamp yields empty array, no throw", () => {
  const store = new BatterySnapshotStore();
  const fixed = fixedSnapshots();
  priv(store)._load = () => fixed;

  const future = new Date(Date.now() + 3_600_000).toISOString();
  assert.deepEqual(store.getSnapshots({ since: future }), []);
});

test("DailySnapshotStore inherits the same query behaviour", () => {
  const store = new DailySnapshotStore();
  const fixed = fixedSnapshots();
  priv(store)._load = () => fixed;

  assert.deepEqual(store.getSnapshots({ limit: 1 }), fixed.slice(-1));
});
