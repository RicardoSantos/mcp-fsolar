"use strict";

const { nullableInt, nullableFloat } = require("./helpers");
const { ChargingState }              = require("./enums");

function buildBattery(device, snap) {
  const cells = (snap.bmsVoltageList ?? []).map(Number);

  const maxCellNum = nullableInt(snap.maxVoltageNum2bms);
  const minCellNum = nullableInt(snap.minVoltageNum2bms);

  // 8 entries, only 4 real sensors; 3276.7 (32767/10) is the "no sensor" sentinel
  const cellTemps = (Array.isArray(snap.cellTempList) ? snap.cellTempList : [])
    .map(Number)
    .filter((t) => !isNaN(t) && t < 200);

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
    chargingState: snap.bmsChargingState === 1 ? ChargingState.CHARGING
                 : snap.bmsChargingState === 2 ? ChargingState.DISCHARGING
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
    // 4 modules of 4 cells each
    modules: cells.length === 16
      ? Array.from({ length: 4 }, (_, m) => {
          const mc = cells.slice(m * 4, m * 4 + 4);
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
    capacityAh:           parseFloat(snap.battCapacity ?? device.battCapacity ?? "314"),
    ratedEnergyKwh:       nullableFloat(snap.ratedEnergy) || null,
    dataTime:             snap.dataTimeStr ?? null,
    reportFreqSec:        nullableInt(snap.reportFreq),
    wifiSignal:           parseInt(snap.wifiSignal ?? device.wifiSignal ?? "0", 10),
    bmsState:             nullableInt(snap.bmsState),
    isBalancing:          snap.bmsState != null ? (parseInt(snap.bmsState, 10) & 64) !== 0 : false,
  };
}

module.exports = { buildBattery };
