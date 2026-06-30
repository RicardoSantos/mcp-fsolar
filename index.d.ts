export interface BatteryModule {
  index: number;   // 1-4
  cells: number[]; // mV × 4
  temp:  number | null; // °C from physical sensor
  min:   number;
  max:   number;
  delta: number;   // mV spread within module
}

export interface Battery {
  sn:             string;
  alias:          string;
  model:          string;
  status:         "NM" | "AL" | "FL" | "OF";
  soc:            number;   // %
  soh:            number;   // %
  voltage:        number;   // V
  current:        number;   // A
  power:          number;   // W  (positive = charging, negative = discharging)
  chargingState:  "charging" | "discharging" | "standby";
  tempMax:        number;   // °C
  tempMin:        number;   // °C
  cellTemps:      number[]; // °C — 4 physical sensors (3276.7 sentinel filtered out)
  cellVoltages:   number[]; // mV × 16
  cellVoltageMax: number | null;
  cellVoltageMin: number | null;
  cellDelta:      number | null; // mV spread
  maxCellNum:     number | null; // 1-based index of max-voltage cell (from BMS)
  minCellNum:     number | null; // 1-based index of min-voltage cell (from BMS)
  modules:        BatteryModule[];
  chargeVoltLimit:    number | null; // V — max charge voltage
  dischargeVoltLimit: number | null; // V — min discharge voltage
  chargeCurrLimit:    number | null; // A — max charge current
  dischargeCurrLimit: number | null; // A — max discharge current
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

export interface BatterySnapshot {
  ts: string;
  batteries: Array<{
    sn:           string;
    alias:        string;
    soc:          number;
    soh:          number;
    power:        number;
    cellDelta:    number | null;
    cellMin:      number | null;
    cellMax:      number | null;
    maxCellNum:   number | null;
    minCellNum:   number | null;
    isBalancing:  boolean;
    voltages:     number[];
    temps:        number[];
    tempMax:      number;
    tempMin:      number;
    warningCount: number;
    batCycleIndex: number | null;
  }>;
}

export interface BalanceTrend {
  direction:              "improving" | "stable" | "degrading";
  deltaChange:            number;
  history:                number[];
  balancingCount:         number;
  snapshotCount:          number;
  currentBalancingStreak: number;
}

export interface BatteriesResult {
  batteries: Battery[];
  fetchedAt: string;
  fromCache: boolean;
  trend:     Record<string, BalanceTrend>;
}

export interface BatteryResult {
  battery:   Battery | null;
  fetchedAt: string;
  fromCache: boolean;
}

export interface CacheAdapter {
  get(key: string): Promise<{ batteries: Battery[]; fetchedAt: string } | null>;
  set(key: string, value: { batteries: Battery[]; fetchedAt: string }, ttlSeconds: number): Promise<void>;
}

export interface FelicityClientOptions {
  user:   string;
  pass:   string;
  cache?: CacheAdapter;
  ttl?:   number;
}

export declare class MemoryCacheAdapter implements CacheAdapter {
  get(key: string): Promise<{ batteries: Battery[]; fetchedAt: string } | null>;
  set(key: string, value: { batteries: Battery[]; fetchedAt: string }, ttlSeconds: number): Promise<void>;
}

export declare class SnapshotStore {
  constructor(opts: { fileName: string; maxSnapshots: number; intervalMs: number });
  maybeAdd(batteries: Battery[]): void;
  getSnapshots(): BatterySnapshot[];
}

export declare class BatterySnapshotStore extends SnapshotStore {
  constructor();
  getTrend(sn: string): BalanceTrend | null;
  getAllTrends(batteries: Pick<Battery, "sn">[]): Record<string, BalanceTrend>;
}

export declare class DailySnapshotStore extends SnapshotStore {
  constructor();
}

export declare class FelicityClient {
  constructor(opts: FelicityClientOptions);
  getBatteries(): Promise<BatteriesResult>;
  getBattery(id: string): Promise<BatteryResult>;
}

export declare function buildBattery(device: Record<string, unknown>, snap: Record<string, unknown>): Battery;

export declare const snapshotStore:      BatterySnapshotStore;
export declare const dailySnapshotStore: DailySnapshotStore;
