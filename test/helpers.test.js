"use strict";

const { test } = require("node:test");
const assert   = require("node:assert/strict");
const { nullableInt, nullableFloat, clamp, sleep, pickSnapshotFields } = require("../src/helpers");

// ── nullableInt ───────────────────────────────────────────────────────────────

test("nullableInt — null for null",      () => assert.equal(nullableInt(null),      null));
test("nullableInt — null for undefined", () => assert.equal(nullableInt(undefined),  null));
test("nullableInt — parses string",      () => assert.equal(nullableInt("42"),       42));
test("nullableInt — truncates float string", () => assert.equal(nullableInt("3.9"), 3));
test("nullableInt — accepts a number",   () => assert.equal(nullableInt(7),          7));
test("nullableInt — zero string",        () => assert.equal(nullableInt("0"),        0));

// ── nullableFloat ─────────────────────────────────────────────────────────────

test("nullableFloat — null for null",      () => assert.equal(nullableFloat(null),      null));
test("nullableFloat — null for undefined", () => assert.equal(nullableFloat(undefined),  null));
test("nullableFloat — parses string",      () => assert.equal(nullableFloat("3.14"),     3.14));
test("nullableFloat — parses integer string as float", () => assert.equal(nullableFloat("5"), 5));

// ── clamp ─────────────────────────────────────────────────────────────────────

test("clamp — value within range returned as-is", () => assert.equal(clamp(0, 5, 10),   5));
test("clamp — value below min returns min",        () => assert.equal(clamp(0, -5, 10),  0));
test("clamp — value above max returns max",        () => assert.equal(clamp(0, 100, 10), 10));
test("clamp — value at min boundary",              () => assert.equal(clamp(3, 3, 10),   3));
test("clamp — value at max boundary",              () => assert.equal(clamp(0, 10, 10),  10));

// ── sleep ─────────────────────────────────────────────────────────────────────

test("sleep — resolves after delay", async () => {
  const start = Date.now();
  await sleep(15);
  assert.ok(Date.now() - start >= 10, "should wait at least ~10ms");
});

test("sleep — returns a Promise", () => {
  const p = sleep(0);
  assert.ok(p instanceof Promise);
});

// ── pickSnapshotFields ────────────────────────────────────────────────────────

const FULL_BAT = {
  sn: "SN1", alias: "Bat A",
  soc: 80, soh: 99, power: -500,
  cellDelta: 15, cellVoltageMin: 3180, cellVoltageMax: 3195,
  maxCellNum: 3, minCellNum: 12,
  isBalancing: true,
  cellVoltages: [3180, 3185, 3195, 3190],
  cellTemps: [28, 29, 30, 31],
  tempMax: 31, tempMin: 28,
  warningCount: 2, batCycleIndex: 120,
  // extra fields that should NOT appear in snapshot
  model: "BP-10K", bmsState: 64,
};

test("pickSnapshotFields — maps sn and alias", () => {
  const s = pickSnapshotFields(FULL_BAT);
  assert.equal(s.sn,    "SN1");
  assert.equal(s.alias, "Bat A");
});

test("pickSnapshotFields — maps soc, soh, power", () => {
  const s = pickSnapshotFields(FULL_BAT);
  assert.equal(s.soc,   80);
  assert.equal(s.soh,   99);
  assert.equal(s.power, -500);
});

test("pickSnapshotFields — maps cell delta and bounds", () => {
  const s = pickSnapshotFields(FULL_BAT);
  assert.equal(s.cellDelta, 15);
  assert.equal(s.cellMin,   3180);
  assert.equal(s.cellMax,   3195);
});

test("pickSnapshotFields — maps maxCellNum and minCellNum", () => {
  const s = pickSnapshotFields(FULL_BAT);
  assert.equal(s.maxCellNum, 3);
  assert.equal(s.minCellNum, 12);
});

test("pickSnapshotFields — maps isBalancing", () => {
  assert.equal(pickSnapshotFields(FULL_BAT).isBalancing, true);
});

test("pickSnapshotFields — maps voltages from cellVoltages", () => {
  assert.deepEqual(pickSnapshotFields(FULL_BAT).voltages, [3180, 3185, 3195, 3190]);
});

test("pickSnapshotFields — maps temps from cellTemps", () => {
  assert.deepEqual(pickSnapshotFields(FULL_BAT).temps, [28, 29, 30, 31]);
});

test("pickSnapshotFields — maps tempMax and tempMin", () => {
  const s = pickSnapshotFields(FULL_BAT);
  assert.equal(s.tempMax, 31);
  assert.equal(s.tempMin, 28);
});

test("pickSnapshotFields — maps warningCount and batCycleIndex", () => {
  const s = pickSnapshotFields(FULL_BAT);
  assert.equal(s.warningCount,  2);
  assert.equal(s.batCycleIndex, 120);
});

test("pickSnapshotFields — does not include extra battery fields", () => {
  const s = pickSnapshotFields(FULL_BAT);
  assert.equal(s.model,    undefined);
  assert.equal(s.bmsState, undefined);
});
