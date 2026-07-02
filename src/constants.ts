// ── Health thresholds (cell delta, temperature, SOH) ─────────────────────────
// These drive computeHealth(), computeAlerts(), and webhook events.

export const HEALTH_CELL_DELTA_WARN = 120; // mV — imbalance warning threshold
export const HEALTH_CELL_DELTA_CRIT = 200; // mV — imbalance critical threshold
export const HEALTH_TEMP_WARN       =  40; // °C — temperature warning threshold
export const HEALTH_TEMP_CRIT       =  50; // °C — temperature critical threshold
export const HEALTH_OUTLIER_MV      =  35; // mV — cell deviation below pack average → outlier
export const HEALTH_SOH_WARN        =  90; // %  — SOH below this is a warning

// ── computeHealth tuning ──────────────────────────────────────────────────────

export const OUTLIER_SNAP_WINDOW       = 3;  // consecutive discharge snapshots required for outlier flag
export const CRATE_SNAP_WINDOW         = 6;  // snapshots used for average C-rate calculation
export const NOMINAL_VOLTAGE_V         = 48; // V  — fallback pack voltage when not reported
export const MIN_POWER_FOR_CRATE_W     = 50; // W  — below this, C-rate contribution is ignored
export const DISCHARGE_DELTA_MAX_MV    = 30; // mV — cell delta cap during discharge (above = balancing noise)
export const DISCHARGE_DELTA_MIN_SNAPS = 3;  // minimum discharge samples for median discharge delta

// ── computeAutonomy tuning ────────────────────────────────────────────────────

export const MIN_ACTIVE_DISCHARGE_W  = 100; // W   — minimum total pack power to be considered discharging
export const MIN_ACTIVE_CHARGE_W     =  50; // W   — minimum total pack power to be considered charging
export const MIN_ACTIVE_BAT_W        =  50; // W   — per-battery minimum for individual autonomy estimates
export const MIN_DISCHARGE_RATE_KW   =   0.2; // kW — clamp floor for discharge rate
export const MAX_DISCHARGE_RATE_KW   =  24;   // kW — clamp ceiling for discharge rate

// ── Webhook delivery ──────────────────────────────────────────────────────────

export const HOOK_DELIVERY_TIMEOUT_MS = 8_000;           // ms  — per-attempt HTTP timeout
export const DEFAULT_HOOK_COOLDOWN_H  = 4;               // h   — cooldown when event has no specific entry
export const DELIVERY_MAX_ATTEMPTS    = 3;               // retries (exponential backoff: 1s, 2s)
export const DELIVERY_LOG_SIZE        = 50;              // per-hook delivery history entries kept in memory
export const MAX_RETRY_QUEUE          = 200;             // dead-letter entries before oldest is evicted
export const RETRY_TTL_MS             = 24 * 3_600_000; // ms — entries older than this are dropped from retry queue
export const COOLDOWN_PRUNE_MS        = 48 * 3_600_000; // ms — cooldown keys older than this are pruned

// ── Alert thresholds ──────────────────────────────────────────────────────────

export const ALERT_STALE_MIN = 30; // minutes — last BMS report older than this triggers stale_data alert

// ── Battery lifecycle ─────────────────────────────────────────────────────────

export const LFP_NOMINAL_CYCLES = 4000; // rated full-cycle count for LFP chemistry
