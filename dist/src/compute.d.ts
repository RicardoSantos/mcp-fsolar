import { HealthStatus } from "./enums";
import type { Battery } from "./battery";
import type { BatterySnapshot } from "./store";
export declare const HEALTH_CELL_DELTA_WARN = 120;
export declare const HEALTH_CELL_DELTA_CRIT = 200;
export declare const HEALTH_TEMP_WARN = 40;
export declare const HEALTH_TEMP_CRIT = 50;
export declare const HEALTH_OUTLIER_MV = 35;
export declare const HEALTH_SOH_WARN = 90;
export declare const OUTLIER_SNAP_WINDOW = 3;
export declare const CRATE_SNAP_WINDOW = 6;
export declare const NOMINAL_VOLTAGE_V = 48;
export declare const MIN_POWER_FOR_CRATE_W = 50;
export declare const DISCHARGE_DELTA_MAX_MV = 30;
export declare const DISCHARGE_DELTA_MIN_SNAPS = 3;
export declare const MIN_ACTIVE_DISCHARGE_W = 100;
export declare const MIN_ACTIVE_CHARGE_W = 50;
export declare const MIN_ACTIVE_BAT_W = 50;
export declare const MIN_DISCHARGE_RATE_KW = 0.2;
export declare const MAX_DISCHARGE_RATE_KW = 24;
export interface BatteryHealth {
    alias: string;
    cellDeltaStatus: HealthStatus | null;
    cellDelta: number | null;
    dischargeDelta: number | null;
    tempStatus: HealthStatus | null;
    tempMax: number | null;
    sohStatus: Exclude<HealthStatus, "crit"> | null;
    soh: number | null;
    outliers: number[];
    avgCRate: number | null;
}
export interface AutonomyPerBattery {
    sn: string;
    alias: string;
    remainingKwh: number;
    estimatedHours: number;
    estimatedHoursToFull: number | null;
}
export interface AutonomyResult {
    totalRemainingKwh: number;
    totalCapacityKwh: number;
    dischargeRateKw: number;
    estimatedHours: number;
    estimatedHoursToFull: number | null;
    estimatedSocAtSunrise: number | null;
    hoursToSunrise: number | null;
    estimatedDischargeKwh: number | null;
    estimatedRemainingKwh: number | null;
    perBattery: AutonomyPerBattery[];
}
export interface AutonomyOptions {
    sunriseAt?: string | Date | null;
    packCapacityKwh?: number | null;
    minSocPct?: number;
    defaultDischargeKw?: number;
}
export declare function computeHealth(batteries: Battery[], snapshots: BatterySnapshot[]): Record<string, BatteryHealth>;
export declare function computeAutonomy(batteries: Battery[], snapshots: BatterySnapshot[], opts?: AutonomyOptions): AutonomyResult;
