import { test } from "node:test";
import assert   from "node:assert/strict";
import { DailySnapshotStore, type BatterySnapshot } from "../index";
import type { Battery }       from "../src/battery";
import type { SnapshotEntry } from "../src/helpers";

// ── Private interface for testing ─────────────────────────────────────────────

interface DailyStorePrivate {
  _load(): BatterySnapshot[];
  _save(snapshots: BatterySnapshot[]): void;
  _maxSnapshots: number;
}

function priv(s: DailySnapshotStore): DailyStorePrivate {
  return s as unknown as DailyStorePrivate;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const YESTERDAY = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const TODAY     = new Date().toISOString().slice(0, 10);

function makeBattery(sn = "SN1", voltages: number[] = [3300, 3300, 3300]): Battery {
  return {
    sn, alias: sn, model: "BP", status: "NM",
    soc: 80, soh: 100, voltage: 52, current: 0, power: 0,
    chargingState: "idle" as Battery["chargingState"],
    tempMax: 25, tempMin: 25,
    cellTemps: [], cellVoltages: voltages,
    cellVoltageMin: Math.min(...voltages), cellVoltageMax: Math.max(...voltages),
    maxCellNum: null, minCellNum: null,
    cellDelta: 10, isBalancing: false,
    warningCount: 0, batCycleIndex: 0,
    bmsState: 0, modules: [],
  } as unknown as Battery;
}

function makeEntry(voltages: number[], sn = "SN1"): SnapshotEntry {
  return {
    sn, alias: sn, soc: 80, soh: 100, power: 0, cellDelta: 10,
    cellMin: Math.min(...voltages), cellMax: Math.max(...voltages),
    maxCellNum: null, minCellNum: null, isBalancing: false,
    voltages, temps: [], tempMax: 25, tempMin: 25,
    warningCount: 0, batCycleIndex: 0,
  };
}

function makeIntraSnap(date: string, minutesOffset: number, voltages: number[]): BatterySnapshot {
  return {
    ts: `${date}T${String(Math.floor(minutesOffset / 60)).padStart(2, "0")}:${String(minutesOffset % 60).padStart(2, "0")}:00.000Z`,
    batteries: [makeEntry(voltages)],
  };
}

function mockStore(existingSnapshots: BatterySnapshot[] = []): {
  store: DailySnapshotStore;
  saved: BatterySnapshot[][];
} {
  const store = new DailySnapshotStore();
  const saved: BatterySnapshot[][] = [];
  priv(store)._load = () => [...existingSnapshots];
  priv(store)._save = (snaps: BatterySnapshot[]) => { saved.push([...snaps]); };
  return { store, saved };
}

// ── DailySnapshotStore.maybeAdd ───────────────────────────────────────────────

test("daily store — skips when yesterday entry already exists", () => {
  const existingYesterday: BatterySnapshot = {
    ts: `${YESTERDAY}T12:00:00.000Z`,
    batteries: [makeEntry([3300])],
  };
  const { store, saved } = mockStore([existingYesterday]);
  store.maybeAdd([makeBattery()]);
  assert.equal(saved.length, 0, "should not save when yesterday already stored");
});

test("daily store — two intra-snaps → stores min+max entries for yesterday", () => {
  const lowVoltSnap  = makeIntraSnap(YESTERDAY, 60,  [3100, 3100, 3100]);  // packTotal = 9300
  const highVoltSnap = makeIntraSnap(YESTERDAY, 720, [3400, 3400, 3400]);  // packTotal = 10200

  const { store, saved } = mockStore([]);
  store.maybeAdd([makeBattery()], [lowVoltSnap, highVoltSnap]);

  assert.equal(saved.length, 1, "should call _save once");
  const stored = saved[0];
  assert.equal(stored.length, 2, "should store exactly 2 entries");
});

test("daily store — min entry has lower pack voltage than max entry", () => {
  const lowVoltSnap  = makeIntraSnap(YESTERDAY, 60,  [3100, 3100, 3100]);
  const highVoltSnap = makeIntraSnap(YESTERDAY, 720, [3400, 3400, 3400]);

  const { store, saved } = mockStore([]);
  store.maybeAdd([makeBattery()], [lowVoltSnap, highVoltSnap]);

  const [minEntry, maxEntry] = saved[0];
  const packV = (s: BatterySnapshot) => s.batteries.reduce((t, b) => t + b.voltages.reduce((a, v) => a + v, 0), 0);
  assert.ok(packV(minEntry) < packV(maxEntry), "min entry should have lower total voltage than max entry");
});

test("daily store — min ts is T11:59:59, max ts is T12:00:01", () => {
  const snap1 = makeIntraSnap(YESTERDAY, 100, [3100, 3100]);
  const snap2 = makeIntraSnap(YESTERDAY, 200, [3400, 3400]);

  const { store, saved } = mockStore([]);
  store.maybeAdd([makeBattery()], [snap1, snap2]);

  const [minEntry, maxEntry] = saved[0];
  assert.equal(minEntry.ts, `${YESTERDAY}T11:59:59.000Z`);
  assert.equal(maxEntry.ts, `${YESTERDAY}T12:00:01.000Z`);
});

test("daily store — ignores today's intra-snaps, only uses yesterday's", () => {
  const todaySnap     = makeIntraSnap(TODAY,      60, [3000, 3000]);
  const yesterdaySnap = makeIntraSnap(YESTERDAY, 120, [3200, 3200]);

  const { store, saved } = mockStore([]);
  // Only 1 yesterday snap → fallback (not enough for min/max)
  store.maybeAdd([makeBattery()], [todaySnap, yesterdaySnap]);

  assert.equal(saved.length, 1);
  // Fallback stores a single entry, NOT today's snap
  assert.equal(saved[0].length, 1);
  assert.ok(saved[0][0].ts.startsWith(YESTERDAY), "fallback ts should be on yesterday's date");
});

test("daily store — fallback stores single entry when no intra-snaps provided", () => {
  const { store, saved } = mockStore([]);
  store.maybeAdd([makeBattery()]);

  assert.equal(saved.length, 1);
  assert.equal(saved[0].length, 1);
  assert.ok(saved[0][0].ts.startsWith(YESTERDAY));
  assert.equal(saved[0][0].ts, `${YESTERDAY}T12:00:00.000Z`);
});

test("daily store — fallback when fewer than 2 yesterday snaps", () => {
  const onlyOneSnap = makeIntraSnap(YESTERDAY, 60, [3300, 3300]);
  const { store, saved } = mockStore([]);
  store.maybeAdd([makeBattery()], [onlyOneSnap]);

  assert.equal(saved[0].length, 1, "should fallback to single entry with <2 intra-snaps");
});

test("daily store — preserves existing entries, appends new ones", () => {
  const olderDate  = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
  const existing: BatterySnapshot[] = [
    { ts: `${olderDate}T11:59:59.000Z`, batteries: [makeEntry([3200])] },
    { ts: `${olderDate}T12:00:01.000Z`, batteries: [makeEntry([3400])] },
  ];
  const snap1 = makeIntraSnap(YESTERDAY, 60,  [3100, 3100]);
  const snap2 = makeIntraSnap(YESTERDAY, 720, [3400, 3400]);

  const { store, saved } = mockStore(existing);
  store.maybeAdd([makeBattery()], [snap1, snap2]);

  assert.equal(saved[0].length, 4, "should have 2 existing + 2 new entries");
  assert.ok(saved[0][0].ts.startsWith(olderDate), "first entries should be the older day");
  assert.ok(saved[0][2].ts.startsWith(YESTERDAY), "last entries should be yesterday");
});

test("daily store — trims oldest entries to stay within maxSnapshots", () => {
  const olderDate = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
  const existing: BatterySnapshot[] = [
    { ts: `${olderDate}T11:59:59.000Z`, batteries: [makeEntry([3200])] },
    { ts: `${olderDate}T12:00:01.000Z`, batteries: [makeEntry([3400])] },
  ];
  const snap1 = makeIntraSnap(YESTERDAY, 60,  [3100, 3100]);
  const snap2 = makeIntraSnap(YESTERDAY, 720, [3400, 3400]);

  const { store, saved } = mockStore(existing);
  priv(store)._maxSnapshots = 2;  // force trim: keep only 2 entries
  store.maybeAdd([makeBattery()], [snap1, snap2]);

  assert.equal(saved[0].length, 2, "should trim to maxSnapshots");
  assert.ok(saved[0][0].ts.startsWith(YESTERDAY), "kept entries should be the newest (yesterday)");
});

test("daily store — correctly picks extreme when 3+ snaps for yesterday", () => {
  const lowSnap  = makeIntraSnap(YESTERDAY, 60,  [3000, 3000, 3000]);  // packTotal = 9000
  const midSnap  = makeIntraSnap(YESTERDAY, 360, [3200, 3200, 3200]);  // packTotal = 9600
  const highSnap = makeIntraSnap(YESTERDAY, 720, [3500, 3500, 3500]);  // packTotal = 10500

  const { store, saved } = mockStore([]);
  store.maybeAdd([makeBattery()], [lowSnap, midSnap, highSnap]);

  const [minEntry, maxEntry] = saved[0];
  const packV = (s: BatterySnapshot) => s.batteries.reduce((t, b) => t + b.voltages.reduce((a, v) => a + v, 0), 0);
  assert.equal(packV(minEntry), 9000, "min entry should be the lowest-voltage snapshot");
  assert.equal(packV(maxEntry), 10500, "max entry should be the highest-voltage snapshot");
});

test("daily store — capacity is ddays * 2", () => {
  const store = new DailySnapshotStore();
  // Default DAILY_DAYS_DEFAULT = 90, so maxSnapshots = 180
  assert.ok(priv(store)._maxSnapshots % 2 === 0, "maxSnapshots should be even (ddays * 2)");
  assert.ok(priv(store)._maxSnapshots >= 14, "maxSnapshots should cover at least 7 days (14 entries)");
});
