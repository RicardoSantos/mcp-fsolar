"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startServer = exports.createServer = exports.sleep = exports.clamp = exports.nullableFloat = exports.nullableInt = exports.pickNextSunrise = exports.FelicityClient = exports.snapshotEmitter = exports.readState = exports.startPoller = exports.HEALTH_SOH_WARN = exports.HEALTH_OUTLIER_MV = exports.HEALTH_TEMP_CRIT = exports.HEALTH_TEMP_WARN = exports.HEALTH_CELL_DELTA_CRIT = exports.HEALTH_CELL_DELTA_WARN = exports.computeAutonomy = exports.computeHealth = exports.HOOK_COOLDOWNS_H = exports.hookStore = exports.HookStore = exports.resolveSnapshotConfig = exports.dailySnapshotStore = exports.snapshotStore = exports.DailySnapshotStore = exports.BatterySnapshotStore = exports.SnapshotStore = exports.TEMP_SENTINEL_MAX_C = exports.CELLS_PER_MODULE = exports.MODULE_COUNT = exports.CELL_COUNT = exports.DEFAULT_CAPACITY_AH = exports.BMS_BALANCING_BIT = exports.buildBattery = exports.MemoryCacheAdapter = exports.logger = exports.createLogger = exports.AppError = exports.HookEvent = exports.TrendDirection = exports.HealthStatus = exports.ChargingState = void 0;
// Enums (values and type aliases share the same name — TypeScript supports this pattern)
var enums_1 = require("./src/enums");
Object.defineProperty(exports, "ChargingState", { enumerable: true, get: function () { return enums_1.ChargingState; } });
Object.defineProperty(exports, "HealthStatus", { enumerable: true, get: function () { return enums_1.HealthStatus; } });
Object.defineProperty(exports, "TrendDirection", { enumerable: true, get: function () { return enums_1.TrendDirection; } });
Object.defineProperty(exports, "HookEvent", { enumerable: true, get: function () { return enums_1.HookEvent; } });
// Errors
var errors_1 = require("./src/errors");
Object.defineProperty(exports, "AppError", { enumerable: true, get: function () { return errors_1.AppError; } });
// Logging
var logger_1 = require("./src/logger");
Object.defineProperty(exports, "createLogger", { enumerable: true, get: function () { return logger_1.createLogger; } });
Object.defineProperty(exports, "logger", { enumerable: true, get: function () { return logger_1.logger; } });
// Cache
var cache_1 = require("./src/cache");
Object.defineProperty(exports, "MemoryCacheAdapter", { enumerable: true, get: function () { return cache_1.MemoryCacheAdapter; } });
// Battery
var battery_1 = require("./src/battery");
Object.defineProperty(exports, "buildBattery", { enumerable: true, get: function () { return battery_1.buildBattery; } });
Object.defineProperty(exports, "BMS_BALANCING_BIT", { enumerable: true, get: function () { return battery_1.BMS_BALANCING_BIT; } });
Object.defineProperty(exports, "DEFAULT_CAPACITY_AH", { enumerable: true, get: function () { return battery_1.DEFAULT_CAPACITY_AH; } });
Object.defineProperty(exports, "CELL_COUNT", { enumerable: true, get: function () { return battery_1.CELL_COUNT; } });
Object.defineProperty(exports, "MODULE_COUNT", { enumerable: true, get: function () { return battery_1.MODULE_COUNT; } });
Object.defineProperty(exports, "CELLS_PER_MODULE", { enumerable: true, get: function () { return battery_1.CELLS_PER_MODULE; } });
Object.defineProperty(exports, "TEMP_SENTINEL_MAX_C", { enumerable: true, get: function () { return battery_1.TEMP_SENTINEL_MAX_C; } });
// Snapshot stores
var store_1 = require("./src/store");
Object.defineProperty(exports, "SnapshotStore", { enumerable: true, get: function () { return store_1.SnapshotStore; } });
Object.defineProperty(exports, "BatterySnapshotStore", { enumerable: true, get: function () { return store_1.BatterySnapshotStore; } });
Object.defineProperty(exports, "DailySnapshotStore", { enumerable: true, get: function () { return store_1.DailySnapshotStore; } });
Object.defineProperty(exports, "snapshotStore", { enumerable: true, get: function () { return store_1.snapshotStore; } });
Object.defineProperty(exports, "dailySnapshotStore", { enumerable: true, get: function () { return store_1.dailySnapshotStore; } });
Object.defineProperty(exports, "resolveSnapshotConfig", { enumerable: true, get: function () { return store_1.resolveSnapshotConfig; } });
// Webhooks
var hooks_1 = require("./src/hooks");
Object.defineProperty(exports, "HookStore", { enumerable: true, get: function () { return hooks_1.HookStore; } });
Object.defineProperty(exports, "hookStore", { enumerable: true, get: function () { return hooks_1.hookStore; } });
Object.defineProperty(exports, "HOOK_COOLDOWNS_H", { enumerable: true, get: function () { return hooks_1.HOOK_COOLDOWNS_H; } });
// Compute
var compute_1 = require("./src/compute");
Object.defineProperty(exports, "computeHealth", { enumerable: true, get: function () { return compute_1.computeHealth; } });
Object.defineProperty(exports, "computeAutonomy", { enumerable: true, get: function () { return compute_1.computeAutonomy; } });
Object.defineProperty(exports, "HEALTH_CELL_DELTA_WARN", { enumerable: true, get: function () { return compute_1.HEALTH_CELL_DELTA_WARN; } });
Object.defineProperty(exports, "HEALTH_CELL_DELTA_CRIT", { enumerable: true, get: function () { return compute_1.HEALTH_CELL_DELTA_CRIT; } });
Object.defineProperty(exports, "HEALTH_TEMP_WARN", { enumerable: true, get: function () { return compute_1.HEALTH_TEMP_WARN; } });
Object.defineProperty(exports, "HEALTH_TEMP_CRIT", { enumerable: true, get: function () { return compute_1.HEALTH_TEMP_CRIT; } });
Object.defineProperty(exports, "HEALTH_OUTLIER_MV", { enumerable: true, get: function () { return compute_1.HEALTH_OUTLIER_MV; } });
Object.defineProperty(exports, "HEALTH_SOH_WARN", { enumerable: true, get: function () { return compute_1.HEALTH_SOH_WARN; } });
// State & poller
var state_1 = require("./src/state");
Object.defineProperty(exports, "startPoller", { enumerable: true, get: function () { return state_1.startPoller; } });
Object.defineProperty(exports, "readState", { enumerable: true, get: function () { return state_1.readState; } });
Object.defineProperty(exports, "snapshotEmitter", { enumerable: true, get: function () { return state_1.snapshotEmitter; } });
// Client
var client_1 = require("./src/client");
Object.defineProperty(exports, "FelicityClient", { enumerable: true, get: function () { return client_1.FelicityClient; } });
// Helpers
var helpers_1 = require("./src/helpers");
Object.defineProperty(exports, "pickNextSunrise", { enumerable: true, get: function () { return helpers_1.pickNextSunrise; } });
Object.defineProperty(exports, "nullableInt", { enumerable: true, get: function () { return helpers_1.nullableInt; } });
Object.defineProperty(exports, "nullableFloat", { enumerable: true, get: function () { return helpers_1.nullableFloat; } });
Object.defineProperty(exports, "clamp", { enumerable: true, get: function () { return helpers_1.clamp; } });
Object.defineProperty(exports, "sleep", { enumerable: true, get: function () { return helpers_1.sleep; } });
// Server (embedded / programmatic use)
var server_1 = require("./server");
Object.defineProperty(exports, "createServer", { enumerable: true, get: function () { return server_1.createServer; } });
Object.defineProperty(exports, "startServer", { enumerable: true, get: function () { return server_1.startServer; } });
