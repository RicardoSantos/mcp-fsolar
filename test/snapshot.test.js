"use strict";

const { test } = require("node:test");
const assert   = require("node:assert/strict");
const { BatterySnapshotStore } = require("../index.js");

function makeSnap(sn, cellDelta, isBalancing = false) {
  return { sn, alias: sn, cellDelta, isBalancing,
           soc: 80, soh: 100, power: 0, cellMin: null, cellMax: null,
           maxCellNum: null, minCellNum: null, voltages: [], temps: [],
           tempMax: 25, tempMin: 25, warningCount: 0, batCycleIndex: 0 };
}

function makeSnapshots(entries) {
  return entries.map(([minsAgo, batArray]) => ({
    ts: new Date(Date.now() - minsAgo * 60_000).toISOString(),
    batteries: batArray,
  }));
}

test("getTrend — null when no snapshots", () => {
  const store = new BatterySnapshotStore();
  assert.equal(store._computeTrend("SN1", []), null);
});

test("getTrend — null with only one snapshot", () => {
  const store = new BatterySnapshotStore();
  const snaps = makeSnapshots([[0, [makeSnap("SN1", 20)]]]);
  assert.equal(store._computeTrend("SN1", snaps), null);
});

test("getTrend — null when sn not in snapshots", () => {
  const store = new BatterySnapshotStore();
  const snaps = makeSnapshots([[10, [makeSnap("SN2", 20)]], [0, [makeSnap("SN2", 15)]]]);
  assert.equal(store._computeTrend("SN1", snaps), null);
});

test("getTrend — direction: improving (delta dropped > 3)", () => {
  const store = new BatterySnapshotStore();
  const snaps = makeSnapshots([[20, [makeSnap("SN1", 30)]], [10, [makeSnap("SN1", 20)]], [0, [makeSnap("SN1", 10)]]]);
  const t = store._computeTrend("SN1", snaps);
  assert.equal(t.direction, "improving");
  assert.equal(t.deltaChange, -20);
  assert.equal(t.snapshotCount, 3);
});

test("getTrend — direction: degrading (delta rose > 3)", () => {
  const store = new BatterySnapshotStore();
  const snaps = makeSnapshots([[10, [makeSnap("SN1", 5)]], [0, [makeSnap("SN1", 15)]]]);
  const t = store._computeTrend("SN1", snaps);
  assert.equal(t.direction, "degrading");
  assert.equal(t.deltaChange, 10);
});

test("getTrend — direction: stable (change <= 3)", () => {
  const store = new BatterySnapshotStore();
  const snaps = makeSnapshots([[10, [makeSnap("SN1", 10)]], [0, [makeSnap("SN1", 12)]]]);
  const t = store._computeTrend("SN1", snaps);
  assert.equal(t.direction, "stable");
});

test("getTrend — balancingCount and streak", () => {
  const store = new BatterySnapshotStore();
  const snaps = makeSnapshots([
    [30, [makeSnap("SN1", 30, false)]],
    [20, [makeSnap("SN1", 25, true)]],
    [10, [makeSnap("SN1", 20, true)]],
    [0,  [makeSnap("SN1", 15, true)]],
  ]);
  const t = store._computeTrend("SN1", snaps);
  assert.equal(t.balancingCount, 3);
  assert.equal(t.currentBalancingStreak, 3);
});

test("getTrend — streak breaks when last entry is not balancing", () => {
  const store = new BatterySnapshotStore();
  const snaps = makeSnapshots([
    [20, [makeSnap("SN1", 30, true)]],
    [10, [makeSnap("SN1", 25, true)]],
    [0,  [makeSnap("SN1", 20, false)]],
  ]);
  const t = store._computeTrend("SN1", snaps);
  assert.equal(t.currentBalancingStreak, 0);
  assert.equal(t.balancingCount, 2);
});

test("getAllTrends — loads snapshots once, returns entry per battery", () => {
  const store = new BatterySnapshotStore();
  let loadCount = 0;
  const fixedSnaps = makeSnapshots([
    [20, [makeSnap("SN1", 30), makeSnap("SN2", 15)]],
    [0,  [makeSnap("SN1", 10), makeSnap("SN2",  5)]],
  ]);
  store._load = () => { loadCount++; return fixedSnaps; };

  const trends = store.getAllTrends([{ sn: "SN1" }, { sn: "SN2" }]);

  assert.equal(loadCount, 1, "should load snapshots exactly once");
  assert.ok(trends["SN1"]);
  assert.ok(trends["SN2"]);
  assert.equal(trends["SN1"].direction, "improving");
  assert.equal(trends["SN2"].direction, "improving");
});

test("getAllTrends — skips battery with insufficient history", () => {
  const store = new BatterySnapshotStore();
  const fixedSnaps = makeSnapshots([[0, [makeSnap("SN1", 20)]]]);
  store._load = () => fixedSnaps;

  const trends = store.getAllTrends([{ sn: "SN1" }]);
  assert.equal(Object.keys(trends).length, 0);
});
