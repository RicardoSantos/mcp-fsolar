"use strict";

const { test } = require("node:test");
const assert   = require("node:assert/strict");
const { buildBattery } = require("../index.js");

const DEVICE = {
  deviceSn:    "TEST001",
  alias:       "Bat1",
  deviceModel: "MOD-A",
  status:      "NM",
  battSoc:     "0",
  bmsPower:    "0",
  battCapacity: "314",
  wifiSignal:  "-60",
};

const SNAP = {
  battSoc:          "80",
  battSoh:          "98",
  battVolt:         "51.2",
  battCurr:         "10",
  bmsPower:         "512",
  bmsChargingState: 1,
  tempMax:          "35",
  tempMin:          "30",
  cellTempList:     [30, 32, 34, 35],
  bmsVoltageList:   Array(16).fill("3200"),
  maxVoltageNum2bms: "1",
  minVoltageNum2bms: "16",
  bmsState:         "0",
  warningCount:     "0",
  batCycleIndex:    "150",
  batFullCount:     "50",
  batUnderVoltageCount: "2",
  remainingBatteryEnergy1: "10.24",
  dataTimeStr:      "2026-06-30 12:00:00",
  reportFreq:       "60",
  wifiSignal:       "-55",
};

test("basic scalar fields", () => {
  const b = buildBattery(DEVICE, SNAP);
  assert.equal(b.sn,    "TEST001");
  assert.equal(b.alias, "Bat1");
  assert.equal(b.model, "MOD-A");
  assert.equal(b.soc,   80);
  assert.equal(b.soh,   98);
  assert.equal(b.power, 512);
  assert.equal(b.voltage, 51.2);
  assert.equal(b.current, 10);
  assert.equal(b.warningCount, 0);
  assert.equal(b.batCycleIndex, 150);
  assert.equal(b.batFullCount, 50);
  assert.equal(b.batUnderVoltageCount, 2);
  assert.equal(b.dataTime, "2026-06-30 12:00:00");
});

test("chargingState: charging", () => {
  assert.equal(buildBattery(DEVICE, { ...SNAP, bmsChargingState: 1 }).chargingState, "charging");
});

test("chargingState: discharging", () => {
  assert.equal(buildBattery(DEVICE, { ...SNAP, bmsChargingState: 2 }).chargingState, "discharging");
});

test("chargingState: standby for any other value", () => {
  assert.equal(buildBattery(DEVICE, { ...SNAP, bmsChargingState: 0 }).chargingState, "standby");
  assert.equal(buildBattery(DEVICE, { ...SNAP, bmsChargingState: 99 }).chargingState, "standby");
});

test("cell voltages and delta", () => {
  const voltages = Array.from({ length: 16 }, (_, i) => String(3200 + i * 5));
  const b = buildBattery(DEVICE, { ...SNAP, bmsVoltageList: voltages });
  assert.equal(b.cellVoltages.length, 16);
  assert.equal(b.cellVoltageMin, 3200);
  assert.equal(b.cellVoltageMax, 3275);
  assert.equal(b.cellDelta, 75);
});

test("uniform cells give delta 0", () => {
  const b = buildBattery(DEVICE, { ...SNAP, bmsVoltageList: Array(16).fill("3300") });
  assert.equal(b.cellDelta, 0);
});

test("empty cell list gives null delta and min/max", () => {
  const b = buildBattery(DEVICE, { ...SNAP, bmsVoltageList: [] });
  assert.equal(b.cellDelta, null);
  assert.equal(b.cellVoltageMin, null);
  assert.equal(b.cellVoltageMax, null);
  assert.equal(b.modules.length, 0);
});

test("16 cells produce 4 modules of 4", () => {
  const b = buildBattery(DEVICE, SNAP);
  assert.equal(b.modules.length, 4);
  assert.equal(b.modules[0].index, 1);
  assert.equal(b.modules[0].cells.length, 4);
  assert.equal(b.modules[3].index, 4);
});

test("non-16 cell count produces no modules", () => {
  const b = buildBattery(DEVICE, { ...SNAP, bmsVoltageList: Array(8).fill("3200") });
  assert.equal(b.modules.length, 0);
});

test("sentinel temperature (>= 200) filtered out", () => {
  const b = buildBattery(DEVICE, { ...SNAP, cellTempList: [30, 35, 3276.7, 3276.7] });
  assert.equal(b.cellTemps.length, 2);
  assert.ok(b.cellTemps.every((t) => t < 200));
});

test("missing cellTempList gives empty array", () => {
  const b = buildBattery(DEVICE, { ...SNAP, cellTempList: null });
  assert.deepEqual(b.cellTemps, []);
});

test("isBalancing: bit 6 set (bmsState = 64)", () => {
  assert.equal(buildBattery(DEVICE, { ...SNAP, bmsState: "64" }).isBalancing, true);
});

test("isBalancing: bit 6 set among others (64 | 3 = 67)", () => {
  assert.equal(buildBattery(DEVICE, { ...SNAP, bmsState: "67" }).isBalancing, true);
});

test("isBalancing: false when bit 6 not set", () => {
  assert.equal(buildBattery(DEVICE, { ...SNAP, bmsState: "3" }).isBalancing, false);
});

test("isBalancing: false when bmsState is null", () => {
  assert.equal(buildBattery(DEVICE, { ...SNAP, bmsState: null }).isBalancing, false);
});

test("nullableInt: null for null input", () => {
  const b = buildBattery(DEVICE, { ...SNAP, batCycleIndex: null, batFullCount: undefined });
  assert.equal(b.batCycleIndex, null);
  assert.equal(b.batFullCount, null);
});

test("chargeVoltLimit: null when value is 0", () => {
  const b = buildBattery(DEVICE, { ...SNAP, BMSLCVolt: "0" });
  assert.equal(b.chargeVoltLimit, null);
});

test("chargeVoltLimit: populated when non-zero", () => {
  const b = buildBattery(DEVICE, { ...SNAP, BMSLCVolt: "57.6" });
  assert.equal(b.chargeVoltLimit, 57.6);
});

test("maxCellNum and minCellNum parsed as ints", () => {
  const b = buildBattery(DEVICE, SNAP);
  assert.equal(b.maxCellNum, 1);
  assert.equal(b.minCellNum, 16);
});

test("SOC falls back to device.battSoc when snap has none", () => {
  const b = buildBattery({ ...DEVICE, battSoc: "75" }, { ...SNAP, battSoc: undefined });
  assert.equal(b.soc, 75);
});
