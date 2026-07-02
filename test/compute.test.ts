import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeHealth,
  computeAutonomy,
  HEALTH_CELL_DELTA_WARN,
  HEALTH_CELL_DELTA_CRIT,
  HEALTH_TEMP_WARN,
  HEALTH_TEMP_CRIT,
  HEALTH_SOH_WARN,
  OUTLIER_SNAP_WINDOW,
  DISCHARGE_DELTA_MIN_SNAPS,
  MIN_DISCHARGE_RATE_KW,
  MAX_DISCHARGE_RATE_KW,
} from "../src/compute";
import { HealthStatus } from "../src/enums";
import type { Battery } from "../src/battery";
import type { BatterySnapshot } from "../src/store";
import type { SnapshotEntry } from "../src/helpers";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeBat(overrides: Record<string, unknown> = {}): Battery {
  return {
    sn: "SN1", alias: "Bat1",
    cellDelta: 50, tempMax: 35, soh: 95,
    cellVoltages: [],
    capacityAh: 314, voltage: 51.2,
    remainingKwh: 10, soc: 80,
    ratedEnergyKwh: null, power: 0,
    ...overrides,
  } as unknown as Battery;
}

function makeBatEntry(overrides: Record<string, unknown> = {}): SnapshotEntry {
  return {
    sn: "SN1", alias: "Bat1",
    power: -500, cellDelta: 10,
    voltages: Array(16).fill(3200),
    soc: 80, soh: 99,
    ...overrides,
  } as unknown as SnapshotEntry;
}

function makeSnap(batteries: SnapshotEntry[], minsAgo = 0): BatterySnapshot {
  return {
    ts: new Date(Date.now() - minsAgo * 60_000).toISOString(),
    batteries,
  };
}

// ── computeHealth — cellDeltaStatus ──────────────────────────────────────────

test("computeHealth — cellDeltaStatus null when cellDelta is null", () => {
  assert.equal(computeHealth([makeBat({ cellDelta: null })], [])["SN1"].cellDeltaStatus, null);
});

test("computeHealth — cellDeltaStatus OK below WARN threshold", () => {
  assert.equal(
    computeHealth([makeBat({ cellDelta: HEALTH_CELL_DELTA_WARN - 1 })], [])["SN1"].cellDeltaStatus,
    HealthStatus.OK,
  );
});

test("computeHealth — cellDeltaStatus WARN at boundary", () => {
  assert.equal(
    computeHealth([makeBat({ cellDelta: HEALTH_CELL_DELTA_WARN })], [])["SN1"].cellDeltaStatus,
    HealthStatus.WARN,
  );
});

test("computeHealth — cellDeltaStatus CRIT at boundary", () => {
  assert.equal(
    computeHealth([makeBat({ cellDelta: HEALTH_CELL_DELTA_CRIT })], [])["SN1"].cellDeltaStatus,
    HealthStatus.CRIT,
  );
});

test("computeHealth — cellDeltaStatus CRIT above boundary", () => {
  assert.equal(
    computeHealth([makeBat({ cellDelta: HEALTH_CELL_DELTA_CRIT + 50 })], [])["SN1"].cellDeltaStatus,
    HealthStatus.CRIT,
  );
});

// ── computeHealth — tempStatus ────────────────────────────────────────────────

test("computeHealth — tempStatus null when tempMax is null", () => {
  assert.equal(computeHealth([makeBat({ tempMax: null })], [])["SN1"].tempStatus, null);
});

test("computeHealth — tempStatus OK below WARN threshold", () => {
  assert.equal(
    computeHealth([makeBat({ tempMax: HEALTH_TEMP_WARN - 1 })], [])["SN1"].tempStatus,
    HealthStatus.OK,
  );
});

test("computeHealth — tempStatus WARN at boundary", () => {
  assert.equal(
    computeHealth([makeBat({ tempMax: HEALTH_TEMP_WARN })], [])["SN1"].tempStatus,
    HealthStatus.WARN,
  );
});

test("computeHealth — tempStatus CRIT at boundary", () => {
  assert.equal(
    computeHealth([makeBat({ tempMax: HEALTH_TEMP_CRIT })], [])["SN1"].tempStatus,
    HealthStatus.CRIT,
  );
});

// ── computeHealth — sohStatus ─────────────────────────────────────────────────

test("computeHealth — sohStatus null when soh is null", () => {
  assert.equal(computeHealth([makeBat({ soh: null })], [])["SN1"].sohStatus, null);
});

test("computeHealth — sohStatus OK at or above warn threshold", () => {
  assert.equal(
    computeHealth([makeBat({ soh: HEALTH_SOH_WARN })], [])["SN1"].sohStatus,
    HealthStatus.OK,
  );
});

test("computeHealth — sohStatus WARN below threshold", () => {
  assert.equal(
    computeHealth([makeBat({ soh: HEALTH_SOH_WARN - 1 })], [])["SN1"].sohStatus,
    HealthStatus.WARN,
  );
});

// ── computeHealth — outliers ──────────────────────────────────────────────────

test("computeHealth — outliers empty when not enough snapshots", () => {
  const voltages = Array(16).fill(3200);
  voltages[3] = 3140;
  const snaps = [makeSnap([makeBatEntry({ voltages, power: -500 })], 5)];
  assert.deepEqual(computeHealth([makeBat({ cellVoltages: voltages })], snaps)["SN1"].outliers, []);
});

test("computeHealth — outlier flagged when persistently low across required snapshots", () => {
  const voltages = Array(16).fill(3200);
  voltages[3] = 3140;
  const snapEntry = makeBatEntry({ voltages, power: -500 });
  const snaps = Array.from({ length: OUTLIER_SNAP_WINDOW }, (_, i) =>
    makeSnap([snapEntry], i * 10));
  const r = computeHealth([makeBat({ cellVoltages: voltages })], snaps);
  assert.ok(r["SN1"].outliers.includes(4), "cell 4 should be flagged as an outlier");
});

test("computeHealth — outlier not flagged when snapshot shows charging (power >= 0)", () => {
  const voltages = Array(16).fill(3200);
  voltages[3] = 3140;
  const snapEntry = makeBatEntry({ voltages, power: 0 });
  const snaps = Array.from({ length: OUTLIER_SNAP_WINDOW }, (_, i) =>
    makeSnap([snapEntry], i * 10));
  const r = computeHealth([makeBat({ cellVoltages: voltages })], snaps);
  assert.deepEqual(r["SN1"].outliers, []);
});

// ── computeHealth — avgCRate ──────────────────────────────────────────────────

test("computeHealth — avgCRate null with no snapshots", () => {
  assert.equal(computeHealth([makeBat()], [])["SN1"].avgCRate, null);
});

test("computeHealth — avgCRate computed from discharge snapshots", () => {
  const bat   = makeBat({ capacityAh: 100, voltage: 50 });
  const snaps = [makeSnap([makeBatEntry({ power: -1000 })], 10)];
  const rate  = computeHealth([bat], snaps)["SN1"].avgCRate;
  assert.ok(rate !== null, "avgCRate should not be null");
  assert.ok(rate > 0,      "avgCRate should be positive");
});

test("computeHealth — avgCRate averages multiple snapshots", () => {
  const bat   = makeBat({ capacityAh: 100, voltage: 50 });
  const snaps = [
    makeSnap([makeBatEntry({ power: -500  })], 20),
    makeSnap([makeBatEntry({ power: -1500 })], 10),
  ];
  const rate = computeHealth([bat], snaps)["SN1"].avgCRate;
  assert.equal(rate, 0.2);
});

// ── computeHealth — dischargeDelta ────────────────────────────────────────────

test("computeHealth — dischargeDelta null with fewer than DISCHARGE_DELTA_MIN_SNAPS qualifying snaps", () => {
  const snaps = [makeSnap([makeBatEntry({ power: -500, cellDelta: 10 })], 5)];
  assert.equal(computeHealth([makeBat()], snaps)["SN1"].dischargeDelta, null);
});

test("computeHealth — dischargeDelta is median of qualifying discharge snapshots", () => {
  const snaps = [
    makeSnap([makeBatEntry({ power: -500, cellDelta: 10 })], 30),
    makeSnap([makeBatEntry({ power: -500, cellDelta: 20 })], 20),
    makeSnap([makeBatEntry({ power: -500, cellDelta: 15 })], 10),
  ];
  assert.equal(computeHealth([makeBat()], snaps)["SN1"].dischargeDelta, 15);
});

test("computeHealth — dischargeDelta excludes charging snapshots", () => {
  const snaps = [
    makeSnap([makeBatEntry({ power:  500, cellDelta:  5 })], 40),
    makeSnap([makeBatEntry({ power: -500, cellDelta: 10 })], 30),
    makeSnap([makeBatEntry({ power: -500, cellDelta: 15 })], 20),
    makeSnap([makeBatEntry({ power: -500, cellDelta: 20 })], 10),
  ];
  assert.equal(computeHealth([makeBat()], snaps)["SN1"].dischargeDelta, 15);
});

test("computeHealth — dischargeDelta excludes snapshots where delta >= 30 mV", () => {
  const snaps = [
    makeSnap([makeBatEntry({ power: -500, cellDelta: 30 })], 30),
    makeSnap([makeBatEntry({ power: -500, cellDelta: 10 })], 20),
    makeSnap([makeBatEntry({ power: -500, cellDelta: 15 })], 10),
    makeSnap([makeBatEntry({ power: -500, cellDelta: 20 })], 5),
  ];
  assert.equal(computeHealth([makeBat()], snaps)["SN1"].dischargeDelta, 15);
});

// ── computeHealth — multi-battery and passthrough fields ─────────────────────

test("computeHealth — returns entry per battery keyed by SN", () => {
  const bats = [
    makeBat({ sn: "SN1", alias: "Bat1" }),
    makeBat({ sn: "SN2", alias: "Bat2", cellDelta: HEALTH_CELL_DELTA_CRIT + 1 }),
  ];
  const r = computeHealth(bats, []);
  assert.ok("SN1" in r, "SN1 should have an entry");
  assert.ok("SN2" in r, "SN2 should have an entry");
  assert.equal(r["SN2"].cellDeltaStatus, HealthStatus.CRIT);
});

test("computeHealth — alias field is set in result", () => {
  const r = computeHealth([makeBat({ alias: "My Battery" })], []);
  assert.equal(r["SN1"].alias, "My Battery");
});

test("computeHealth — cellDelta passthrough value", () => {
  const r = computeHealth([makeBat({ cellDelta: 77 })], []);
  assert.equal(r["SN1"].cellDelta, 77);
});

test("computeHealth — empty battery array returns empty result", () => {
  assert.deepEqual(computeHealth([], []), {});
});

// ── computeAutonomy — discharge rate selection ────────────────────────────────

test("computeAutonomy — uses live discharge rate when actively discharging", () => {
  const bat = makeBat({ power: -2000 });
  const r   = computeAutonomy([bat], []);
  assert.equal(r.dischargeRateKw, 2);
});

test("computeAutonomy — falls back to defaultDischargeKw when not discharging and no snaps", () => {
  const r = computeAutonomy([makeBat({ power: 0 })], [], { defaultDischargeKw: 1.5 });
  assert.equal(r.dischargeRateKw, 1.5);
});

test("computeAutonomy — uses snapshot history rate when available and not live-discharging", () => {
  const bat  = makeBat({ power: 0 });
  const snap: BatterySnapshot = {
    ts: new Date().toISOString(),
    batteries: [{ sn: "SN1", power: -2000 } as unknown as SnapshotEntry],
  };
  const r = computeAutonomy([bat], [snap]);
  assert.equal(r.dischargeRateKw, 2);
});

test("computeAutonomy — dischargeRateKw clamped at MIN_DISCHARGE_RATE_KW", () => {
  const r = computeAutonomy([makeBat()], [], { defaultDischargeKw: 0 });
  assert.equal(r.dischargeRateKw, MIN_DISCHARGE_RATE_KW);
});

test("computeAutonomy — dischargeRateKw clamped at MAX_DISCHARGE_RATE_KW", () => {
  const r = computeAutonomy([makeBat({ power: -999_000 })], []);
  assert.equal(r.dischargeRateKw, MAX_DISCHARGE_RATE_KW);
});

// ── computeAutonomy — estimatedHours ─────────────────────────────────────────

test("computeAutonomy — estimatedHours = usable / rate", () => {
  const bat = makeBat({ power: -1000, remainingKwh: 10, ratedEnergyKwh: 10 });
  assert.equal(computeAutonomy([bat], [], { minSocPct: 0 }).estimatedHours, 10);
});

test("computeAutonomy — minSocPct reserves capacity and reduces hours", () => {
  const bat = makeBat({ power: -1000, remainingKwh: 10, ratedEnergyKwh: 10 });
  assert.equal(computeAutonomy([bat], [], { minSocPct: 10 }).estimatedHours, 9);
});

// ── computeAutonomy — estimatedHoursToFull ───────────────────────────────────

test("computeAutonomy — estimatedHoursToFull null when not charging", () => {
  assert.equal(computeAutonomy([makeBat({ power: 0 })], []).estimatedHoursToFull, null);
});

test("computeAutonomy — estimatedHoursToFull computed when charging", () => {
  const bat = makeBat({ power: 1000, soc: 50, ratedEnergyKwh: 10 });
  assert.equal(computeAutonomy([bat], []).estimatedHoursToFull, 5);
});

// ── computeAutonomy — estimatedSocAtSunrise ───────────────────────────────────

test("computeAutonomy — estimatedSocAtSunrise null when sunriseAt not provided", () => {
  assert.equal(computeAutonomy([makeBat()], []).estimatedSocAtSunrise, null);
});

test("computeAutonomy — estimatedSocAtSunrise within [minSocPct, 100]", () => {
  const bat     = makeBat({ power: -1000, remainingKwh: 5, ratedEnergyKwh: 10, soc: 50 });
  const sunrise = new Date(Date.now() + 8 * 3_600_000).toISOString();
  const r       = computeAutonomy([bat], [], { sunriseAt: sunrise, minSocPct: 5 });
  assert.ok(r.estimatedSocAtSunrise != null && r.estimatedSocAtSunrise >= 5 && r.estimatedSocAtSunrise <= 100);
});

test("computeAutonomy — estimatedSocAtSunrise is 100 when sunrise is in the past and battery is full", () => {
  const bat     = makeBat({ power: 0, remainingKwh: 16, ratedEnergyKwh: 16, soc: 100 });
  const sunrise = new Date(Date.now() - 1000).toISOString();
  const r       = computeAutonomy([bat], [], { sunriseAt: sunrise, minSocPct: 5 });
  assert.equal(r.estimatedSocAtSunrise, 100);
});

// ── computeAutonomy — aggregate fields ───────────────────────────────────────

test("computeAutonomy — totalRemainingKwh sums across all batteries", () => {
  const bats = [
    makeBat({ sn: "SN1", remainingKwh: 8, ratedEnergyKwh: 10 }),
    makeBat({ sn: "SN2", remainingKwh: 6, ratedEnergyKwh: 10 }),
  ];
  assert.equal(computeAutonomy(bats, [], { defaultDischargeKw: 1 }).totalRemainingKwh, 14);
});

test("computeAutonomy — perBattery has one entry per battery", () => {
  const bats = [
    makeBat({ sn: "SN1", remainingKwh: 8, ratedEnergyKwh: 10 }),
    makeBat({ sn: "SN2", remainingKwh: 6, ratedEnergyKwh: 10 }),
  ];
  const r = computeAutonomy(bats, []);
  assert.equal(r.perBattery.length, 2);
  assert.equal(r.perBattery[0].sn, "SN1");
  assert.equal(r.perBattery[1].sn, "SN2");
});

test("computeAutonomy — perBattery remainingKwh matches input", () => {
  const bat = makeBat({ remainingKwh: 7.654 });
  const r   = computeAutonomy([bat], []);
  assert.equal(r.perBattery[0].remainingKwh, 7.7);
});

// ── computeAutonomy — new aggregate fields ────────────────────────────────────

test("computeAutonomy — totalCapacityKwh uses ratedEnergyKwh when available", () => {
  const bat = makeBat({ ratedEnergyKwh: 15, remainingKwh: 12, soc: 80 });
  const r   = computeAutonomy([bat], []);
  assert.equal(r.totalCapacityKwh, 15);
});

test("computeAutonomy — totalCapacityKwh back-calculated from remainingKwh/soc when ratedEnergyKwh is null", () => {
  const bat = makeBat({ ratedEnergyKwh: null, remainingKwh: 10, soc: 80 });
  const r   = computeAutonomy([bat], []);
  assert.equal(r.totalCapacityKwh, 12.5);
});

test("computeAutonomy — hoursToSunrise is null when sunriseAt not provided", () => {
  assert.equal(computeAutonomy([makeBat()], []).hoursToSunrise, null);
});

test("computeAutonomy — hoursToSunrise is non-negative when sunriseAt is in the future", () => {
  const sunrise = new Date(Date.now() + 6 * 3_600_000).toISOString();
  const r = computeAutonomy([makeBat({ ratedEnergyKwh: 10, power: -1000 })], [], { sunriseAt: sunrise });
  assert.ok(r.hoursToSunrise != null && r.hoursToSunrise >= 0);
});

test("computeAutonomy — estimatedDischargeKwh null when sunriseAt not provided", () => {
  assert.equal(computeAutonomy([makeBat()], []).estimatedDischargeKwh, null);
});

test("computeAutonomy — estimatedDischargeKwh = rate × hoursToSunrise", () => {
  const bat     = makeBat({ power: -2000, remainingKwh: 10, ratedEnergyKwh: 10 });
  const sunrise = new Date(Date.now() + 3 * 3_600_000).toISOString();
  const r       = computeAutonomy([bat], [], { sunriseAt: sunrise });
  assert.ok(r.estimatedDischargeKwh != null && Math.abs(r.estimatedDischargeKwh - 6) < 0.2);
});

test("computeAutonomy — estimatedRemainingKwh null when sunriseAt not provided", () => {
  assert.equal(computeAutonomy([makeBat()], []).estimatedRemainingKwh, null);
});

test("computeAutonomy — estimatedRemainingKwh consistent with estimatedSocAtSunrise", () => {
  const bat     = makeBat({ power: -500, remainingKwh: 8, ratedEnergyKwh: 10, soc: 80 });
  const sunrise = new Date(Date.now() + 4 * 3_600_000).toISOString();
  const r       = computeAutonomy([bat], [], { sunriseAt: sunrise, minSocPct: 5 });
  assert.ok(r.estimatedRemainingKwh != null);
  assert.ok(r.estimatedRemainingKwh >= r.totalCapacityKwh * 0.05 - 0.1);
});
