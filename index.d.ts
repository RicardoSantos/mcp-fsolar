// ── Enums ─────────────────────────────────────────────────────────────────────

export declare const ChargingState: {
  readonly CHARGING:    "charging";
  readonly DISCHARGING: "discharging";
  readonly STANDBY:     "standby";
};
export type ChargingState = typeof ChargingState[keyof typeof ChargingState];

export declare const HealthStatus: {
  readonly OK:   "ok";
  readonly WARN: "warn";
  readonly CRIT: "crit";
};
export type HealthStatus = typeof HealthStatus[keyof typeof HealthStatus];

export declare const TrendDirection: {
  readonly IMPROVING: "improving";
  readonly STABLE:    "stable";
  readonly DEGRADING: "degrading";
};
export type TrendDirection = typeof TrendDirection[keyof typeof TrendDirection];

export declare const HookEvent: {
  readonly CELL_DELTA_CRIT: "cell_delta_crit";
  readonly CELL_DELTA_WARN: "cell_delta_warn";
  readonly TEMP_CRIT:       "temp_crit";
  readonly TEMP_WARN:       "temp_warn";
  readonly SOH_WARN:        "soh_warn";
  readonly LOW_SOC:         "low_soc";
  readonly FULL:            "full";
  readonly ONLINE:          "online";
  readonly OFFLINE:         "offline";
};
export type HookEvent = typeof HookEvent[keyof typeof HookEvent];

// ── Interfaces ────────────────────────────────────────────────────────────────

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
  chargingState:  ChargingState;
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
  direction:              TrendDirection;
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

export interface FleetSummary {
  totalKwh:       number;
  totalPowerW:    number;
  avgSoc:         number;
  worstCellDelta: number | null;
  maxTempC:       number;
}

export interface BatteryHealth {
  alias:           string;
  cellDeltaStatus: HealthStatus | null;
  cellDelta:       number | null;
  /** Median cell delta from discharge-only snapshots (delta < 30 mV).
   *  Excludes top-of-charge readings where the BMS is still balancing.
   *  null if fewer than 3 qualifying snapshots. */
  dischargeDelta:  number | null;
  tempStatus:      HealthStatus | null;
  tempMax:         number | null;
  sohStatus:       Exclude<HealthStatus, "crit"> | null;
  soh:             number | null;
  outliers:        number[];   // 1-based cell indices persistently below pack avg
  avgCRate:        number | null;
}

export interface AutonomyPerBattery {
  sn:                   string;
  alias:                string;
  remainingKwh:         number;
  /** Hours until this battery reaches minSocPct at current discharge rate. */
  estimatedHours:       number;
  /** Hours until this battery reaches 100% at current charge rate. null if not charging. */
  estimatedHoursToFull: number | null;
}

export interface AutonomyResult {
  totalRemainingKwh:    number;
  dischargeRateKw:      number;
  /** Hours until fleet reaches minSocPct at current discharge rate. */
  estimatedHours:       number;
  /** Hours until fleet reaches 100% at current charge rate. null if not charging. */
  estimatedHoursToFull: number | null;
  /** Estimated SOC (%) at sunriseAt. null if sunriseAt or packCapacityKwh not provided. */
  estimatedSocAtSunrise: number | null;
  /** Per-battery breakdown. */
  perBattery:           AutonomyPerBattery[];
}

export interface AutonomyOptions {
  /** ISO string or Date of next sunrise. Required for estimatedSocAtSunrise. */
  sunriseAt?:         string | Date | null;
  /** Total pack capacity in kWh. Required for estimatedSocAtSunrise. */
  packCapacityKwh?:   number | null;
  /** Minimum SOC % the battery stops at (default 5). */
  minSocPct?:         number;
  /** Fallback discharge rate kW when not actively discharging and no night snapshots (default 1.5). */
  defaultDischargeKw?: number;
}

export interface MaterializedState {
  updatedAt: string;
  batteries: Battery[];
  trends:    Record<string, BalanceTrend>;
  health:    Record<string, BatteryHealth>;
  autonomy:  AutonomyResult;
  fleet:     FleetSummary;
}

/** Compute per-battery health metrics from live batteries and recent snapshots. */
export declare function computeHealth(
  batteries: Battery[],
  snapshots:  BatterySnapshot[]
): Record<string, BatteryHealth>;

/** Compute fleet autonomy estimate.
 *  Pass sunriseAt + packCapacityKwh to get estimatedSocAtSunrise, otherwise it is null. */
export declare function computeAutonomy(
  batteries: Battery[],
  snapshots:  BatterySnapshot[],
  opts?:      AutonomyOptions
): AutonomyResult;

/** Read the pre-computed materialized state written by startPoller. Returns null if not yet available. */
export declare function readState(): MaterializedState | null;

/** Start a background poller that calls getBatteries() at the configured interval,
 *  writes snapshots, and materializes computed state to battery-state.json.
 *  Controlled by env vars: FELICITY_SNAPSHOT_ENABLED, FELICITY_SNAPSHOT_MS,
 *  FELICITY_SNAPSHOT_DAYS, FELICITY_DAILY_DAYS.
 *  Returns a stop function. */
export declare function startPoller(client: FelicityClient): () => void;

export interface HookPayload {
  event:     string;
  battery:   string;
  sn:        string;
  value:     number | null;
  threshold: number | null;
  ts:        string;
}

export interface HookSubscription {
  id:        string;
  url:       string;
  /** If empty array, subscribes to all events. */
  events:    string[];
  params:    Record<string, unknown>;
  createdAt: string;
}

export declare class HookStore {
  add(opts: { url: string; events?: string[]; params?: Record<string, unknown> }): HookSubscription;
  remove(id: string): boolean;
  list(): HookSubscription[];
  fire(batteries: Battery[], health: Record<string, BatteryHealth>): Promise<void>;
}

export declare const hookStore:          HookStore;
export declare const snapshotStore:      BatterySnapshotStore;
export declare const dailySnapshotStore: DailySnapshotStore;
