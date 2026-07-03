import { TrendDirection }                                          from "./enums";
import { HEALTH_CELL_DELTA_CRIT, HEALTH_CELL_DELTA_WARN,
         HEALTH_TEMP_CRIT, HEALTH_TEMP_WARN, HEALTH_SOH_WARN,
         ALERT_STALE_MIN,
         MAX_SNAPSHOT_GAP_H, CELL_TREND_STABLE_MV, POWER_IDLE_KW } from "./constants";
import { CELLS_PER_MODULE }                                       from "./battery";
import type { BatterySnapshot }                                from "./store";
import type { Battery }                                        from "./battery";
import type { BatteryHealth }                                  from "./compute";
import type { SnapshotEntry }                                  from "./helpers";

// ── Alert ─────────────────────────────────────────────────────────────────────

export const AlertSeverity = Object.freeze({
  CRIT: "crit",
  WARN: "warn",
  INFO: "info",
} as const);
export type AlertSeverity = typeof AlertSeverity[keyof typeof AlertSeverity];

export interface Alert {
  severity: AlertSeverity;
  battery:  string;
  code:     string;
  message:  string;
}

const _alertRank = (s: AlertSeverity): number =>
  s === AlertSeverity.CRIT ? 0 : s === AlertSeverity.WARN ? 1 : 2;

export function computeAlerts(
  batteries: Battery[],
  health:    Record<string, BatteryHealth>,
): Alert[] {
  const alerts: Alert[] = [];

  for (const bat of batteries) {
    const h = health[bat.sn];

    if (bat.cellDelta != null) {
      if (bat.cellDelta >= HEALTH_CELL_DELTA_CRIT) {
        alerts.push({ severity: AlertSeverity.CRIT, battery: bat.alias, code: "cell_delta_crit",
          message: `Cell imbalance critical: ${bat.cellDelta} mV (≥${HEALTH_CELL_DELTA_CRIT} mV)` });
      } else if (bat.cellDelta >= HEALTH_CELL_DELTA_WARN) {
        alerts.push({ severity: AlertSeverity.WARN, battery: bat.alias, code: "cell_delta_warn",
          message: `Cell imbalance warning: ${bat.cellDelta} mV (≥${HEALTH_CELL_DELTA_WARN} mV)` });
      }
    }

    if (bat.tempMax >= HEALTH_TEMP_CRIT) {
      alerts.push({ severity: AlertSeverity.CRIT, battery: bat.alias, code: "temp_crit",
        message: `Temperature critical: ${bat.tempMax} °C (≥${HEALTH_TEMP_CRIT} °C)` });
    } else if (bat.tempMax >= HEALTH_TEMP_WARN) {
      alerts.push({ severity: AlertSeverity.WARN, battery: bat.alias, code: "temp_warn",
        message: `Temperature warning: ${bat.tempMax} °C (≥${HEALTH_TEMP_WARN} °C)` });
    }

    if (bat.soh < HEALTH_SOH_WARN) {
      alerts.push({ severity: AlertSeverity.WARN, battery: bat.alias, code: "soh_warn",
        message: `SOH warning: ${bat.soh}% (below ${HEALTH_SOH_WARN}%)` });
    }

    if (h?.outliers?.length) {
      alerts.push({ severity: AlertSeverity.WARN, battery: bat.alias, code: "outlier_cells",
        message: `Persistently weak cell${h.outliers.length > 1 ? "s" : ""}: ${h.outliers.map((c) => `#${c}`).join(", ")}` });
    }

    if (bat.warningCount > 0) {
      alerts.push({ severity: AlertSeverity.WARN, battery: bat.alias, code: "bms_warnings",
        message: `BMS active warnings: ${bat.warningCount}` });
    }

    if (bat.batUnderVoltageCount != null && bat.batUnderVoltageCount > 0) {
      alerts.push({ severity: AlertSeverity.INFO, battery: bat.alias, code: "undervoltage_events",
        message: `Cumulative under-voltage events: ${bat.batUnderVoltageCount}` });
    }

    if (bat.dataTime) {
      const staleMin = (Date.now() - new Date(bat.dataTime.replace(" ", "T")).getTime()) / 60_000;
      if (staleMin > ALERT_STALE_MIN) {
        alerts.push({ severity: AlertSeverity.WARN, battery: bat.alias, code: "stale_data",
          message: `Last BMS report: ${Math.round(staleMin)} min ago` });
      }
    }
  }

  return alerts.sort((a, b) => _alertRank(a.severity) - _alertRank(b.severity));
}

// ── Energy history ────────────────────────────────────────────────────────────

export interface EnergyDay {
  date:            string;
  kwhCharged:      number;
  kwhDischarged:   number;
  kwhNet:          number;
  peakChargeKw:    number;
  peakDischargeKw: number;
  snapshotCount:   number;
}

export function computeEnergyHistory(snapshots: BatterySnapshot[]): EnergyDay[] {
  if (snapshots.length < 2) return [];

  const dayMap = new Map<string, {
    charged: number; discharged: number;
    peakCharge: number; peakDischarge: number; count: number;
  }>();

  for (let i = 1; i < snapshots.length; i++) {
    const prev = snapshots[i - 1];
    const curr = snapshots[i];
    const dtH  = (new Date(curr.ts).getTime() - new Date(prev.ts).getTime()) / 3_600_000;
    if (dtH <= 0 || dtH > MAX_SNAPSHOT_GAP_H) continue;

    const date        = curr.ts.slice(0, 10);
    const totalPowerW = curr.batteries.reduce((s, b) => s + b.power, 0);
    const energyKwh   = (totalPowerW / 1000) * dtH;

    if (!dayMap.has(date)) dayMap.set(date, { charged: 0, discharged: 0, peakCharge: 0, peakDischarge: 0, count: 0 });
    const day = dayMap.get(date)!;
    day.count++;

    if (energyKwh > 0) {
      day.charged    += energyKwh;
      day.peakCharge  = Math.max(day.peakCharge, totalPowerW / 1000);
    } else if (energyKwh < 0) {
      day.discharged    += Math.abs(energyKwh);
      day.peakDischarge  = Math.max(day.peakDischarge, Math.abs(totalPowerW) / 1000);
    }
  }

  return [...dayMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, d]) => ({
      date,
      kwhCharged:      Math.round(d.charged    * 100) / 100,
      kwhDischarged:   Math.round(d.discharged * 100) / 100,
      kwhNet:          Math.round((d.charged - d.discharged) * 100) / 100,
      peakChargeKw:    Math.round(d.peakCharge    * 10) / 10,
      peakDischargeKw: Math.round(d.peakDischarge * 10) / 10,
      snapshotCount:   d.count,
    }));
}

export function mergeEnergyHistory(persisted: EnergyDay[], live: EnergyDay[]): EnergyDay[] {
  return [...new Map([...persisted, ...live].map((e) => [e.date, e])).values()]
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ── Cell stats ────────────────────────────────────────────────────────────────

export interface CellStat {
  cell:          number;
  module:        number;
  mean:          number;
  stddev:        number;
  min:           number;
  max:           number;
  meanDeviation: number;
  trend:         TrendDirection;
}

export function computeCellStats(snapshots: BatterySnapshot[], sn: string): CellStat[] {
  const batSnaps = snapshots
    .map((s) => s.batteries.find((b) => b.sn === sn))
    .filter((b): b is SnapshotEntry => b != null && b.voltages.length > 0);

  if (batSnaps.length < 2) return [];

  const numCells = batSnaps[0].voltages.length;
  const result: CellStat[] = [];

  for (let c = 0; c < numCells; c++) {
    const readings = batSnaps.map((s) => s.voltages[c]).filter((v) => !isNaN(v));
    if (!readings.length) continue;

    const mean   = readings.reduce((s, v) => s + v, 0) / readings.length;
    const stddev = Math.sqrt(readings.reduce((s, v) => s + (v - mean) ** 2, 0) / readings.length);

    const packMeans  = batSnaps.map((s) => s.voltages.reduce((a, v) => a + v, 0) / s.voltages.length);
    const deviations = batSnaps.map((s, i) => s.voltages[c] - packMeans[i]);
    const meanDev    = deviations.reduce((s, v) => s + v, 0) / deviations.length;

    const half      = Math.floor(deviations.length / 2);
    const avg       = (arr: number[]): number => arr.reduce((s, v) => s + v, 0) / arr.length;
    const firstDev  = half > 0 ? avg(deviations.slice(0, half))  : 0;
    const secondDev = half > 0 ? avg(deviations.slice(-half))     : 0;
    const devChange = secondDev - firstDev;

    const trend: TrendDirection = Math.abs(devChange) < CELL_TREND_STABLE_MV
      ? TrendDirection.STABLE
      : (meanDev < 0 ? devChange > 0 : devChange < 0)
        ? TrendDirection.IMPROVING
        : TrendDirection.DEGRADING;

    result.push({
      cell:          c + 1,
      module:        Math.ceil((c + 1) / CELLS_PER_MODULE),
      mean:          Math.round(mean),
      stddev:        Math.round(stddev * 10) / 10,
      min:           Math.min(...readings),
      max:           Math.max(...readings),
      meanDeviation: Math.round(meanDev * 10) / 10,
      trend,
    });
  }

  return result;
}

// ── Power stats ───────────────────────────────────────────────────────────────

export interface PowerStats {
  peakChargeKw:     number;
  peakDischargeKw:  number;
  avgChargeKw:      number;
  avgDischargeKw:   number;
  avgCRate:         number | null;
  pctAboveHalfC:    number | null;
  totalSamples:     number;
  chargeSamples:    number;
  dischargeSamples: number;
}

export function computePowerStats(snapshots: BatterySnapshot[], batteries: Battery[]): PowerStats {
  const ratedKwh = batteries.reduce((s, b) => s + (b.ratedEnergyKwh ?? 0), 0);

  let peakCharge     = 0;
  let peakDischarge  = 0;
  let sumCharge      = 0;
  let sumDischarge   = 0;
  let chargeCount    = 0;
  let dischargeCount = 0;
  let aboveHalfC     = 0;

  for (const snap of snapshots) {
    const kw = snap.batteries.reduce((s, b) => s + b.power, 0) / 1000;
    if (kw > POWER_IDLE_KW) {
      peakCharge = Math.max(peakCharge, kw);
      sumCharge += kw;
      chargeCount++;
    } else if (kw < -POWER_IDLE_KW) {
      const abs = Math.abs(kw);
      peakDischarge = Math.max(peakDischarge, abs);
      sumDischarge += abs;
      dischargeCount++;
      if (ratedKwh > 0 && abs / ratedKwh > 0.5) aboveHalfC++;
    }
  }

  return {
    peakChargeKw:     Math.round(peakCharge    * 10) / 10,
    peakDischargeKw:  Math.round(peakDischarge * 10) / 10,
    avgChargeKw:      chargeCount    > 0 ? Math.round(sumCharge    / chargeCount    * 10) / 10 : 0,
    avgDischargeKw:   dischargeCount > 0 ? Math.round(sumDischarge / dischargeCount * 10) / 10 : 0,
    avgCRate:         ratedKwh > 0 && dischargeCount > 0
                        ? Math.round(sumDischarge / dischargeCount / ratedKwh * 100) / 100
                        : null,
    pctAboveHalfC:    ratedKwh > 0 && dischargeCount > 0
                        ? Math.round(aboveHalfC / dischargeCount * 100)
                        : null,
    totalSamples:     snapshots.length,
    chargeSamples:    chargeCount,
    dischargeSamples: dischargeCount,
  };
}
