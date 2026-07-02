"use strict";

const { test } = require("node:test");
const assert   = require("node:assert/strict");
const {
  computeAlerts,
  computeEnergyHistory,
  computeCellStats,
  computePowerStats,
  AlertSeverity,
} = require("../src/analyze");
const {
  HEALTH_CELL_DELTA_WARN,
  HEALTH_CELL_DELTA_CRIT,
  HEALTH_TEMP_WARN,
  HEALTH_TEMP_CRIT,
  HEALTH_SOH_WARN,
} = require("../src/compute");

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeBat(overrides = {}) {
  return {
    sn: "SN1", alias: "Bat1",
    cellDelta: 50, tempMax: 35, soh: 95,
    warningCount: 0, batUnderVoltageCount: 0, dataTime: null,
    ...overrides,
  };
}

function makeHealth(overrides = {}) {
  return { outliers: [], ...overrides };
}

function makeBatEntry(overrides = {}) {
  return {
    sn: "SN1", alias: "Bat1",
    power: -500,
    voltages: Array(16).fill(3200),
    soc: 80, soh: 99, cellDelta: 10,
    ...overrides,
  };
}

function makeSnap(ts, batteries) {
  return { ts, batteries };
}

function isoAt(minutesFromNow) {
  return new Date(Date.now() + minutesFromNow * 60_000).toISOString();
}

// Produces "YYYY-MM-DD HH:MM:SS" in local time — matches the format bat.dataTime uses
function localTimeString(minutesAgo = 0) {
  const d   = new Date(Date.now() - minutesAgo * 60_000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ── computeAlerts — cellDelta ─────────────────────────────────────────────────

test("computeAlerts — no alerts for healthy battery", () => {
  const alerts = computeAlerts([makeBat()], { SN1: makeHealth() });
  assert.deepEqual(alerts, []);
});

test("computeAlerts — cell_delta_warn when cellDelta >= WARN threshold", () => {
  const alerts = computeAlerts(
    [makeBat({ cellDelta: HEALTH_CELL_DELTA_WARN })],
    { SN1: makeHealth() },
  );
  assert.ok(alerts.some((a) => a.code === "cell_delta_warn"));
});

test("computeAlerts — cell_delta_crit when cellDelta >= CRIT threshold", () => {
  const alerts = computeAlerts(
    [makeBat({ cellDelta: HEALTH_CELL_DELTA_CRIT })],
    { SN1: makeHealth() },
  );
  assert.ok(alerts.some((a) => a.code === "cell_delta_crit"));
  assert.ok(alerts.every((a) => a.code !== "cell_delta_warn"), "warn should not appear when crit fires");
});

test("computeAlerts — no cell_delta alert when cellDelta is null", () => {
  const alerts = computeAlerts(
    [makeBat({ cellDelta: null })],
    { SN1: makeHealth() },
  );
  assert.ok(!alerts.some((a) => a.code.startsWith("cell_delta")));
});

// ── computeAlerts — temperature ───────────────────────────────────────────────

test("computeAlerts — temp_warn when tempMax >= WARN threshold", () => {
  const alerts = computeAlerts(
    [makeBat({ tempMax: HEALTH_TEMP_WARN })],
    { SN1: makeHealth() },
  );
  assert.ok(alerts.some((a) => a.code === "temp_warn"));
});

test("computeAlerts — temp_crit when tempMax >= CRIT threshold", () => {
  const alerts = computeAlerts(
    [makeBat({ tempMax: HEALTH_TEMP_CRIT })],
    { SN1: makeHealth() },
  );
  assert.ok(alerts.some((a) => a.code === "temp_crit"));
  assert.ok(alerts.every((a) => a.code !== "temp_warn"), "warn should not appear when crit fires");
});

// ── computeAlerts — SOH ───────────────────────────────────────────────────────

test("computeAlerts — soh_warn when soh below HEALTH_SOH_WARN", () => {
  const alerts = computeAlerts(
    [makeBat({ soh: HEALTH_SOH_WARN - 1 })],
    { SN1: makeHealth() },
  );
  assert.ok(alerts.some((a) => a.code === "soh_warn"));
});

test("computeAlerts — no soh_warn when soh at HEALTH_SOH_WARN", () => {
  const alerts = computeAlerts(
    [makeBat({ soh: HEALTH_SOH_WARN })],
    { SN1: makeHealth() },
  );
  assert.ok(!alerts.some((a) => a.code === "soh_warn"));
});

// ── computeAlerts — outliers ──────────────────────────────────────────────────

test("computeAlerts — outlier_cells alert when health has outliers", () => {
  const alerts = computeAlerts(
    [makeBat()],
    { SN1: makeHealth({ outliers: [4, 7] }) },
  );
  assert.ok(alerts.some((a) => a.code === "outlier_cells"));
});

test("computeAlerts — no outlier_cells when outliers empty", () => {
  const alerts = computeAlerts([makeBat()], { SN1: makeHealth({ outliers: [] }) });
  assert.ok(!alerts.some((a) => a.code === "outlier_cells"));
});

// ── computeAlerts — BMS warnings ─────────────────────────────────────────────

test("computeAlerts — bms_warnings when warningCount > 0", () => {
  const alerts = computeAlerts(
    [makeBat({ warningCount: 3 })],
    { SN1: makeHealth() },
  );
  assert.ok(alerts.some((a) => a.code === "bms_warnings"));
});

test("computeAlerts — undervoltage_events when batUnderVoltageCount > 0", () => {
  const alerts = computeAlerts(
    [makeBat({ batUnderVoltageCount: 2 })],
    { SN1: makeHealth() },
  );
  assert.ok(alerts.some((a) => a.code === "undervoltage_events"));
  assert.equal(alerts.find((a) => a.code === "undervoltage_events")?.severity, AlertSeverity.INFO);
});

// ── computeAlerts — stale data ────────────────────────────────────────────────

test("computeAlerts — stale_data alert when dataTime is > 30 min ago", () => {
  const alerts = computeAlerts([makeBat({ dataTime: localTimeString(35) })], { SN1: makeHealth() });
  assert.ok(alerts.some((a) => a.code === "stale_data"));
});

test("computeAlerts — no stale_data when dataTime is recent", () => {
  const alerts = computeAlerts([makeBat({ dataTime: localTimeString(5) })], { SN1: makeHealth() });
  assert.ok(!alerts.some((a) => a.code === "stale_data"));
});

// ── computeAlerts — ordering ──────────────────────────────────────────────────

test("computeAlerts — crits come before warns come before infos", () => {
  const bat = makeBat({
    cellDelta: HEALTH_CELL_DELTA_CRIT,
    tempMax: HEALTH_TEMP_WARN,
    batUnderVoltageCount: 1,
  });
  const alerts = computeAlerts([bat], { SN1: makeHealth() });
  const severities = alerts.map((a) => a.severity);
  const critIdx  = severities.indexOf(AlertSeverity.CRIT);
  const warnIdx  = severities.indexOf(AlertSeverity.WARN);
  const infoIdx  = severities.indexOf(AlertSeverity.INFO);
  if (critIdx >= 0 && warnIdx >= 0) assert.ok(critIdx < warnIdx);
  if (warnIdx >= 0 && infoIdx  >= 0) assert.ok(warnIdx < infoIdx);
});

test("computeAlerts — returns empty array for empty battery list", () => {
  assert.deepEqual(computeAlerts([], {}), []);
});

// ── computeEnergyHistory ──────────────────────────────────────────────────────

test("computeEnergyHistory — returns empty array with < 2 snapshots", () => {
  assert.deepEqual(computeEnergyHistory([]), []);
  assert.deepEqual(computeEnergyHistory([makeSnap(isoAt(0), [makeBatEntry()])]), []);
});

test("computeEnergyHistory — accumulates discharged kWh across consecutive snapshots", () => {
  // 2 snapshots 1 h apart, 1000 W discharge → 1 kWh
  const t0 = new Date("2026-07-01T10:00:00Z").toISOString();
  const t1 = new Date("2026-07-01T11:00:00Z").toISOString();
  const snaps = [
    makeSnap(t0, [makeBatEntry({ power: -1000 })]),
    makeSnap(t1, [makeBatEntry({ power: -1000 })]),
  ];
  const history = computeEnergyHistory(snaps);
  assert.equal(history.length, 1);
  assert.ok(history[0].kwhDischarged > 0);
  assert.equal(history[0].kwhCharged, 0);
});

test("computeEnergyHistory — accumulates charged kWh correctly", () => {
  const t0 = new Date("2026-07-01T09:00:00Z").toISOString();
  const t1 = new Date("2026-07-01T10:00:00Z").toISOString();
  const snaps = [
    makeSnap(t0, [makeBatEntry({ power:  2000 })]),
    makeSnap(t1, [makeBatEntry({ power:  2000 })]),
  ];
  const history = computeEnergyHistory(snaps);
  assert.equal(history.length, 1);
  assert.ok(history[0].kwhCharged > 0);
  assert.equal(history[0].kwhDischarged, 0);
});

test("computeEnergyHistory — skips gaps > 2 h between snapshots", () => {
  const t0 = new Date("2026-07-01T00:00:00Z").toISOString();
  const t1 = new Date("2026-07-01T03:00:00Z").toISOString(); // 3-h gap
  const snaps = [
    makeSnap(t0, [makeBatEntry({ power: -1000 })]),
    makeSnap(t1, [makeBatEntry({ power: -1000 })]),
  ];
  const history = computeEnergyHistory(snaps);
  assert.equal(history.reduce((s, d) => s + d.kwhDischarged, 0), 0);
});

test("computeEnergyHistory — tracks peak charge and discharge kW", () => {
  const t0 = new Date("2026-07-01T10:00:00Z").toISOString();
  const t1 = new Date("2026-07-01T10:10:00Z").toISOString();
  const t2 = new Date("2026-07-01T10:20:00Z").toISOString();
  const snaps = [
    makeSnap(t0, [makeBatEntry({ power: -3000 })]),
    makeSnap(t1, [makeBatEntry({ power: -5000 })]),
    makeSnap(t2, [makeBatEntry({ power: -2000 })]),
  ];
  const history = computeEnergyHistory(snaps);
  assert.equal(history.length, 1);
  assert.equal(history[0].peakDischargeKw, 5);
});

// ── computeCellStats ──────────────────────────────────────────────────────────

test("computeCellStats — returns empty array with < 2 snapshots for that battery", () => {
  const snap = makeSnap(isoAt(0), [makeBatEntry()]);
  assert.deepEqual(computeCellStats([snap], "SN1"), []);
});

test("computeCellStats — returns one stat per cell", () => {
  const t0 = isoAt(-20);
  const t1 = isoAt(-10);
  const snaps = [
    makeSnap(t0, [makeBatEntry({ voltages: Array(16).fill(3200) })]),
    makeSnap(t1, [makeBatEntry({ voltages: Array(16).fill(3200) })]),
  ];
  const stats = computeCellStats(snaps, "SN1");
  assert.equal(stats.length, 16);
});

test("computeCellStats — cell index and module number are 1-based", () => {
  const t0 = isoAt(-20);
  const t1 = isoAt(-10);
  const snaps = [
    makeSnap(t0, [makeBatEntry({ voltages: Array(16).fill(3200) })]),
    makeSnap(t1, [makeBatEntry({ voltages: Array(16).fill(3200) })]),
  ];
  const stats = computeCellStats(snaps, "SN1");
  assert.equal(stats[0].cell, 1);
  assert.ok(stats[0].module >= 1);
});

test("computeCellStats — mean equals input voltage when all readings identical", () => {
  const t0 = isoAt(-20);
  const t1 = isoAt(-10);
  const snaps = [
    makeSnap(t0, [makeBatEntry({ voltages: Array(16).fill(3300) })]),
    makeSnap(t1, [makeBatEntry({ voltages: Array(16).fill(3300) })]),
  ];
  const stats = computeCellStats(snaps, "SN1");
  assert.equal(stats[0].mean, 3300);
  assert.equal(stats[0].stddev, 0);
});

test("computeCellStats — returns empty when battery SN not found in snapshots", () => {
  const t0 = isoAt(-20);
  const t1 = isoAt(-10);
  const snaps = [
    makeSnap(t0, [makeBatEntry({ sn: "SN2" })]),
    makeSnap(t1, [makeBatEntry({ sn: "SN2" })]),
  ];
  assert.deepEqual(computeCellStats(snaps, "SN1"), []);
});

// ── computePowerStats ─────────────────────────────────────────────────────────

test("computePowerStats — returns zero/null for empty snapshots", () => {
  const stats = computePowerStats([], []);
  assert.equal(stats.totalSamples, 0);
  assert.equal(stats.peakChargeKw, 0);
  assert.equal(stats.avgCRate, null);
});

test("computePowerStats — counts charge and discharge samples separately", () => {
  const t0 = isoAt(-30);
  const t1 = isoAt(-20);
  const t2 = isoAt(-10);
  const snaps = [
    makeSnap(t0, [makeBatEntry({ power:  1000 })]),
    makeSnap(t1, [makeBatEntry({ power: -2000 })]),
    makeSnap(t2, [makeBatEntry({ power: -2000 })]),
  ];
  const stats = computePowerStats(snaps, []);
  assert.equal(stats.chargeSamples,    1);
  assert.equal(stats.dischargeSamples, 2);
  assert.equal(stats.totalSamples,     3);
});

test("computePowerStats — peakDischargeKw is the max discharge kW seen", () => {
  const snaps = [
    makeSnap(isoAt(-20), [makeBatEntry({ power: -3000 })]),
    makeSnap(isoAt(-10), [makeBatEntry({ power: -7000 })]),
  ];
  const stats = computePowerStats(snaps, []);
  assert.equal(stats.peakDischargeKw, 7);
});

test("computePowerStats — avgCRate null when no ratedEnergyKwh provided", () => {
  const snaps = [makeSnap(isoAt(-10), [makeBatEntry({ power: -2000 })])];
  const stats = computePowerStats(snaps, [{ ratedEnergyKwh: null }]);
  assert.equal(stats.avgCRate, null);
});

test("computePowerStats — avgCRate computed when ratedEnergyKwh > 0", () => {
  // 4 kW discharge, 8 kWh total rated → C-rate = 4/8 = 0.5
  const snaps = [makeSnap(isoAt(-10), [makeBatEntry({ power: -4000 })])];
  const stats = computePowerStats(snaps, [{ ratedEnergyKwh: 8 }]);
  assert.equal(stats.avgCRate, 0.5);
});
