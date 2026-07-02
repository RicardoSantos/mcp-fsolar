"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_DISCHARGE_RATE_KW = exports.MIN_DISCHARGE_RATE_KW = exports.MIN_ACTIVE_BAT_W = exports.MIN_ACTIVE_CHARGE_W = exports.MIN_ACTIVE_DISCHARGE_W = exports.DISCHARGE_DELTA_MIN_SNAPS = exports.DISCHARGE_DELTA_MAX_MV = exports.MIN_POWER_FOR_CRATE_W = exports.NOMINAL_VOLTAGE_V = exports.CRATE_SNAP_WINDOW = exports.OUTLIER_SNAP_WINDOW = exports.HEALTH_SOH_WARN = exports.HEALTH_OUTLIER_MV = exports.HEALTH_TEMP_CRIT = exports.HEALTH_TEMP_WARN = exports.HEALTH_CELL_DELTA_CRIT = exports.HEALTH_CELL_DELTA_WARN = void 0;
exports.computeHealth = computeHealth;
exports.computeAutonomy = computeAutonomy;
const helpers_1 = require("./helpers");
const enums_1 = require("./enums");
// ── Health thresholds ─────────────────────────────────────────────────────────
exports.HEALTH_CELL_DELTA_WARN = 120;
exports.HEALTH_CELL_DELTA_CRIT = 200;
exports.HEALTH_TEMP_WARN = 40;
exports.HEALTH_TEMP_CRIT = 50;
exports.HEALTH_OUTLIER_MV = 35;
exports.HEALTH_SOH_WARN = 90;
// ── computeHealth tuning ──────────────────────────────────────────────────────
exports.OUTLIER_SNAP_WINDOW = 3;
exports.CRATE_SNAP_WINDOW = 6;
exports.NOMINAL_VOLTAGE_V = 48;
exports.MIN_POWER_FOR_CRATE_W = 50;
exports.DISCHARGE_DELTA_MAX_MV = 30;
exports.DISCHARGE_DELTA_MIN_SNAPS = 3;
// ── computeAutonomy tuning ────────────────────────────────────────────────────
exports.MIN_ACTIVE_DISCHARGE_W = 100;
exports.MIN_ACTIVE_CHARGE_W = 50;
exports.MIN_ACTIVE_BAT_W = 50;
exports.MIN_DISCHARGE_RATE_KW = 0.2;
exports.MAX_DISCHARGE_RATE_KW = 24;
function computeHealth(batteries, snapshots) {
    const snapsBySn = new Map();
    for (const snap of snapshots) {
        for (const b of snap.batteries) {
            if (!snapsBySn.has(b.sn))
                snapsBySn.set(b.sn, []);
            snapsBySn.get(b.sn).push(b);
        }
    }
    const result = {};
    for (const bat of batteries) {
        const cellDeltaStatus = bat.cellDelta == null ? null
            : bat.cellDelta >= exports.HEALTH_CELL_DELTA_CRIT ? enums_1.HealthStatus.CRIT
                : bat.cellDelta >= exports.HEALTH_CELL_DELTA_WARN ? enums_1.HealthStatus.WARN
                    : enums_1.HealthStatus.OK;
        const tempStatus = bat.tempMax == null ? null
            : bat.tempMax >= exports.HEALTH_TEMP_CRIT ? enums_1.HealthStatus.CRIT
                : bat.tempMax >= exports.HEALTH_TEMP_WARN ? enums_1.HealthStatus.WARN
                    : enums_1.HealthStatus.OK;
        const sohStatus = bat.soh == null ? null : bat.soh < exports.HEALTH_SOH_WARN ? enums_1.HealthStatus.WARN : enums_1.HealthStatus.OK;
        const batSnaps = snapsBySn.get(bat.sn) ?? [];
        let outliers = [];
        const batLastN = batSnaps.slice(-exports.OUTLIER_SNAP_WINDOW);
        if (batLastN.length >= exports.OUTLIER_SNAP_WINDOW && bat.cellVoltages?.length > 0) {
            const avg = bat.cellVoltages.reduce((s, v) => s + v, 0) / bat.cellVoltages.length;
            outliers = bat.cellVoltages
                .map((v, i) => ({ cell: i + 1, dev: v - avg }))
                .filter((c) => c.dev < -exports.HEALTH_OUTLIER_MV)
                .filter((o) => batLastN.every((b) => {
                if (!b?.voltages?.length || (b.power ?? 0) >= 0)
                    return false;
                const a = b.voltages.reduce((s, v) => s + v, 0) / b.voltages.length;
                return (b.voltages[o.cell - 1] ?? a) - a < -exports.HEALTH_OUTLIER_MV;
            }))
                .map((o) => o.cell);
        }
        const batRecentSnaps = batSnaps.slice(-exports.CRATE_SNAP_WINDOW);
        const ratedW = (bat.capacityAh ?? 0) * (bat.voltage ?? exports.NOMINAL_VOLTAGE_V);
        const cRates = batRecentSnaps.flatMap((b) => {
            if (!b || Math.abs(b.power ?? 0) < exports.MIN_POWER_FOR_CRATE_W || ratedW <= 0)
                return [];
            return [Math.abs(b.power) / ratedW];
        });
        const avgCRate = cRates.length
            ? Math.round(cRates.reduce((s, v) => s + v, 0) / cRates.length * 100) / 100
            : null;
        const dischargeDeltaSamples = batSnaps
            .filter((b) => (b.power ?? 0) < 0 && b.cellDelta != null && b.cellDelta < exports.DISCHARGE_DELTA_MAX_MV)
            .map((b) => b.cellDelta);
        let dischargeDelta = null;
        if (dischargeDeltaSamples.length >= exports.DISCHARGE_DELTA_MIN_SNAPS) {
            const sorted = [...dischargeDeltaSamples].sort((a, b) => a - b);
            dischargeDelta = sorted[Math.floor(sorted.length / 2)];
        }
        result[bat.sn] = {
            alias: bat.alias,
            cellDeltaStatus,
            cellDelta: bat.cellDelta ?? null,
            tempStatus,
            tempMax: bat.tempMax ?? null,
            sohStatus,
            soh: bat.soh ?? null,
            outliers,
            avgCRate,
            dischargeDelta,
        };
    }
    return result;
}
const snapDischargeW = (snap) => snap.batteries.reduce((s, b) => s + Math.abs(Math.min(0, b.power ?? 0)), 0);
function computeAutonomy(batteries, snapshots, opts = {}) {
    const { sunriseAt = null, packCapacityKwh = null, minSocPct = 5, defaultDischargeKw = 1.5 } = opts;
    const totalRemainingKwh = batteries.reduce((s, b) => s + b.remainingKwh, 0);
    const totalPowerW = batteries.reduce((s, b) => s + (b.power ?? 0), 0);
    let dischargeRateKw;
    if (totalPowerW < -exports.MIN_ACTIVE_DISCHARGE_W) {
        dischargeRateKw = -totalPowerW / 1000;
    }
    else {
        const nightSnaps = snapshots.filter((s) => s.batteries.some((b) => (b.power ?? 0) < -exports.MIN_ACTIVE_DISCHARGE_W));
        const avgW = nightSnaps.length
            ? nightSnaps.reduce((acc, s) => acc + snapDischargeW(s), 0) / nightSnaps.length
            : 0;
        dischargeRateKw = avgW > exports.MIN_ACTIVE_DISCHARGE_W ? avgW / 1000 : defaultDischargeKw;
    }
    dischargeRateKw = (0, helpers_1.clamp)(exports.MIN_DISCHARGE_RATE_KW, dischargeRateKw, exports.MAX_DISCHARGE_RATE_KW);
    const totalCapacityKwh = packCapacityKwh
        ?? batteries.reduce((s, b) => s + (b.ratedEnergyKwh ?? (b.soc > 0 ? b.remainingKwh / (b.soc / 100) : 0)), 0);
    const perBatCapacityKwh = packCapacityKwh != null ? packCapacityKwh / batteries.length : null;
    const fleetMinKwh = totalCapacityKwh * (minSocPct / 100);
    const fleetUsableKwh = Math.max(0, totalRemainingKwh - fleetMinKwh);
    const estimatedHours = Math.round(fleetUsableKwh / dischargeRateKw * 10) / 10;
    let estimatedHoursToFull = null;
    const avgSoc = batteries.reduce((s, b) => s + b.soc, 0) / batteries.length;
    if (totalPowerW > exports.MIN_ACTIVE_CHARGE_W && avgSoc < 100 && totalCapacityKwh > 0) {
        const remainingToFull = totalCapacityKwh * (1 - avgSoc / 100);
        estimatedHoursToFull = Math.round(remainingToFull / (totalPowerW / 1000) * 10) / 10;
    }
    const perBattery = batteries.map((bat) => {
        const batCapacityKwh = bat.ratedEnergyKwh
            ?? perBatCapacityKwh
            ?? (bat.soc > 0 ? bat.remainingKwh / (bat.soc / 100) : 0);
        const batMinKwh = batCapacityKwh * (minSocPct / 100);
        const batUsableKwh = Math.max(0, bat.remainingKwh - batMinKwh);
        const batDischargeKw = (bat.power ?? 0) < -exports.MIN_ACTIVE_BAT_W
            ? Math.abs(bat.power) / 1000
            : dischargeRateKw / batteries.length;
        const batEstimatedHours = Math.round(batUsableKwh / batDischargeKw * 10) / 10;
        let batEstimatedHoursToFull = null;
        if ((bat.power ?? 0) > exports.MIN_ACTIVE_BAT_W && bat.soc < 100 && batCapacityKwh > 0) {
            const toFull = batCapacityKwh * (1 - bat.soc / 100);
            batEstimatedHoursToFull = Math.round(toFull / (bat.power / 1000) * 10) / 10;
        }
        return {
            sn: bat.sn,
            alias: bat.alias,
            remainingKwh: Math.round(bat.remainingKwh * 10) / 10,
            estimatedHours: batEstimatedHours,
            estimatedHoursToFull: batEstimatedHoursToFull,
        };
    });
    let estimatedSocAtSunrise = null;
    let hoursToSunrise = null;
    let estimatedDischargeKwh = null;
    let estimatedRemainingKwh = null;
    if (sunriseAt != null && totalCapacityKwh > 0) {
        hoursToSunrise = Math.max(0, (new Date(sunriseAt).getTime() - Date.now()) / 3600000);
        const minKwh = totalCapacityKwh * (minSocPct / 100);
        const remaining = Math.max(minKwh, totalRemainingKwh - dischargeRateKw * hoursToSunrise);
        estimatedSocAtSunrise = (0, helpers_1.clamp)(minSocPct, Math.round((remaining / totalCapacityKwh) * 100), 100);
        estimatedDischargeKwh = Math.round(dischargeRateKw * hoursToSunrise * 10) / 10;
        estimatedRemainingKwh = Math.round(remaining * 10) / 10;
    }
    return {
        totalRemainingKwh: Math.round(totalRemainingKwh * 10) / 10,
        totalCapacityKwh: Math.round(totalCapacityKwh * 10) / 10,
        dischargeRateKw: Math.round(dischargeRateKw * 10) / 10,
        estimatedHours,
        estimatedHoursToFull,
        estimatedSocAtSunrise,
        hoursToSunrise: hoursToSunrise != null ? Math.round(hoursToSunrise * 10) / 10 : null,
        estimatedDischargeKwh,
        estimatedRemainingKwh,
        perBattery,
    };
}
