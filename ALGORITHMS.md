# Algorithms & Metrics

Detailed reference for every derived metric computed by this package.

---

## Cell Health (`computeHealth`)

### Cell delta status

The spread between the strongest and weakest cell in a pack — the primary indicator of imbalance.

```
cellDelta = cellVoltageMax − cellVoltageMin  (mV)
```

| Status | Condition | Meaning |
|---|---|---|
| `ok` | cellDelta < 120 mV | Normal — BMS balancing is keeping up |
| `warn` | 120 mV ≤ cellDelta < 200 mV | Elevated — monitor; balancing may be slow |
| `crit` | cellDelta ≥ 200 mV | High — BMS may be unable to balance; risk of premature cut-off |

### Temperature status

Uses the maximum temperature sensor reading across all 4 physical sensors.

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

Identifies a cell that is consistently weaker than the rest of the pack **while the battery is discharging**. Charging and standby are excluded because LiFePO4 cells naturally diverge during charging but equalize at rest — only discharge reveals genuine weakness.

**Algorithm:**
1. For each cell, compute deviation from the pack average: `dev = cellVoltage[i] − avg(cellVoltages)`
2. Flag cells where `dev < −35 mV`
3. Require the same cell to be below threshold in each of the last 3 snapshots (~30 min), and that the battery was discharging (`power < 0`) in each of those snapshots
4. Report the 1-based cell index

**Presuppostos:** Snapshots exist at 10-min intervals. Fewer than 3 snapshots → no outlier reported.

### Average C-rate

Ratio of actual power to rated power, averaged over the last 6 snapshots (~1 hour).

```
C-rate = |power_W| / (capacityAh × voltage_V)
```

Only samples where `|power| > 50 W` are included. Returns `null` if no qualifying samples exist.

---

## Autonomy (`computeAutonomy`)

Estimates how long the battery fleet can sustain the current load.

### Discharge rate

**If the battery is actively discharging** (`totalPowerW < −100 W`):
```
dischargeRateKw = |totalPowerW| / 1000
```

**Otherwise** (charging or standby — typically daytime), use the historical night average from snapshots:
```
nightSnaps = snapshots where any battery has power < −100 W
dischargeRateKw = avg(sum of |discharge power| per snapshot) / 1000
```

If no night snapshots exist, falls back to `defaultDischargeKw` (default **1.5 kW**).

Clamped to `[0.2, 24] kW`.

### Estimated hours (fleet)

```
totalCapacityKwh = packCapacityKwh  (or derived: sum of ratedEnergyKwh per battery, or remainingKwh/(soc/100))
fleetUsableKwh   = max(0, totalRemainingKwh − totalCapacityKwh × minSocPct / 100)
estimatedHours   = fleetUsableKwh / dischargeRateKw
```

### Estimated hours (per battery)

```
batCapacityKwh  = bat.ratedEnergyKwh ?? packCapacityKwh/N ?? bat.remainingKwh/(bat.soc/100)
batUsableKwh    = max(0, bat.remainingKwh − batCapacityKwh × minSocPct / 100)
batDischargeKw  = |bat.power| / 1000       if bat.power < −50 W  (actively discharging)
                  dischargeRateKw / N       otherwise (proportional share of fleet rate)
estimatedHours  = batUsableKwh / batDischargeKw
```

### SOC at sunrise

Only computed when `sunriseAt` and `packCapacityKwh` are provided. Returns `null` otherwise.

```
hoursToSunrise    = max(0, (sunriseAt − now) / 3 600 000)
discharged        = dischargeRateKw × hoursToSunrise
minKwh            = packCapacityKwh × (minSocPct / 100)      -- default minSocPct = 5
estimatedKwh      = max(minKwh, totalRemainingKwh − discharged)
estimatedSocAtSunrise = clamp(round(estimatedKwh / packCapacityKwh × 100), minSocPct, 100)
```

**Pressupostos:** Discharge rate is constant until sunrise. Does not account for temperature effects, BMS cut-off voltage curves, or grid/PV interaction.

---

## Balance Trend (`BatterySnapshotStore.getTrend`)

Computed from the intra-day snapshot history for one battery serial number.

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

## Webhook events & cooldowns

Events fired by the background poller after each successful battery fetch.

| Event | Trigger | Cooldown |
|---|---|---|
| `cell_delta_crit` | cellDelta ≥ 200 mV | 4 hours |
| `cell_delta_warn` | 120 mV ≤ cellDelta < 200 mV | 24 hours |
| `temp_crit` | tempMax ≥ 50 °C | 1 hour |
| `temp_warn` | 40 °C ≤ tempMax < 50 °C | 4 hours |
| `outlier` | ≥ 1 persistent cell outlier detected | 24 hours |
| `soh_warn` | soh < 90 % | 168 hours (7 days) |
| `low_soc` | soc ≤ `lowSocThreshold` (default 25 %) | 4 hours |

Cooldown is per `(hook, event, battery serial)` — each battery is evaluated independently. Cooldown state is persisted in `battery-hooks.json` and survives restarts.

### Webhook payload

```json
{
  "event":     "cell_delta_crit",
  "battery":   "Bat1",
  "sn":        "FSXXXXXXXX",
  "value":     215,
  "threshold": 200,
  "ts":        "2026-06-30T21:00:00.000Z"
}
```

---

## Snapshot retention

| Store | File | Interval | Max entries | Env var | Default | Limits |
|---|---|---|---|---|---|---|
| Intra-day | `battery-snapshots.json` | `FELICITY_SNAPSHOT_MS` | computed from days | `FELICITY_SNAPSHOT_DAYS` | 3 days | 1–30 days |
| Daily | `battery-daily.json` | 24 h | `FELICITY_DAILY_DAYS` | `FELICITY_DAILY_DAYS` | 90 days | 7–365 days |

`maxSnapshots = ceil(days × 24 × 60 × 60 × 1000 / intervalMs)`

Oldest entries are evicted when the limit is reached (sliding window).
