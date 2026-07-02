import { clamp }        from "./helpers";
import { HealthStatus } from "./enums";
import type { Battery } from "./battery";
import type { BatterySnapshot } from "./store";
import {
  HEALTH_CELL_DELTA_WARN, HEALTH_CELL_DELTA_CRIT,
  HEALTH_TEMP_WARN, HEALTH_TEMP_CRIT,
  HEALTH_OUTLIER_MV, HEALTH_SOH_WARN,
  OUTLIER_SNAP_WINDOW, CRATE_SNAP_WINDOW,
  NOMINAL_VOLTAGE_V, MIN_POWER_FOR_CRATE_W,
  DISCHARGE_DELTA_MAX_MV, DISCHARGE_DELTA_MIN_SNAPS,
  MIN_ACTIVE_DISCHARGE_W, MIN_ACTIVE_CHARGE_W, MIN_ACTIVE_BAT_W,
  MIN_DISCHARGE_RATE_KW, MAX_DISCHARGE_RATE_KW,
} from "./constants";

// Re-export constants used by tests that import from this module (legacy import path)
export {
  HEALTH_CELL_DELTA_WARN, HEALTH_CELL_DELTA_CRIT,
  HEALTH_TEMP_WARN, HEALTH_TEMP_CRIT,
  HEALTH_OUTLIER_MV, HEALTH_SOH_WARN,
  OUTLIER_SNAP_WINDOW, DISCHARGE_DELTA_MIN_SNAPS,
  MIN_DISCHARGE_RATE_KW, MAX_DISCHARGE_RATE_KW,
};

export interface BatteryHealth {
  alias:           string;
  cellDeltaStatus: HealthStatus | null;
  cellDelta:       number | null;
  dischargeDelta:  number | null;
  tempStatus:      HealthStatus | null;
  tempMax:         number | null;
  sohStatus:       Exclude<HealthStatus, "crit"> | null;
  soh:             number | null;
  outliers:        number[];
  avgCRate:        number | null;
}

export interface AutonomyPerBattery {
  sn:                   string;
  alias:                string;
  remainingKwh:         number;
  estimatedHours:       number;
  estimatedHoursToFull: number | null;
}

export interface AutonomyResult {
  totalRemainingKwh:     number;
  totalCapacityKwh:      number;
  dischargeRateKw:       number;
  estimatedHours:        number;
  estimatedHoursToFull:  number | null;
  estimatedSocAtSunrise: number | null;
  hoursToSunrise:        number | null;
  estimatedDischargeKwh: number | null;
  estimatedRemainingKwh: number | null;
  perBattery:            AutonomyPerBattery[];
}

export interface AutonomyOptions {
  sunriseAt?:          string | Date | null;
  packCapacityKwh?:    number | null;
  minSocPct?:          number;
  defaultDischargeKw?: number;
}

export function computeHealth(batteries: Battery[], snapshots: BatterySnapshot[]): Record<string, BatteryHealth> {
  const snapsBySn = new Map<string, BatterySnapshot["batteries"][number][]>();
  for (const snap of snapshots) {
    for (const b of snap.batteries) {
      if (!snapsBySn.has(b.sn)) snapsBySn.set(b.sn, []);
      snapsBySn.get(b.sn)!.push(b);
    }
  }

  const result: Record<string, BatteryHealth> = {};

  for (const bat of batteries) {
    const cellDeltaStatus: HealthStatus | null = bat.cellDelta == null ? null
      : bat.cellDelta >= HEALTH_CELL_DELTA_CRIT ? HealthStatus.CRIT
      : bat.cellDelta >= HEALTH_CELL_DELTA_WARN ? HealthStatus.WARN
      : HealthStatus.OK;

    const tempStatus: HealthStatus | null = bat.tempMax == null ? null
      : bat.tempMax >= HEALTH_TEMP_CRIT ? HealthStatus.CRIT
      : bat.tempMax >= HEALTH_TEMP_WARN ? HealthStatus.WARN
      : HealthStatus.OK;

    const sohStatus: Exclude<HealthStatus, "crit"> | null =
      bat.soh == null ? null : bat.soh < HEALTH_SOH_WARN ? HealthStatus.WARN : HealthStatus.OK;

    const batSnaps = snapsBySn.get(bat.sn) ?? [];

    let outliers: number[] = [];
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

    const batRecentSnaps = batSnaps.slice(-CRATE_SNAP_WINDOW);
    const ratedW = (bat.capacityAh ?? 0) * (bat.voltage ?? NOMINAL_VOLTAGE_V);
    const cRates = batRecentSnaps.flatMap((b) => {
      if (!b || Math.abs(b.power ?? 0) < MIN_POWER_FOR_CRATE_W || ratedW <= 0) return [];
      return [Math.abs(b.power) / ratedW];
    });
    const avgCRate = cRates.length
      ? Math.round(cRates.reduce((s, v) => s + v, 0) / cRates.length * 100) / 100
      : null;

    const dischargeDeltaSamples = batSnaps
      .filter((b) => (b.power ?? 0) < 0 && b.cellDelta != null && b.cellDelta < DISCHARGE_DELTA_MAX_MV)
      .map((b) => b.cellDelta as number);
    let dischargeDelta: number | null = null;
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

const snapDischargeW = (snap: BatterySnapshot): number =>
  snap.batteries.reduce((s, b) => s + Math.abs(Math.min(0, b.power ?? 0)), 0);

export function computeAutonomy(batteries: Battery[], snapshots: BatterySnapshot[], opts: AutonomyOptions = {}): AutonomyResult {
  const { sunriseAt = null, packCapacityKwh = null, minSocPct = 5, defaultDischargeKw = 1.5 } = opts;

  const totalRemainingKwh = batteries.reduce((s, b) => s + b.remainingKwh, 0);
  const totalPowerW       = batteries.reduce((s, b) => s + (b.power ?? 0), 0);

  let dischargeRateKw: number;
  if (totalPowerW < -MIN_ACTIVE_DISCHARGE_W) {
    dischargeRateKw = -totalPowerW / 1000;
  } else {
    const nightSnaps = snapshots.filter((s) => s.batteries.some((b) => (b.power ?? 0) < -MIN_ACTIVE_DISCHARGE_W));
    const avgW = nightSnaps.length
      ? nightSnaps.reduce((acc, s) => acc + snapDischargeW(s), 0) / nightSnaps.length
      : 0;
    dischargeRateKw = avgW > MIN_ACTIVE_DISCHARGE_W ? avgW / 1000 : defaultDischargeKw;
  }
  dischargeRateKw = clamp(MIN_DISCHARGE_RATE_KW, dischargeRateKw, MAX_DISCHARGE_RATE_KW);

  const totalCapacityKwh  = packCapacityKwh
    ?? batteries.reduce((s, b) => s + (b.ratedEnergyKwh ?? (b.soc > 0 ? b.remainingKwh / (b.soc / 100) : 0)), 0);
  const perBatCapacityKwh = packCapacityKwh != null ? packCapacityKwh / batteries.length : null;

  const fleetMinKwh    = totalCapacityKwh * (minSocPct / 100);
  const fleetUsableKwh = Math.max(0, totalRemainingKwh - fleetMinKwh);
  const estimatedHours = Math.round(fleetUsableKwh / dischargeRateKw * 10) / 10;

  let estimatedHoursToFull: number | null = null;
  const avgSoc = batteries.reduce((s, b) => s + b.soc, 0) / batteries.length;
  if (totalPowerW > MIN_ACTIVE_CHARGE_W && avgSoc < 100 && totalCapacityKwh > 0) {
    const remainingToFull = totalCapacityKwh * (1 - avgSoc / 100);
    estimatedHoursToFull = Math.round(remainingToFull / (totalPowerW / 1000) * 10) / 10;
  }

  const perBattery: AutonomyPerBattery[] = batteries.map((bat) => {
    const batCapacityKwh = bat.ratedEnergyKwh
      ?? perBatCapacityKwh
      ?? (bat.soc > 0 ? bat.remainingKwh / (bat.soc / 100) : 0);
    const batMinKwh      = batCapacityKwh * (minSocPct / 100);
    const batUsableKwh   = Math.max(0, bat.remainingKwh - batMinKwh);
    const batDischargeKw = (bat.power ?? 0) < -MIN_ACTIVE_BAT_W
      ? Math.abs(bat.power) / 1000
      : dischargeRateKw / batteries.length;
    const batEstimatedHours = Math.round(batUsableKwh / batDischargeKw * 10) / 10;

    let batEstimatedHoursToFull: number | null = null;
    if ((bat.power ?? 0) > MIN_ACTIVE_BAT_W && bat.soc < 100 && batCapacityKwh > 0) {
      const toFull = batCapacityKwh * (1 - bat.soc / 100);
      batEstimatedHoursToFull = Math.round(toFull / (bat.power / 1000) * 10) / 10;
    }

    return {
      sn:                   bat.sn,
      alias:                bat.alias,
      remainingKwh:         Math.round(bat.remainingKwh * 10) / 10,
      estimatedHours:       batEstimatedHours,
      estimatedHoursToFull: batEstimatedHoursToFull,
    };
  });

  let estimatedSocAtSunrise: number | null  = null;
  let hoursToSunrise:        number | null  = null;
  let estimatedDischargeKwh: number | null  = null;
  let estimatedRemainingKwh: number | null  = null;
  if (sunriseAt != null && totalCapacityKwh > 0) {
    hoursToSunrise = Math.max(0, (new Date(sunriseAt as string).getTime() - Date.now()) / 3_600_000);
    const minKwh   = totalCapacityKwh * (minSocPct / 100);
    const remaining = Math.max(minKwh, totalRemainingKwh - dischargeRateKw * hoursToSunrise);
    estimatedSocAtSunrise = clamp(minSocPct, Math.round((remaining / totalCapacityKwh) * 100), 100);
    estimatedDischargeKwh = Math.round(dischargeRateKw * hoursToSunrise * 10) / 10;
    estimatedRemainingKwh = Math.round(remaining * 10) / 10;
  }

  return {
    totalRemainingKwh:    Math.round(totalRemainingKwh * 10) / 10,
    totalCapacityKwh:     Math.round(totalCapacityKwh * 10) / 10,
    dischargeRateKw:      Math.round(dischargeRateKw * 10) / 10,
    estimatedHours,
    estimatedHoursToFull,
    estimatedSocAtSunrise,
    hoursToSunrise:       hoursToSunrise != null ? Math.round(hoursToSunrise * 10) / 10 : null,
    estimatedDischargeKwh,
    estimatedRemainingKwh,
    perBattery,
  };
}
