#!/usr/bin/env node
"use strict";

const { MemoryCacheAdapter }                              = require("./src/cache");
const { buildBattery }                                    = require("./src/battery");
const { FelicityClient }                                  = require("./src/client");
const { SnapshotStore, BatterySnapshotStore,
        DailySnapshotStore, snapshotStore,
        dailySnapshotStore, resolveSnapshotConfig }       = require("./src/store");
const { HookStore, hookStore, HOOK_COOLDOWNS_H }          = require("./src/hooks");
const { computeHealth, computeAutonomy,
        HEALTH_CELL_DELTA_WARN, HEALTH_CELL_DELTA_CRIT,
        HEALTH_TEMP_WARN, HEALTH_TEMP_CRIT,
        HEALTH_OUTLIER_MV, HEALTH_SOH_WARN }              = require("./src/compute");
const { startPoller, readState }                          = require("./src/state");
const { ChargingState, HealthStatus, TrendDirection,
        HookEvent }                                       = require("./src/enums");

module.exports = {
  FelicityClient,
  MemoryCacheAdapter,
  SnapshotStore,
  BatterySnapshotStore,
  DailySnapshotStore,
  snapshotStore,
  dailySnapshotStore,
  hookStore,
  startPoller,
  readState,
  computeHealth,
  computeAutonomy,
  buildBattery,
  // enums
  ChargingState,
  HealthStatus,
  TrendDirection,
  HookEvent,
  // advanced / internal exports
  HookStore,
  resolveSnapshotConfig,
  HOOK_COOLDOWNS_H,
  HEALTH_CELL_DELTA_WARN,
  HEALTH_CELL_DELTA_CRIT,
  HEALTH_TEMP_WARN,
  HEALTH_TEMP_CRIT,
  HEALTH_OUTLIER_MV,
  HEALTH_SOH_WARN,
};
