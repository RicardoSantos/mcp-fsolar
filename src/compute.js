"use strict";

const { clamp }        = require("./helpers");
const { HealthStatus } = require("./enums");

// ── Health thresholds ─────────────────────────────────────────────────────────
const HEALTH_CELL_DELTA_WARN = 120;  // mV
const HEALTH_CELL_DELTA_CRIT = 200;  // mV
const HEALTH_TEMP_WARN       = 40;   // °C
const HEALTH_TEMP_CRIT       = 50;   // °C
const HEALTH_OUTLIER_MV      = 35;   // mV below pack avg to flag a cell as an outlier
const HEALTH_SOH_WARN        = 90;   // %

// ── computeHealth tuning ──────────────────────────────────────────────────────
const OUTLIER_SNAP_WINDOW       = 3;   // snapshots checked for persistent outlier confirmation
const CRATE_SNAP_WINDOW         = 6;   // snapshots averaged for C-rate estimate
const NOMINAL_VOLTAGE_V         = 48;  // LiFePO4 4S nominal — fallback when live voltage is absent
const MIN_POWER_FOR_CRATE_W     = 50;  // minimum |power| (W) for a snapshot to contribute to C-rate
const DISCHARGE_DELTA_MAX_MV    = 30;  // max cellDelta for a snapshot to qualify for discharge-delta median
const DISCHARGE_DELTA_MIN_SNAPS = 3;   // min qualifying snapshots to compute discharge-delta median

// ── computeAutonomy tuning ────────────────────────────────────────────────────
const MIN_ACTIVE_DISCHARGE_W  = 100;  // fleet |power| must exceed this to use live rate instead of history
const MIN_ACTIVE_CHARGE_W     = 50;   // fleet power must exceed this to compute estimatedHoursToFull
const MIN_ACTIVE_BAT_W        = 50;   // per-battery |power| must exceed this to use live rate
const MIN_DISCHARGE_RATE_KW   = 0.2;  // clamp floor for discharge rate estimate
const MAX_DISCHARGE_RATE_KW   = 24;   // clamp ceiling for discharge rate estimate

function computeHealth(batteries, snapshots) {
  // Pre-index snapshot entries by SN — O(snapshots × batteries_per_snap) once,
  // then O(1) per battery instead of O(M) find() inside each loop.
  const snapsBySn = new Map();
  for (const snap of snapshots) {
    for (const b of snap.batteries) {
      if (!snapsBySn.has(b.sn)) snapsBySn.set(b.sn, []);
      snapsBySn.get(b.sn).push(b);
    }
  }

  const result = {};

  for (const bat of batteries) {
    const cellDeltaStatus = bat.cellDelta == null ? null
      : bat.cellDelta >= HEALTH_CELL_DELTA_CRIT ? HealthStatus.CRIT
      : bat.cellDelta >= HEALTH_CELL_DELTA_WARN ? HealthStatus.WARN
      : HealthStatus.OK;

    const tempStatus = bat.tempMax == null ? null
      : bat.tempMax >= HEALTH_TEMP_CRIT ? HealthStatus.CRIT
      : bat.tempMax >= HEALTH_TEMP_WARN ? HealthStatus.WARN
      : HealthStatus.OK;

    const sohStatus = bat.soh == null ? null : bat.soh < HEALTH_SOH_WARN ? HealthStatus.WARN : HealthStatus.OK;

    const batSnaps = snapsBySn.get(bat.sn) ?? [];

    // Persistent cell outliers — gate on snapshot discharge history, not live state,
    // so standby ticks don't erase a previously detected weak cell.
    let outliers = [];
    const batLastN = batSnaps.slice(-OUTLIER_SNAP_WINDOW);
    if (batLastN.length >= OUTLIER_SNAP_WINDOW && bat.cellVoltages?.length > 0) {
      const avg = bat.cellVoltages.reduce((s, v) => s + v, 0) / bat.cellVoltages.length;
      outliers = bat.cellVoltages
        .map((v, i) => ({ cell: i + 1, dev: v - avg }))
        .filter((c) => c.dev < -HEALTH_OUTLIER_MV)
        .filter((o) => batLastN.every((b) => {
          if (!b?.voltages?.length || (b.power ?? 0) >= 0) return false;
          const a = b.voltages.reduce((s, v) => s + v, 0) / b.voltages.length;
          return (b.voltages[o.cell - 1] ?? a) - a < -HEALTH_OUTLIER_MV;
        }))
        .map((o) => o.cell);
    }

    // Average C-rate from recent snapshots
    const batRecentSnaps = batSnaps.slice(-CRATE_SNAP_WINDOW);
    const ratedW = (bat.capacityAh ?? 0) * (bat.voltage ?? NOMINAL_VOLTAGE_V);
    const cRates = batRecentSnaps.flatMap((b) => {
      if (!b || Math.abs(b.power ?? 0) < MIN_POWER_FOR_CRATE_W || ratedW <= 0) return [];
      return [Math.abs(b.power) / ratedW];
    });
    const avgCRate = cRates.length
      ? Math.round(cRates.reduce((s, v) => s + v, 0) / cRates.length * 100) / 100
      : null;

    // Discharge-phase delta — median of snapshots where battery was discharging and
    // delta < DISCHARGE_DELTA_MAX_MV. LiFePO4 cells are uniform at rest/discharge;
    // top-of-charge spreads are excluded because the BMS is still balancing and the
    // inflated delta doesn't reflect true cell health.
    const dischargeDeltaSamples = batSnaps
      .filter((b) => (b.power ?? 0) < 0 && b.cellDelta != null && b.cellDelta < DISCHARGE_DELTA_MAX_MV)
      .map((b) => b.cellDelta);
    let dischargeDelta = null;
    if (dischargeDeltaSamples.length >= DISCHARGE_DELTA_MIN_SNAPS) {
      const sorted = [...dischargeDeltaSamples].sort((a, b) => a - b);
      dischargeDelta = sorted[Math.floor(sorted.length / 2)];
    }

    result[bat.sn] = {
      alias:           bat.alias,
      cellDeltaStatus,
      cellDelta:       bat.cellDelta ?? null,
      tempStatus,
      tempMax:         bat.tempMax ?? null,
      sohStatus,
      soh:             bat.soh ?? null,
      outliers,
      avgCRate,
      dischargeDelta,
    };
  }

  return result;
}

function computeAutonomy(batteries, snapshots, opts = {}) {
  const { sunriseAt = null, packCapacityKwh = null, minSocPct = 5, defaultDischargeKw = 1.5 } = opts;

  const totalRemainingKwh = batteries.reduce((s, b) => s + b.remainingKwh, 0);
  const totalPowerW       = batteries.reduce((s, b) => s + (b.power ?? 0), 0);

  // ── Fleet discharge rate ──────────────────────────────────────────────────
  let dischargeRateKw;
  if (totalPowerW < -MIN_ACTIVE_DISCHARGE_W) {
    dischargeRateKw = -totalPowerW / 1000;
  } else {
    const nightSnaps = snapshots.filter((s) => s.batteries.some((b) => (b.power ?? 0) < -MIN_ACTIVE_DISCHARGE_W));
    const avgW = nightSnaps.length
      ? nightSnaps.reduce((acc, snap) => acc + snap.batteries.reduce((sum, entry) => sum + Math.abs(Math.min(0, entry.power ?? 0)), 0), 0) / nightSnaps.length
      : 0;
    dischargeRateKw = avgW > MIN_ACTIVE_DISCHARGE_W ? avgW / 1000 : defaultDischargeKw;
  }
  dischargeRateKw = clamp(MIN_DISCHARGE_RATE_KW, dischargeRateKw, MAX_DISCHARGE_RATE_KW);

  // ── Capacity derivation ───────────────────────────────────────────────────
  const totalCapacityKwh  = packCapacityKwh
    ?? batteries.reduce((s, b) => s + (b.ratedEnergyKwh ?? (b.soc > 0 ? b.remainingKwh / (b.soc / 100) : 0)), 0);
  const perBatCapacityKwh = packCapacityKwh != null ? packCapacityKwh / batteries.length : null;

  // ── Fleet hours until minSoc (discharge) ─────────────────────────────────
  const fleetMinKwh    = totalCapacityKwh * (minSocPct / 100);
  const fleetUsableKwh = Math.max(0, totalRemainingKwh - fleetMinKwh);
  const estimatedHours = Math.round(fleetUsableKwh / dischargeRateKw * 10) / 10;

  // ── Fleet hours until full (charge) ──────────────────────────────────────
  let estimatedHoursToFull = null;
  const avgSoc = batteries.reduce((s, b) => s + b.soc, 0) / batteries.length;
  if (totalPowerW > MIN_ACTIVE_CHARGE_W && avgSoc < 100 && totalCapacityKwh > 0) {
    const remainingToFull = totalCapacityKwh * (1 - avgSoc / 100);
    estimatedHoursToFull = Math.round(remainingToFull / (totalPowerW / 1000) * 10) / 10;
  }

  // ── Per-battery hours until minSoc and until full ─────────────────────────
  const perBattery = batteries.map((bat) => {
    const batCapacityKwh = bat.ratedEnergyKwh
      ?? perBatCapacityKwh
      ?? (bat.soc > 0 ? bat.remainingKwh / (bat.soc / 100) : 0);
    const batMinKwh      = batCapacityKwh * (minSocPct / 100);
    const batUsableKwh   = Math.max(0, bat.remainingKwh - batMinKwh);
    const batDischargeKw = (bat.power ?? 0) < -MIN_ACTIVE_BAT_W
      ? Math.abs(bat.power) / 1000
      : dischargeRateKw / batteries.length;
    const batEstimatedHours = Math.round(batUsableKwh / batDischargeKw * 10) / 10;

    let batEstimatedHoursToFull = null;
    if ((bat.power ?? 0) > MIN_ACTIVE_BAT_W && bat.soc < 100 && batCapacityKwh > 0) {
      const toFull = batCapacityKwh * (1 - bat.soc / 100);
      batEstimatedHoursToFull = Math.round(toFull / (bat.power / 1000) * 10) / 10;
    }

    return {
      sn:                    bat.sn,
      alias:                 bat.alias,
      remainingKwh:          Math.round(bat.remainingKwh * 10) / 10,
      estimatedHours:        batEstimatedHours,
      estimatedHoursToFull:  batEstimatedHoursToFull,
    };
  });

  // ── SOC at sunrise ────────────────────────────────────────────────────────
  let estimatedSocAtSunrise = null;
  if (sunriseAt != null && totalCapacityKwh > 0) {
    const hoursToSunrise = Math.max(0, (new Date(sunriseAt).getTime() - Date.now()) / 3_600_000);
    const minKwh = totalCapacityKwh * (minSocPct / 100);
    const remaining = Math.max(minKwh, totalRemainingKwh - dischargeRateKw * hoursToSunrise);
    estimatedSocAtSunrise = clamp(minSocPct, Math.round((remaining / totalCapacityKwh) * 100), 100);
  }

  return {
    totalRemainingKwh:    Math.round(totalRemainingKwh * 10) / 10,
    dischargeRateKw:      Math.round(dischargeRateKw * 10) / 10,
    estimatedHours,
    estimatedHoursToFull,
    estimatedSocAtSunrise,
    perBattery,
  };
}

module.exports = {
  computeHealth,
  computeAutonomy,
  HEALTH_CELL_DELTA_WARN,
  HEALTH_CELL_DELTA_CRIT,
  HEALTH_TEMP_WARN,
  HEALTH_TEMP_CRIT,
  HEALTH_OUTLIER_MV,
  HEALTH_SOH_WARN,
  OUTLIER_SNAP_WINDOW,
  CRATE_SNAP_WINDOW,
  NOMINAL_VOLTAGE_V,
  MIN_POWER_FOR_CRATE_W,
  DISCHARGE_DELTA_MAX_MV,
  DISCHARGE_DELTA_MIN_SNAPS,
  MIN_ACTIVE_DISCHARGE_W,
  MIN_ACTIVE_CHARGE_W,
  MIN_ACTIVE_BAT_W,
  MIN_DISCHARGE_RATE_KW,
  MAX_DISCHARGE_RATE_KW,
};
