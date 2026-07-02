export const ChargingState = Object.freeze({
  CHARGING:    "charging",
  DISCHARGING: "discharging",
  STANDBY:     "standby",
} as const);
export type ChargingState = typeof ChargingState[keyof typeof ChargingState];

export const HealthStatus = Object.freeze({
  OK:   "ok",
  WARN: "warn",
  CRIT: "crit",
} as const);
export type HealthStatus = typeof HealthStatus[keyof typeof HealthStatus];

export const TrendDirection = Object.freeze({
  IMPROVING: "improving",
  STABLE:    "stable",
  DEGRADING: "degrading",
} as const);
export type TrendDirection = typeof TrendDirection[keyof typeof TrendDirection];

export const HookEvent = Object.freeze({
  CELL_DELTA_CRIT:     "cell_delta_crit",
  CELL_DELTA_WARN:     "cell_delta_warn",
  TEMP_CRIT:           "temp_crit",
  TEMP_WARN:           "temp_warn",
  SOH_WARN:            "soh_warn",
  LOW_SOC:             "low_soc",
  FULL:                "full",
  ONLINE:              "online",
  OFFLINE:             "offline",
  SNAPSHOT:            "snapshot",
  OUTLIER:             "outlier",
  BMS_WARNINGS:        "bms_warnings",
  UNDERVOLTAGE_EVENTS: "undervoltage_events",
  STALE_DATA:          "stale_data",
  ALERT:               "alert",
} as const);
export type HookEvent = typeof HookEvent[keyof typeof HookEvent];
