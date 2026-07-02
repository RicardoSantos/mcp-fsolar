"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.nullableInt = nullableInt;
exports.nullableFloat = nullableFloat;
exports.clamp = clamp;
exports.sleep = sleep;
exports.pickSnapshotFields = pickSnapshotFields;
exports.pickNextSunrise = pickNextSunrise;
function nullableInt(v) {
    return v != null ? parseInt(String(v), 10) : null;
}
function nullableFloat(v) {
    return v != null ? parseFloat(String(v)) : null;
}
function clamp(min, val, max) {
    return Math.max(min, Math.min(max, val));
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
function pickSnapshotFields(b) {
    return {
        sn: b.sn,
        alias: b.alias,
        soc: b.soc,
        soh: b.soh,
        power: b.power,
        cellDelta: b.cellDelta,
        cellMin: b.cellVoltageMin,
        cellMax: b.cellVoltageMax,
        maxCellNum: b.maxCellNum,
        minCellNum: b.minCellNum,
        isBalancing: b.isBalancing,
        voltages: b.cellVoltages,
        temps: b.cellTemps,
        tempMax: b.tempMax,
        tempMin: b.tempMin,
        warningCount: b.warningCount,
        batCycleIndex: b.batCycleIndex,
    };
}
function pickNextSunrise(sunrise, sunriseTomorrow, now = Date.now()) {
    if (sunrise && now < new Date(sunrise).getTime())
        return sunrise;
    return sunriseTomorrow ?? null;
}
