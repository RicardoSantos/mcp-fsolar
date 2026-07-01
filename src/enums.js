"use strict";

const ChargingState = Object.freeze({
  CHARGING:    "charging",
  DISCHARGING: "discharging",
  STANDBY:     "standby",
});

const HealthStatus = Object.freeze({
  OK:   "ok",
  WARN: "warn",
  CRIT: "crit",
});

const TrendDirection = Object.freeze({
  IMPROVING: "improving",
  STABLE:    "stable",
  DEGRADING: "degrading",
});

const HookEvent = Object.freeze({
  CELL_DELTA_CRIT: "cell_delta_crit",
  CELL_DELTA_WARN: "cell_delta_warn",
  TEMP_CRIT:       "temp_crit",
  TEMP_WARN:       "temp_warn",
  SOH_WARN:        "soh_warn",
  LOW_SOC:         "low_soc",
  FULL:            "full",
  ONLINE:          "online",
  OFFLINE:         "offline",
});

module.exports = { ChargingState, HealthStatus, TrendDirection, HookEvent };
