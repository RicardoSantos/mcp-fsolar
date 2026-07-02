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
  readonly SNAPSHOT:        "snapshot";
};
export type HookEvent = typeof HookEvent[keyof typeof HookEvent];

// ── Errors ────────────────────────────────────────────────────────────────────

export declare class AppError extends Error {
  statusCode: number;
  constructor(message: string, statusCode?: number);
}

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

// ── Cache ─────────────────────────────────────────────────────────────────────

export declare class MemoryCacheAdapter implements CacheAdapter {
  get(key: string): Promise<{ batteries: Battery[]; fetchedAt: string } | null>;
  set(key: string, value: { batteries: Battery[]; fetchedAt: string }, ttlSeconds: number): Promise<void>;
}

// ── Snapshot stores ───────────────────────────────────────────────────────────

export declare class SnapshotStore {
  constructor(opts: { fileName: string; maxSnapshots: number; intervalMs: number });
  maybeAdd(batteries: Battery[]): void;
  getSnapshots(): BatterySnapshot[];
}

export declare class BatterySnapshotStore extends SnapshotStore {
  constructor();
  getTrend(sn: string): BalanceTrend | null;
  getAllTrends(batteries: Pick<Battery, "sn">[], snapshots?: BatterySnapshot[]): Record<string, BalanceTrend>;
}

export declare class DailySnapshotStore extends SnapshotStore {
  constructor();
}

// ── Client ────────────────────────────────────────────────────────────────────

export interface FelicityClientOptions {
  user:                string;
  pass:                string;
  cache?:              CacheAdapter;
  ttl?:                number;
  snapshotStore?:      BatterySnapshotStore;
  dailySnapshotStore?: DailySnapshotStore;
}

export declare class FelicityClient {
  constructor(opts: FelicityClientOptions);
  getBatteries(): Promise<BatteriesResult>;
  getBattery(id: string): Promise<BatteryResult>;
}

// ── Webhooks ──────────────────────────────────────────────────────────────────

export interface HookSubscription {
  id:        string;
  url:       string;
  /** Empty array means subscribe to all events. */
  events:    string[];
  createdAt: string;
}

export interface HookDelivery {
  event:    string;
  url:      string;
  ok:       boolean;
  status:   number;
  attempts: number;
  ts:       string;
}

export interface SnapshotPayload {
  batteries: Battery[];
  health:    Record<string, BatteryHealth>;
  /** ISO string of when the snapshot was emitted. */
  ts:        string;
}

export declare class HookStore {
  add(opts: { url: string; events?: string[]; secret?: string }): HookSubscription;
  remove(id: string): boolean;
  list(): HookSubscription[];
  getDeliveries(hookId: string): HookDelivery[];
  fire(batteries: Battery[], health: Record<string, BatteryHealth>): Promise<void>;
  fireSnapshot(payload: SnapshotPayload): Promise<void>;
}

export declare const hookStore:          HookStore;
export declare const snapshotStore:      BatterySnapshotStore;
export declare const dailySnapshotStore: DailySnapshotStore;

// ── Health & autonomy ─────────────────────────────────────────────────────────

export interface BatteryHealth {
  alias:           string;
  cellDeltaStatus: HealthStatus | null;
  cellDelta:       number | null;
  /** Median cell delta from discharge-only snapshots (delta < 30 mV).
   *  Excludes top-of-charge readings where the BMS is still balancing. */
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
  estimatedHours:       number;
  estimatedHoursToFull: number | null;
}

export interface AutonomyResult {
  totalRemainingKwh:     number;
  totalCapacityKwh:      number;
  dischargeRateKw:       number;
  estimatedHours:        number;
  estimatedHoursToFull:  number | null;
  estimatedSocAtSunrise: number | null;
  hoursToSunrise:        number | null;
  estimatedDischargeKwh: number | null;
  estimatedRemainingKwh: number | null;
  perBattery:            AutonomyPerBattery[];
}

export interface AutonomyOptions {
  sunriseAt?:          string | Date | null;
  packCapacityKwh?:    number | null;
  minSocPct?:          number;
  defaultDischargeKw?: number;
}

/** Compute per-battery health metrics from live batteries and recent snapshots. */
export declare function computeHealth(
  batteries: Battery[],
  snapshots:  BatterySnapshot[]
): Record<string, BatteryHealth>;

/** Compute fleet autonomy estimate. */
export declare function computeAutonomy(
  batteries: Battery[],
  snapshots:  BatterySnapshot[],
  opts?:      AutonomyOptions
): AutonomyResult;

// ── State ─────────────────────────────────────────────────────────────────────

export interface MaterializedState {
  updatedAt: string;
  batteries: Battery[];
  trend:     Record<string, BalanceTrend>;
  health:    Record<string, BatteryHealth>;
  autonomy:  AutonomyResult;
}

/** Read the pre-computed materialized state written by startPoller. Returns null if not yet available. */
export declare function readState(): Promise<MaterializedState | null>;

/** Start a background poller that calls getBatteries() at the configured interval,
 *  writes snapshots, and materializes computed state to battery-state.json. */
export declare function startPoller(
  client: FelicityClient,
  opts?: { snapshotStore?: BatterySnapshotStore; hookStore?: HookStore }
): { stop(): void };

/** EventEmitter that fires a 'snapshot' event every FELICITY_TELEMETRY_MS (default 5 min). */
export declare const snapshotEmitter: import('events').EventEmitter;

// ── Server ────────────────────────────────────────────────────────────────────

export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export interface LoggerOptions {
  write?: (line: string) => void;
}

export declare function createLogger(opts?: LoggerOptions): Logger;
export declare const logger: Logger;

export interface ServerOptions {
  apiKey?:       string;
  rateLimit?:    number;
  corsOrigin?:   string;
  trustProxy?:   boolean;
  port?:         number;
  snapshotStore?: BatterySnapshotStore;
  hookStore?:     HookStore;
  logger?:        Logger;
}

export interface ServerResult {
  httpServer:    import('http').Server;
  mcp:           object;
  setPollError(err: Error | string | null): void;
  close():       Promise<void>;
}

export declare function createServer(client: FelicityClient, opts?: ServerOptions): ServerResult;

export declare function startServer(
  client: FelicityClient,
  opts?:  ServerOptions
): Promise<{ port: number; url: string; setPollError(err: Error | string | null): void; close(): Promise<void> }>;

// ── Misc exports ──────────────────────────────────────────────────────────────

export declare function buildBattery(device: Record<string, unknown>, snap: Record<string, unknown>): Battery;
export declare const HOOK_COOLDOWNS_H:       Record<string, number>;
export declare const resolveSnapshotConfig:  () => { enabled: boolean; ms: number; maxIntra: number; ddays: number };
export declare const HEALTH_CELL_DELTA_WARN: number;
export declare const HEALTH_CELL_DELTA_CRIT: number;
export declare const HEALTH_TEMP_WARN:       number;
export declare const HEALTH_TEMP_CRIT:       number;
export declare const HEALTH_OUTLIER_MV:      number;
export declare const HEALTH_SOH_WARN:        number;
