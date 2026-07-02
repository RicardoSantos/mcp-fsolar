// Enums (values and type aliases share the same name — TypeScript supports this pattern)
export { ChargingState, HealthStatus, TrendDirection, HookEvent } from "./src/enums";

// Errors
export { AppError } from "./src/errors";

// Logging
export { createLogger, logger, type Logger, type LoggerOptions } from "./src/logger";

// Cache
export { MemoryCacheAdapter, type CacheAdapter, type CacheValue } from "./src/cache";

// Battery
export { buildBattery, type Battery, type BatteryModule,
         BATTERY_DEVICE_TYPE, BMS_BALANCING_BIT, DEFAULT_CAPACITY_AH, CELL_COUNT,
         MODULE_COUNT, CELLS_PER_MODULE, TEMP_SENTINEL_MAX_C } from "./src/battery";

// Snapshot stores
export { SnapshotStore, BatterySnapshotStore, DailySnapshotStore,
         snapshotStore, dailySnapshotStore, resolveSnapshotConfig,
         type BatterySnapshot, type BalanceTrend } from "./src/store";

// Webhooks
export { HookStore, hookStore, HOOK_COOLDOWNS_H,
         type HookSubscription, type HookDelivery, type SnapshotPayload } from "./src/hooks";

// Compute
export { computeHealth, computeAutonomy,
         HEALTH_CELL_DELTA_WARN, HEALTH_CELL_DELTA_CRIT,
         HEALTH_TEMP_WARN, HEALTH_TEMP_CRIT,
         HEALTH_OUTLIER_MV, HEALTH_SOH_WARN,
         type BatteryHealth, type AutonomyResult,
         type AutonomyOptions, type AutonomyPerBattery } from "./src/compute";

// State & poller
export { startPoller, readState, snapshotEmitter, type MaterializedState } from "./src/state";

// Client
export { FelicityClient,
         type FelicityClientOptions, type BatteriesResult, type BatteryResult } from "./src/client";

// Helpers
export { pickNextSunrise, nullableInt, nullableFloat, clamp, sleep } from "./src/helpers";

// Analyze
export { computeAlerts, computeEnergyHistory, computeCellStats, computePowerStats,
         AlertSeverity,
         type Alert, type EnergyDay, type CellStat, type PowerStats } from "./src/analyze";

// Server (embedded / programmatic use)
export { createServer, startServer, type ServerOptions, type ServerResult } from "./server";
