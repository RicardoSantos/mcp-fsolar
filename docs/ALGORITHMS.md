# Algorithms & Metrics

Detailed reference for every derived metric, persistence mechanism, and webhook system in this package.

---

## Cell Health (`computeHealth`)

Returns `Record<sn, BatteryHealth>` — one entry per battery serial number.

### Cell delta status

The spread between the strongest and weakest cell in a pack — the primary real-time indicator of imbalance.

```
cellDelta = cellVoltageMax − cellVoltageMin  (mV)
```

| Status | Condition | Meaning |
|---|---|---|
| `ok` | cellDelta < 120 mV | Normal — BMS balancing is keeping up |
| `warn` | 120 mV ≤ cellDelta < 200 mV | Elevated — monitor; balancing may be slow |
| `crit` | cellDelta ≥ 200 mV | High — BMS may be unable to balance; risk of premature cut-off |

### Discharge delta (`dischargeDelta`)

A more reliable health indicator than live `cellDelta`. LiFePO4 cells diverge at the top of charge because the BMS is actively balancing — that spread does not reflect true cell health. During discharge, cells should track each other closely; persistent divergence indicates genuine cell weakness.

**Algorithm:**
1. From the snapshot history, select samples where the battery was discharging (`power < 0`) and the recorded `cellDelta` was below 30 mV (discharge phase, not top-of-charge noise)
2. Compute the **median** of those `cellDelta` values
3. Returns `null` if fewer than 3 qualifying snapshots exist

```
dischargeDelta = median({ snap.cellDelta | snap.power < 0 AND snap.cellDelta < 30 mV })
```

Use `dischargeDelta` (when available) in preference to `cellDelta` for health classification. `cellDelta` remains useful as a real-time alarm threshold.

### Temperature status

Uses the maximum temperature sensor reading across all 4 physical sensors (3276.7 °C sentinel filtered out).

| Status | Condition |
|---|---|
| `ok` | tempMax < 40 °C |
| `warn` | 40 °C ≤ tempMax < 50 °C |
| `crit` | tempMax ≥ 50 °C |

### SOH status

State of Health as reported by the BMS.

| Status | Condition |
|---|---|
| `ok` | soh ≥ 90 % |
| `warn` | soh < 90 % |

### Persistent cell outlier detection

Identifies a cell that is consistently weaker than the rest of the pack across the last 3 discharge snapshots. The gate is applied per snapshot, not on the live state — a poller tick during standby does not clear a previously detected outlier.

**Algorithm:**
1. For each cell in the live reading, compute deviation: `dev = cellVoltage[i] − avg(cellVoltages)`
2. Flag cells where `dev < −35 mV`
3. For each flagged cell, verify across the last 3 snapshots that the same cell was below −35 mV from the snapshot average **and** that the battery was discharging (`power < 0`) in that snapshot
4. Report 1-based cell indices that satisfy all 3 checks

Requires at least 3 snapshots. Returns `[]` otherwise.

### Average C-rate (`avgCRate`)

Ratio of actual power to rated power, averaged over the last 6 snapshots (~1 hour).

```
ratedW   = capacityAh × voltage_V
C-rate   = |power_W| / ratedW
avgCRate = mean(C-rates) over last 6 snapshots where |power| > 50 W
```

Returns `null` if no qualifying samples exist.

---

## Autonomy (`computeAutonomy`)

Returns `AutonomyResult` with fleet totals and a per-battery breakdown.

### Discharge rate

**If actively discharging** (`totalPowerW < −100 W`):
```
dischargeRateKw = |totalPowerW| / 1000
```

**Otherwise** (charging or standby — typically daytime), use the historical night average from snapshots:
```
nightSnaps      = snapshots where any battery has power < −100 W
dischargeRateKw = avg(sum of |discharge power| per snapshot) / 1000
```

Falls back to `defaultDischargeKw` (default **1.5 kW**) if no night snapshots exist.
Clamped to `[0.2, 24] kW`.

### Fleet — hours until `minSocPct` (discharge)

```
totalCapacityKwh = packCapacityKwh  (opt)
                   ?? sum(bat.ratedEnergyKwh ?? bat.remainingKwh / (bat.soc / 100))
fleetUsableKwh   = max(0, totalRemainingKwh − totalCapacityKwh × minSocPct / 100)
estimatedHours   = round(fleetUsableKwh / dischargeRateKw, 1)
```

Default `minSocPct` = **5 %**.

### Fleet — hours until full (charge)

Only computed when `totalPowerW > 50 W` and `avgSoc < 100 %`.

```
avgSoc               = mean(bat.soc)
remainingToFull      = totalCapacityKwh × (1 − avgSoc / 100)
estimatedHoursToFull = round(remainingToFull / (totalPowerW / 1000), 1)
```

Returns `null` if not charging.

### Per-battery — hours until `minSocPct`

```
batCapacityKwh  = bat.ratedEnergyKwh ?? packCapacityKwh/N ?? bat.remainingKwh/(bat.soc/100)
batUsableKwh    = max(0, bat.remainingKwh − batCapacityKwh × minSocPct / 100)
batDischargeKw  = |bat.power| / 1000        if bat.power < −50 W  (own discharge rate)
                  dischargeRateKw / N        otherwise (proportional share of fleet rate)
estimatedHours  = round(batUsableKwh / batDischargeKw, 1)
```

### Per-battery — hours until full

```
batEstimatedHoursToFull = round((batCapacityKwh × (1 − bat.soc/100)) / (bat.power/1000), 1)
                          if bat.power > 50 W AND bat.soc < 100
                          null otherwise
```

### SOC at sunrise

Only computed when `sunriseAt` is provided and capacity can be determined. Returns `null` otherwise.

Capacity is resolved in order:
1. `packCapacityKwh` option (explicit override)
2. `bat.ratedEnergyKwh` from the Felicity API (`ratedEnergy` field in the snapshot)
3. Derived per battery: `bat.remainingKwh / (bat.soc / 100)` when `soc > 0`

```
totalCapacityKwh      = packCapacityKwh
                        ?? sum(bat.ratedEnergyKwh ?? bat.remainingKwh / (bat.soc / 100))

hoursToSunrise        = max(0, (sunriseAt − now) / 3_600_000)
discharged            = dischargeRateKw × hoursToSunrise
minKwh                = totalCapacityKwh × (minSocPct / 100)
estimatedKwh          = max(minKwh, totalRemainingKwh − discharged)
estimatedSocAtSunrise = clamp(round(estimatedKwh / totalCapacityKwh × 100), minSocPct, 100)
```

**Assumptions:** Constant discharge rate until sunrise. Does not model temperature effects, BMS cut-off curves, or PV/grid interaction.

---

## Balance Trend (`BatterySnapshotStore.getTrend`)

Computed from the intra-day snapshot history for one battery.

```
deltaChange = cellDelta[newest] − cellDelta[oldest]   (mV)

direction:
  deltaChange < −3 mV → "improving"
  deltaChange >  +3 mV → "degrading"
  otherwise            → "stable"
```

`balancingCount` — number of snapshots where `isBalancing = true`.
`currentBalancingStreak` — consecutive trailing snapshots with `isBalancing = true`.

Requires at least 2 snapshots with non-null `cellDelta`. Returns `null` otherwise.

---

## Snapshot stores

### Intra-day (`battery-snapshots.json`)

One entry every `FELICITY_SNAPSHOT_MS` ms (default 10 min). Used by `computeHealth`, `computeAutonomy`, and balance trend.

```
maxSnapshots = ceil(FELICITY_SNAPSHOT_DAYS × 24 × 60 × 60 × 1000 / FELICITY_SNAPSHOT_MS)
```

Oldest entries are evicted when the limit is reached (sliding window). Writes are atomic: `.tmp` + `renameSync`.

### Daily (`battery-daily.json`)

One entry per calendar day (24 h interval). Retained for `FELICITY_DAILY_DAYS` days. Useful for long-term SOH and delta trend analysis.

### Materialized state (`battery-state.json`)

Written by the background poller on every successful tick. Contains pre-computed `health`, `autonomy`, `trends`, and `fleet` summary — consumers call `readState()` for zero-latency reads without recomputing.

```ts
readState(): MaterializedState | null
// → { updatedAt, batteries, trends, health, autonomy, fleet }
```

### Persistence path

All JSON files are written to `SNAPSHOT_DIR` (default `os.tmpdir()`). **Use a persistent Docker volume** to survive container restarts.

---

## Webhook system (`HookStore`)

The background poller evaluates health on every successful tick and fires HTTP POST webhooks when conditions are met. Subscriptions are persisted in `battery-hooks.json` and survive restarts. Cooldown state is stored per `(subscription id, event, battery serial)`.

### REST management API

| Method | Path | Description |
|---|---|---|
| `GET` | `/hooks` | List all active subscriptions |
| `POST` | `/hooks` | Register a new subscription |
| `DELETE` | `/hooks/:id` | Remove a subscription |

**Register a hook:**
```http
POST /hooks
Content-Type: application/json

{
  "url":    "https://example.com/webhook",
  "events": ["cell_delta_crit", "low_soc"],
  "params": { "lowSocThreshold": 20 }
}
```

`events` — optional array; omit to subscribe to all events.
`params.lowSocThreshold` — SOC % threshold for the `low_soc` event (default **25 %**).

### Events & cooldowns

| Event | Trigger | Cooldown | `value` in payload |
|---|---|---|---|
| `cell_delta_crit` | cellDelta ≥ 200 mV | 4 h | cellDelta (mV) |
| `cell_delta_warn` | 120 mV ≤ cellDelta < 200 mV | 24 h | cellDelta (mV) |
| `temp_crit` | tempMax ≥ 50 °C | 1 h | tempMax (°C) |
| `temp_warn` | 40 °C ≤ tempMax < 50 °C | 4 h | tempMax (°C) |
| `outlier` | ≥ 1 persistent cell outlier detected | 24 h | outlier cell indices |
| `soh_warn` | soh < 90 % | 168 h (7 days) | soh (%) |
| `low_soc` | soc ≤ `lowSocThreshold` | 4 h | soc (%) |

### Webhook payload

```json
{
  "event":     "cell_delta_crit",
  "battery":   "Bat1",
  "sn":        "FSXXXXXXXX",
  "value":     215,
  "threshold": 200,
  "ts":        "2026-07-01T02:00:00.000Z"
}
```

### Bridging hooks to other notification channels

The package fires generic HTTP webhooks. To route alerts into a Web Push / email / SMS system, register a hook pointing to a receiver endpoint in the consuming application:

```
POST /hooks  →  { "url": "https://your-app/api/battery-hook-receiver" }
```

The receiver maps the `event` field to the appropriate notification call. This eliminates the need for polling-based health-check routes in the consuming app.

---

## Environment variables

### Required

| Variable | Description |
|---|---|
| `FELICITY_USER` | Felicity account email |
| `FELICITY_PASS` | Felicity account password (RSA-encrypted before transmission) |

### Server (`server.js`)

| Variable | Default | Description |
|---|---|---|
| `FELICITY_PORT` | `3010` | HTTP + MCP SSE listen port |
| `FELICITY_POLL_MS` | `30000` | Live battery poll interval (ms); also sets the in-memory cache TTL |

### Snapshot poller

| Variable | Default | Range | Description |
|---|---|---|---|
| `FELICITY_SNAPSHOT_ENABLED` | `true` | `true` / `false` | Enable/disable the background snapshot + webhook poller |
| `FELICITY_SNAPSHOT_MS` | `600000` (10 min) | 60 000 – 3 600 000 | Intra-day snapshot interval (ms) |
| `FELICITY_SNAPSHOT_DAYS` | `3` | 1 – 30 | Intra-day snapshot retention window (days) |
| `FELICITY_DAILY_DAYS` | `90` | 7 – 365 | Daily snapshot retention (days) |

### Persistence

| Variable | Default | Description |
|---|---|---|
| `SNAPSHOT_DIR` | `os.tmpdir()` | Directory for all JSON persistence files: `battery-snapshots.json`, `battery-daily.json`, `battery-state.json`, `battery-hooks.json`. Mount a Docker volume here for durability. |

---

## Named constants reference

All non-obvious numeric literals in the package are named constants. This table is the authoritative reference; the source of truth is the constant definition in `src/`.

### Hardware — `src/battery.js`

| Constant | Value | Unit | Meaning |
|---|---|---|---|
| `BMS_CHARGING_REG` | `1` | register | `bmsChargingState` value → charging |
| `BMS_DISCHARGING_REG` | `2` | register | `bmsChargingState` value → discharging |
| `BMS_BALANCING_BIT` | `64` | bitmask | Bit 6 of `bmsState` — BMS is actively balancing cells |
| `CELL_COUNT` | `16` | cells | Total cells per pack (4 modules × 4 cells) |
| `MODULE_COUNT` | `4` | — | Modules per pack |
| `CELLS_PER_MODULE` | `4` | cells | Cells per module |
| `DEFAULT_CAPACITY_AH` | `314` | Ah | Fallback pack capacity when the API omits `battCapacity` |
| `TEMP_SENTINEL_MAX_C` | `200` | °C | Felicity outputs 3 276.7 for missing temp sensors; readings ≥ 200 °C are discarded |

### `computeHealth` — `src/compute.js`

| Constant | Value | Unit | Meaning |
|---|---|---|---|
| `HEALTH_CELL_DELTA_WARN` | `120` | mV | Cell delta warn threshold |
| `HEALTH_CELL_DELTA_CRIT` | `200` | mV | Cell delta critical threshold |
| `HEALTH_TEMP_WARN` | `40` | °C | Temperature warn threshold |
| `HEALTH_TEMP_CRIT` | `50` | °C | Temperature critical threshold |
| `HEALTH_OUTLIER_MV` | `35` | mV | A cell this far below pack avg is a candidate outlier |
| `HEALTH_SOH_WARN` | `90` | % | SOH warn threshold |
| `OUTLIER_SNAP_WINDOW` | `3` | snapshots | Number of recent snapshots checked to confirm a persistent outlier |
| `CRATE_SNAP_WINDOW` | `6` | snapshots | Number of recent snapshots averaged for C-rate estimate |
| `NOMINAL_VOLTAGE_V` | `48` | V | LiFePO4 4S nominal voltage — fallback when live voltage is unavailable |
| `MIN_POWER_FOR_CRATE_W` | `50` | W | Minimum \|power\| for a snapshot to contribute to C-rate average |
| `DISCHARGE_DELTA_MAX_MV` | `30` | mV | Max cellDelta for a snapshot to qualify for discharge-delta median |
| `DISCHARGE_DELTA_MIN_SNAPS` | `3` | snapshots | Min qualifying snapshots required to compute discharge-delta median |

### `computeAutonomy` — `src/compute.js`

| Constant | Value | Unit | Meaning |
|---|---|---|---|
| `MIN_ACTIVE_DISCHARGE_W` | `100` | W | Fleet \|power\| must exceed this to use live rate instead of historical average |
| `MIN_ACTIVE_CHARGE_W` | `50` | W | Fleet power must exceed this to compute `estimatedHoursToFull` |
| `MIN_ACTIVE_BAT_W` | `50` | W | Per-battery \|power\| must exceed this to use live rate instead of fleet-average |
| `MIN_DISCHARGE_RATE_KW` | `0.2` | kW | Clamp floor for discharge rate estimate |
| `MAX_DISCHARGE_RATE_KW` | `24` | kW | Clamp ceiling for discharge rate estimate |

### Balance trend — `src/store.js`

| Constant | Value | Unit | Meaning |
|---|---|---|---|
| `TREND_STABLE_MV` | `3` | mV | Dead-band: if delta change is within ±3 mV the trend is `"stable"` |

### Webhook delivery — `src/hooks.js`

| Constant | Value | Unit | Meaning |
|---|---|---|---|
| `HOOK_DELIVERY_TIMEOUT_MS` | `8 000` | ms | Per-request timeout for HTTP webhook delivery |
| `DEFAULT_COOLDOWN_H` | `4` | h | Cooldown applied when an event is not listed in `HOOK_COOLDOWNS_H` |

---

## String enums

All discriminant strings used in public APIs are exported as frozen objects from the package. Use the constants instead of bare strings to get autocomplete and catch typos at compile time.

```js
import { ChargingState, HealthStatus, TrendDirection, HookEvent } from 'fsolar-mcp'
```

### `ChargingState`

Values produced by `Battery.chargingState`. Derived from `bmsChargingState` register (1 = charging, 2 = discharging, anything else = standby).

| Constant | Value | Meaning |
|---|---|---|
| `ChargingState.CHARGING` | `"charging"` | BMS register = 1 — battery is accepting charge current |
| `ChargingState.DISCHARGING` | `"discharging"` | BMS register = 2 — battery is supplying load current |
| `ChargingState.STANDBY` | `"standby"` | Any other BMS state — no significant current flow |

### `HealthStatus`

Severity level produced by `computeHealth()` for cell delta, temperature, and SOH checks. SOH only reaches `WARN`, never `CRIT`.

| Constant | Value | Meaning |
|---|---|---|
| `HealthStatus.OK` | `"ok"` | Below warning threshold |
| `HealthStatus.WARN` | `"warn"` | Above warning threshold, below critical |
| `HealthStatus.CRIT` | `"crit"` | Above critical threshold — immediate attention recommended |

### `TrendDirection`

Direction produced by `BatterySnapshotStore.getTrend()` / `getAllTrends()`. Computed from the change in cell delta (mV) between the oldest and newest snapshot in the window.

| Constant | Value | Condition | Meaning |
|---|---|---|---|
| `TrendDirection.IMPROVING` | `"improving"` | `deltaChange < −3 mV` | Cell spread narrowing — balancing is working |
| `TrendDirection.STABLE` | `"stable"` | `−3 mV ≤ deltaChange ≤ +3 mV` | No significant change |
| `TrendDirection.DEGRADING` | `"degrading"` | `deltaChange > +3 mV` | Cell spread widening — investigate |

### `HookEvent`

Event identifiers used in webhook subscriptions and payloads. Pass one or more in the `events` array when registering a hook; omit the array to receive all events.

| Constant | Value | Trigger condition | Default cooldown |
|---|---|---|---|
| `HookEvent.CELL_DELTA_CRIT` | `"cell_delta_crit"` | `cellDelta ≥ 200 mV` | 1 h |
| `HookEvent.CELL_DELTA_WARN` | `"cell_delta_warn"` | `cellDelta ≥ 120 mV` | 4 h |
| `HookEvent.TEMP_CRIT` | `"temp_crit"` | `tempMax ≥ 50 °C` | 1 h |
| `HookEvent.TEMP_WARN` | `"temp_warn"` | `tempMax ≥ 40 °C` | 4 h |
| `HookEvent.SOH_WARN` | `"soh_warn"` | `soh < 90 %` | 24 h |
| `HookEvent.LOW_SOC` | `"low_soc"` | _(reserved — not yet fired)_ | 2 h |
| `HookEvent.FULL` | `"full"` | _(reserved — not yet fired)_ | 8 h |
| `HookEvent.ONLINE` | `"online"` | _(reserved — not yet fired)_ | 1 h |
| `HookEvent.OFFLINE` | `"offline"` | _(reserved — not yet fired)_ | 1 h |

Cooldowns are per `(hook id, event, battery SN)` triple and persisted in `battery-hook-cooldowns.json`.
