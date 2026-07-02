export declare const ChargingState: Readonly<{
    readonly CHARGING: "charging";
    readonly DISCHARGING: "discharging";
    readonly STANDBY: "standby";
}>;
export type ChargingState = typeof ChargingState[keyof typeof ChargingState];
export declare const HealthStatus: Readonly<{
    readonly OK: "ok";
    readonly WARN: "warn";
    readonly CRIT: "crit";
}>;
export type HealthStatus = typeof HealthStatus[keyof typeof HealthStatus];
export declare const TrendDirection: Readonly<{
    readonly IMPROVING: "improving";
    readonly STABLE: "stable";
    readonly DEGRADING: "degrading";
}>;
export type TrendDirection = typeof TrendDirection[keyof typeof TrendDirection];
export declare const HookEvent: Readonly<{
    readonly CELL_DELTA_CRIT: "cell_delta_crit";
    readonly CELL_DELTA_WARN: "cell_delta_warn";
    readonly TEMP_CRIT: "temp_crit";
    readonly TEMP_WARN: "temp_warn";
    readonly SOH_WARN: "soh_warn";
    readonly LOW_SOC: "low_soc";
    readonly FULL: "full";
    readonly ONLINE: "online";
    readonly OFFLINE: "offline";
    readonly SNAPSHOT: "snapshot";
}>;
export type HookEvent = typeof HookEvent[keyof typeof HookEvent];
