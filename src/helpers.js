"use strict";

function nullableInt(v)   { return v != null ? parseInt(v, 10) : null; }
function nullableFloat(v) { return v != null ? parseFloat(v)  : null; }
function clamp(min, val, max) { return Math.max(min, Math.min(max, val)); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function pickSnapshotFields(b) {
  return {
    sn:            b.sn,
    alias:         b.alias,
    soc:           b.soc,
    soh:           b.soh,
    power:         b.power,
    cellDelta:     b.cellDelta,
    cellMin:       b.cellVoltageMin,
    cellMax:       b.cellVoltageMax,
    maxCellNum:    b.maxCellNum,
    minCellNum:    b.minCellNum,
    isBalancing:   b.isBalancing,
    voltages:      b.cellVoltages,
    temps:         b.cellTemps,
    tempMax:       b.tempMax,
    tempMin:       b.tempMin,
    warningCount:  b.warningCount,
    batCycleIndex: b.batCycleIndex,
  };
}

module.exports = { nullableInt, nullableFloat, clamp, sleep, pickSnapshotFields };
