export type SnapshotEntry = {
  sn:            string;
  alias:         string;
  soc:           number;
  soh:           number;
  power:         number;
  cellDelta:     number | null;
  cellMin:       number | null;
  cellMax:       number | null;
  maxCellNum:    number | null;
  minCellNum:    number | null;
  isBalancing:   boolean;
  voltages:      number[];
  temps:         number[];
  tempMax:       number;
  tempMin:       number;
  warningCount:  number;
  batCycleIndex: number | null;
};

type BatteryLike = {
  sn:              string;
  alias:           string;
  soc:             number;
  soh:             number;
  power:           number;
  cellDelta:       number | null;
  cellVoltageMin:  number | null;
  cellVoltageMax:  number | null;
  maxCellNum:      number | null;
  minCellNum:      number | null;
  isBalancing:     boolean;
  cellVoltages:    number[];
  cellTemps:       number[];
  tempMax:         number;
  tempMin:         number;
  warningCount:    number;
  batCycleIndex:   number | null;
};

export function nullableInt(v: string | number | null | undefined): number | null {
  return v != null ? parseInt(String(v), 10) : null;
}

export function nullableFloat(v: string | number | null | undefined): number | null {
  return v != null ? parseFloat(String(v)) : null;
}

export function clamp(min: number, val: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function pickSnapshotFields(b: BatteryLike): SnapshotEntry {
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

export function pickNextSunrise(
  sunrise:         string | null | undefined,
  sunriseTomorrow: string | null | undefined,
  now = Date.now()
): string | null {
  if (sunrise && now < new Date(sunrise).getTime()) return sunrise;
  return sunriseTomorrow ?? null;
}
