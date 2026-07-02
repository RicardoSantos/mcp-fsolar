"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TEMP_SENTINEL_MAX_C = exports.DEFAULT_CAPACITY_AH = exports.CELLS_PER_MODULE = exports.MODULE_COUNT = exports.CELL_COUNT = exports.BMS_BALANCING_BIT = exports.BMS_DISCHARGING_REG = exports.BMS_CHARGING_REG = void 0;
exports.buildBattery = buildBattery;
const helpers_1 = require("./helpers");
const enums_1 = require("./enums");
// ── Hardware constants (Felicity BP series) ───────────────────────────────────
exports.BMS_CHARGING_REG = 1;
exports.BMS_DISCHARGING_REG = 2;
exports.BMS_BALANCING_BIT = 64;
exports.CELL_COUNT = 16;
exports.MODULE_COUNT = 4;
exports.CELLS_PER_MODULE = 4;
exports.DEFAULT_CAPACITY_AH = 314;
exports.TEMP_SENTINEL_MAX_C = 200;
function buildBattery(device, snap) {
    const cells = (Array.isArray(snap.bmsVoltageList) ? snap.bmsVoltageList : []).map(Number);
    const maxCellNum = (0, helpers_1.nullableInt)(snap.maxVoltageNum2bms);
    const minCellNum = (0, helpers_1.nullableInt)(snap.minVoltageNum2bms);
    const cellTemps = (Array.isArray(snap.cellTempList) ? snap.cellTempList : [])
        .map(Number)
        .filter((t) => !isNaN(t) && t < exports.TEMP_SENTINEL_MAX_C);
    const cellDelta = cells.length ? Math.max(...cells) - Math.min(...cells) : null;
    const bmsChargingState = snap.bmsChargingState;
    const chargingState = bmsChargingState === exports.BMS_CHARGING_REG ? enums_1.ChargingState.CHARGING
        : bmsChargingState === exports.BMS_DISCHARGING_REG ? enums_1.ChargingState.DISCHARGING
            : enums_1.ChargingState.STANDBY;
    return {
        sn: String(device.deviceSn ?? ""),
        alias: String(device.alias ?? ""),
        model: String(device.deviceModel ?? ""),
        status: (device.status ?? "NM"),
        soc: parseFloat(String(snap.battSoc ?? device.battSoc ?? "0")),
        soh: parseFloat(String(snap.battSoh ?? "100")),
        voltage: parseFloat(String(snap.battVolt ?? "0")),
        current: parseFloat(String(snap.battCurr ?? "0")),
        power: parseFloat(String(snap.bmsPower ?? device.bmsPower ?? "0")),
        chargingState,
        tempMax: parseFloat(String(snap.tempMax ?? "0")),
        tempMin: parseFloat(String(snap.tempMin ?? "0")),
        cellTemps,
        cellVoltages: cells,
        cellVoltageMax: cells.length ? Math.max(...cells) : null,
        cellVoltageMin: cells.length ? Math.min(...cells) : null,
        cellDelta,
        maxCellNum,
        minCellNum,
        modules: cells.length === exports.CELL_COUNT
            ? Array.from({ length: exports.MODULE_COUNT }, (_, m) => {
                const mc = cells.slice(m * exports.CELLS_PER_MODULE, m * exports.CELLS_PER_MODULE + exports.CELLS_PER_MODULE);
                return { index: m + 1, cells: mc, temp: cellTemps[m] ?? null,
                    min: Math.min(...mc), max: Math.max(...mc), delta: Math.max(...mc) - Math.min(...mc) };
            })
            : [],
        chargeVoltLimit: parseFloat(String(snap.BMSLCVolt ?? "0")) || null,
        dischargeVoltLimit: parseFloat(String(snap.BMSLDVolt ?? "0")) || null,
        chargeCurrLimit: parseFloat(String(snap.BMSLCCurr ?? "0")) || null,
        dischargeCurrLimit: parseFloat(String(snap.BMSLDCurr ?? snap.bmsldcurr ?? "0")) || null,
        batCycleIndex: (0, helpers_1.nullableInt)(snap.batCycleIndex),
        batFullCount: (0, helpers_1.nullableInt)(snap.batFullCount),
        batUnderVoltageCount: (0, helpers_1.nullableInt)(snap.batUnderVoltageCount),
        warningCount: (0, helpers_1.nullableInt)(snap.warningCount) ?? 0,
        remainingKwh: parseFloat(String(snap.remainingBatteryEnergy1 ?? "0")),
        capacityAh: parseFloat(String(snap.battCapacity ?? device.battCapacity ?? String(exports.DEFAULT_CAPACITY_AH))),
        ratedEnergyKwh: (0, helpers_1.nullableFloat)(snap.ratedEnergy) || null,
        dataTime: snap.dataTimeStr ?? null,
        reportFreqSec: (0, helpers_1.nullableInt)(snap.reportFreq),
        wifiSignal: parseInt(String(snap.wifiSignal ?? device.wifiSignal ?? "0"), 10),
        bmsState: (0, helpers_1.nullableInt)(snap.bmsState),
        isBalancing: snap.bmsState != null ? (parseInt(String(snap.bmsState), 10) & exports.BMS_BALANCING_BIT) !== 0 : false,
    };
}
