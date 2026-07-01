"use strict";

const { nullableInt, nullableFloat } = require("./helpers");
const { ChargingState }              = require("./enums");

// ── Hardware constants (Felicity BP series) ───────────────────────────────────
const BMS_CHARGING_REG    = 1;    // bmsChargingState register value → charging
const BMS_DISCHARGING_REG = 2;    // bmsChargingState register value → discharging
const BMS_BALANCING_BIT   = 64;   // bit 6 of bmsState — BMS is actively balancing cells
const CELL_COUNT          = 16;   // cells per pack (4 modules × 4 cells)
const MODULE_COUNT        = 4;    // modules per pack
const CELLS_PER_MODULE    = 4;    // cells per module
const DEFAULT_CAPACITY_AH = 314;  // fallback capacity if API omits battCapacity
const TEMP_SENTINEL_MAX_C = 200;  // Felicity outputs 3276.7 (32767 / 10) for missing sensors; anything ≥ 200 °C is invalid

function buildBattery(device, snap) {
  const cells = (snap.bmsVoltageList ?? []).map(Number);

  const maxCellNum = nullableInt(snap.maxVoltageNum2bms);
  const minCellNum = nullableInt(snap.minVoltageNum2bms);

  const cellTemps = (Array.isArray(snap.cellTempList) ? snap.cellTempList : [])
    .map(Number)
    .filter((t) => !isNaN(t) && t < TEMP_SENTINEL_MAX_C);

  const cellDelta = cells.length ? Math.max(...cells) - Math.min(...cells) : null;

  return {
    sn:            device.deviceSn,
    alias:         device.alias,
    model:         device.deviceModel,
    status:        device.status,
    soc:           parseFloat(snap.battSoc    ?? device.battSoc  ?? "0"),
    soh:           parseFloat(snap.battSoh    ?? "100"),
    voltage:       parseFloat(snap.battVolt   ?? "0"),
    current:       parseFloat(snap.battCurr   ?? "0"),
    power:         parseFloat(snap.bmsPower   ?? device.bmsPower ?? "0"),
    chargingState: snap.bmsChargingState === BMS_CHARGING_REG    ? ChargingState.CHARGING
                 : snap.bmsChargingState === BMS_DISCHARGING_REG ? ChargingState.DISCHARGING
                 : ChargingState.STANDBY,
    tempMax:       parseFloat(snap.tempMax ?? "0"),
    tempMin:       parseFloat(snap.tempMin ?? "0"),
    cellTemps,
    cellVoltages:   cells,
    cellVoltageMax: cells.length ? Math.max(...cells) : null,
    cellVoltageMin: cells.length ? Math.min(...cells) : null,
    cellDelta,
    maxCellNum,
    minCellNum,
    modules: cells.length === CELL_COUNT
      ? Array.from({ length: MODULE_COUNT }, (_, m) => {
          const mc = cells.slice(m * CELLS_PER_MODULE, m * CELLS_PER_MODULE + CELLS_PER_MODULE);
          return { index: m + 1, cells: mc, temp: cellTemps[m] ?? null,
                   min: Math.min(...mc), max: Math.max(...mc), delta: Math.max(...mc) - Math.min(...mc) };
        })
      : [],
    chargeVoltLimit:      parseFloat(snap.BMSLCVolt ?? "0")             || null,
    dischargeVoltLimit:   parseFloat(snap.BMSLDVolt ?? "0")             || null,
    chargeCurrLimit:      parseFloat(snap.BMSLCCurr ?? "0")             || null,
    dischargeCurrLimit:   parseFloat(snap.BMSLDCurr ?? snap.bmsldcurr ?? "0") || null,
    batCycleIndex:        nullableInt(snap.batCycleIndex),
    batFullCount:         nullableInt(snap.batFullCount),
    batUnderVoltageCount: nullableInt(snap.batUnderVoltageCount),
    warningCount:         snap.warningCount != null ? parseInt(snap.warningCount, 10) : 0,
    remainingKwh:         parseFloat(snap.remainingBatteryEnergy1 ?? "0"),
    capacityAh:           parseFloat(snap.battCapacity ?? device.battCapacity ?? String(DEFAULT_CAPACITY_AH)),
    ratedEnergyKwh:       nullableFloat(snap.ratedEnergy) || null,
    dataTime:             snap.dataTimeStr ?? null,
    reportFreqSec:        nullableInt(snap.reportFreq),
    wifiSignal:           parseInt(snap.wifiSignal ?? device.wifiSignal ?? "0", 10),
    bmsState:             nullableInt(snap.bmsState),
    isBalancing:          snap.bmsState != null ? (parseInt(snap.bmsState, 10) & BMS_BALANCING_BIT) !== 0 : false,
  };
}

module.exports = { buildBattery, BMS_BALANCING_BIT, DEFAULT_CAPACITY_AH, CELL_COUNT, MODULE_COUNT, CELLS_PER_MODULE, TEMP_SENTINEL_MAX_C };
