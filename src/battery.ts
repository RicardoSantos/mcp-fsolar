import { nullableInt, nullableFloat } from "./helpers";
import { ChargingState }              from "./enums";

// ── Hardware constants (Felicity BP series) ───────────────────────────────────
export const BMS_CHARGING_REG    = 1;
export const BMS_DISCHARGING_REG = 2;
export const BMS_BALANCING_BIT   = 64;
export const CELL_COUNT          = 16;
export const MODULE_COUNT        = 4;
export const CELLS_PER_MODULE    = 4;
export const DEFAULT_CAPACITY_AH = 314;
export const TEMP_SENTINEL_MAX_C = 200;

export interface BatteryModule {
  index: number;
  cells: number[];
  temp:  number | null;
  min:   number;
  max:   number;
  delta: number;
}

export interface Battery {
  sn:             string;
  alias:          string;
  model:          string;
  status:         "NM" | "AL" | "FL" | "OF";
  soc:            number;
  soh:            number;
  voltage:        number;
  current:        number;
  power:          number;
  chargingState:  ChargingState;
  tempMax:        number;
  tempMin:        number;
  cellTemps:      number[];
  cellVoltages:   number[];
  cellVoltageMax: number | null;
  cellVoltageMin: number | null;
  cellDelta:      number | null;
  maxCellNum:     number | null;
  minCellNum:     number | null;
  modules:        BatteryModule[];
  chargeVoltLimit:      number | null;
  dischargeVoltLimit:   number | null;
  chargeCurrLimit:      number | null;
  dischargeCurrLimit:   number | null;
  batCycleIndex:        number | null;
  batFullCount:         number | null;
  batUnderVoltageCount: number | null;
  warningCount:         number;
  remainingKwh:         number;
  capacityAh:           number;
  ratedEnergyKwh:       number | null;
  dataTime:             string | null;
  reportFreqSec:        number | null;
  wifiSignal:           number;
  bmsState:             number | null;
  isBalancing:          boolean;
}

export function buildBattery(device: Record<string, unknown>, snap: Record<string, unknown>): Battery {
  const cells = (Array.isArray(snap.bmsVoltageList) ? snap.bmsVoltageList : []).map(Number);

  const maxCellNum = nullableInt(snap.maxVoltageNum2bms as string | number | null | undefined);
  const minCellNum = nullableInt(snap.minVoltageNum2bms as string | number | null | undefined);

  const cellTemps = (Array.isArray(snap.cellTempList) ? snap.cellTempList : [])
    .map(Number)
    .filter((t) => !isNaN(t) && t < TEMP_SENTINEL_MAX_C);

  const cellDelta = cells.length ? Math.max(...cells) - Math.min(...cells) : null;

  const bmsChargingState = snap.bmsChargingState as number | undefined;
  const chargingState: ChargingState = bmsChargingState === BMS_CHARGING_REG    ? ChargingState.CHARGING
                                     : bmsChargingState === BMS_DISCHARGING_REG ? ChargingState.DISCHARGING
                                     : ChargingState.STANDBY;

  return {
    sn:            String(device.deviceSn ?? ""),
    alias:         String(device.alias    ?? ""),
    model:         String(device.deviceModel ?? ""),
    status:        (device.status ?? "NM") as Battery["status"],
    soc:           parseFloat(String(snap.battSoc    ?? device.battSoc  ?? "0")),
    soh:           parseFloat(String(snap.battSoh    ?? "100")),
    voltage:       parseFloat(String(snap.battVolt   ?? "0")),
    current:       parseFloat(String(snap.battCurr   ?? "0")),
    power:         parseFloat(String(snap.bmsPower   ?? device.bmsPower ?? "0")),
    chargingState,
    tempMax:       parseFloat(String(snap.tempMax ?? "0")),
    tempMin:       parseFloat(String(snap.tempMin ?? "0")),
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
    chargeVoltLimit:      parseFloat(String(snap.BMSLCVolt ?? "0"))             || null,
    dischargeVoltLimit:   parseFloat(String(snap.BMSLDVolt ?? "0"))             || null,
    chargeCurrLimit:      parseFloat(String(snap.BMSLCCurr ?? "0"))             || null,
    dischargeCurrLimit:   parseFloat(String(snap.BMSLDCurr ?? snap.bmsldcurr ?? "0")) || null,
    batCycleIndex:        nullableInt(snap.batCycleIndex        as string | number | null | undefined),
    batFullCount:         nullableInt(snap.batFullCount         as string | number | null | undefined),
    batUnderVoltageCount: nullableInt(snap.batUnderVoltageCount as string | number | null | undefined),
    warningCount:         nullableInt(snap.warningCount as string | number | null | undefined) ?? 0,
    remainingKwh:         parseFloat(String(snap.remainingBatteryEnergy1 ?? "0")),
    capacityAh:           parseFloat(String(snap.battCapacity ?? device.battCapacity ?? String(DEFAULT_CAPACITY_AH))),
    ratedEnergyKwh:       nullableFloat(snap.ratedEnergy as string | number | null | undefined) || null,
    dataTime:             (snap.dataTimeStr as string | null | undefined) ?? null,
    reportFreqSec:        nullableInt(snap.reportFreq as string | number | null | undefined),
    wifiSignal:           parseInt(String(snap.wifiSignal ?? device.wifiSignal ?? "0"), 10),
    bmsState:             nullableInt(snap.bmsState as string | number | null | undefined),
    isBalancing:          snap.bmsState != null ? (parseInt(String(snap.bmsState), 10) & BMS_BALANCING_BIT) !== 0 : false,
  };
}
