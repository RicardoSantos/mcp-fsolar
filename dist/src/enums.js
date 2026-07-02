"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HookEvent = exports.TrendDirection = exports.HealthStatus = exports.ChargingState = void 0;
exports.ChargingState = Object.freeze({
    CHARGING: "charging",
    DISCHARGING: "discharging",
    STANDBY: "standby",
});
exports.HealthStatus = Object.freeze({
    OK: "ok",
    WARN: "warn",
    CRIT: "crit",
});
exports.TrendDirection = Object.freeze({
    IMPROVING: "improving",
    STABLE: "stable",
    DEGRADING: "degrading",
});
exports.HookEvent = Object.freeze({
    CELL_DELTA_CRIT: "cell_delta_crit",
    CELL_DELTA_WARN: "cell_delta_warn",
    TEMP_CRIT: "temp_crit",
    TEMP_WARN: "temp_warn",
    SOH_WARN: "soh_warn",
    LOW_SOC: "low_soc",
    FULL: "full",
    ONLINE: "online",
    OFFLINE: "offline",
    SNAPSHOT: "snapshot",
});
