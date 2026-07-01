# mcp-fsolar

MCP server + REST API + JS client for [Felicity Solar](https://www.felicitysolar.com) cloud battery data (`shine-api.felicitysolar.com`).

Ask Claude things like *"what's the battery SOC?"*, *"is any cell imbalanced?"*, or *"show me the cell voltages for Bat2"* — live from the Felicity cloud.

## Install

```bash
npm install -g fsolar-mcp
```

Then create a `.env` file with your credentials (see [Configuration](#configuration)) and start the server:

```bash
fsolar-mcp
```

Or run without installing:

```bash
npx fsolar-mcp
```

## Setup from source

```bash
git clone https://github.com/RicardoSantos/mcp-fsolar
cd mcp-fsolar
npm install
cp .env.example .env   # fill in your credentials
node server.js
```

## Configuration

`.env` variables:

| Variable | Required | Default | Description |
|---|---|---|---|
| `FELICITY_USER` | Yes | — | Felicity Solar account email |
| `FELICITY_PASS` | Yes | — | Felicity Solar account password |
| `FELICITY_PORT` | No | `3010` | HTTP server port (standalone) |
| `FELICITY_POLL_MS` | No | `30000` | API poll interval in ms (standalone) |
| `FELICITY_SNAPSHOT_ENABLED` | No | `true` | Enable background snapshot poller |
| `FELICITY_SNAPSHOT_MS` | No | `600000` | Snapshot interval in ms (min 60 000, max 3 600 000) |
| `FELICITY_SNAPSHOT_DAYS` | No | `3` | Days of intra-day snapshots to retain (min 1, max 30) |
| `FELICITY_DAILY_DAYS` | No | `90` | Days of daily snapshots to retain (min 7, max 365) |

## Algorithms & metrics

Detailed documentation of every derived metric (formulas, thresholds, assumptions, webhook events) is in [docs/ALGORITHMS.md](./docs/ALGORITHMS.md).

## Wire into Claude Code

After starting the server, register it:

```bash
claude mcp add felicity --transport sse http://localhost:3010/sse
```

Or add to `.claude/settings.json`:

```json
{
  "mcpServers": {
    "felicity": {
      "type": "sse",
      "url": "http://localhost:3010/sse"
    }
  }
}
```

To auto-start with Claude Code (no separate process needed):

```json
{
  "mcpServers": {
    "felicity": {
      "command": "npx",
      "args": ["fsolar-mcp"],
      "env": {
        "FELICITY_USER": "your@email.com",
        "FELICITY_PASS": "yourpassword"
      }
    }
  }
}
```

## MCP tools

| Tool | Description |
|---|---|
| `get_all_batteries` | Live status of all batteries — SOC, power, voltage, temperature, charging state |
| `get_battery` | Detailed status of one battery by alias (`Bat1`/`Bat2`/`Bat3`) or serial number |
| `get_cell_voltages` | Individual cell voltages (mV) — useful for detecting cell imbalance |
| `get_fleet_summary` | Compact health summary: total energy, worst cell delta, temperatures |
| `get_balance_trend` | Cell delta trend over the last ~60 min (improving / stable / degrading) |
| `get_snapshots` | Raw snapshots for the last ~60 min (one per ~10 min) |

## REST API

The server also exposes a plain HTTP API on the same port:

```
GET /batteries          # all batteries
GET /batteries/:id      # one battery by alias or serial number
GET /sse                # MCP SSE endpoint
```

Pass `X-Last-Fetched-At: <ISO timestamp>` to skip the cache when you already hold fresh data.

## JS client library

```js
import { FelicityClient, MemoryCacheAdapter } from './index.js'

const client = new FelicityClient({
  user: 'you@example.com',
  pass: 'yourpassword',
  cache: new MemoryCacheAdapter(),
  ttl: 30,  // seconds
})

const { batteries } = await client.getBatteries()
const { battery }   = await client.getBattery('Bat1')
```

Full TypeScript types are in `index.d.ts`.

## Probe (debug)

Dumps raw API responses for every device — useful for exploring your setup:

```bash
node probe.js
```

## How it works

The Felicity cloud API requires passwords to be RSA-encrypted (public key extracted from the Android APK). The client handles login, token refresh, and caching automatically. A background poller keeps data fresh so MCP tool calls are instant.

## Available data

### Per battery

| Field | Type | Description |
|---|---|---|
| `sn` | string | Serial number |
| `alias` | string | Human name (`Bat1`, `Bat2`, `Bat3`) |
| `model` | string | Model string from BMS |
| `status` | `NM` \| `AL` \| `FL` \| `OF` | Normal / Alarm / Fault / Offline |
| `soc` | number % | State of charge |
| `soh` | number % | State of health |
| `voltage` | number V | Pack voltage |
| `current` | number A | Pack current |
| `power` | number W | Pack power (positive = charging, negative = discharging) |
| `chargingState` | string | `charging` / `discharging` / `standby` |
| `remainingKwh` | number | Estimated remaining energy |
| `capacityAh` | number | Rated capacity (Ah) |
| `ratedEnergyKwh` | number \| null | Rated energy (kWh) |
| `isBalancing` | boolean | Active cell balancing in progress |
| `warningCount` | number | Active BMS warnings |

### Cell & temperature data

| Field | Type | Description |
|---|---|---|
| `cellVoltages` | number[] mV | All 16 cell voltages |
| `cellVoltageMin` | number \| null mV | Lowest cell voltage |
| `cellVoltageMax` | number \| null mV | Highest cell voltage |
| `cellDelta` | number \| null mV | Spread between min and max cell (imbalance indicator) |
| `minCellNum` | number \| null | 1-based index of weakest cell |
| `maxCellNum` | number \| null | 1-based index of strongest cell |
| `cellTemps` | number[] °C | 4 physical temperature sensors |
| `tempMin` | number °C | Lowest sensor reading |
| `tempMax` | number °C | Highest sensor reading |

### BMS protection limits

| Field | Type | Description |
|---|---|---|
| `chargeVoltLimit` | number \| null V | Max charge voltage |
| `dischargeVoltLimit` | number \| null V | Min discharge voltage |
| `chargeCurrLimit` | number \| null A | Max charge current |
| `dischargeCurrLimit` | number \| null A | Max discharge current |

### BMS lifecycle counters

| Field | Type | Description |
|---|---|---|
| `batCycleIndex` | number \| null | Total charge cycles |
| `batFullCount` | number \| null | Times battery reached full charge |
| `batUnderVoltageCount` | number \| null | Under-voltage events |

### Module breakdown (per battery)

Each battery exposes up to 4 `modules`, each containing:

| Field | Type | Description |
|---|---|---|
| `index` | number | Module number (1–4) |
| `cells` | number[] mV | 4 cell voltages in this module |
| `temp` | number \| null °C | Physical sensor for this module |
| `min` / `max` / `delta` | number mV | Voltage spread within the module |

### Balance trend (historical)

Computed from snapshots taken every ~10 min (up to 12 h retained):

| Field | Description |
|---|---|
| `direction` | `improving` / `stable` / `degrading` |
| `deltaChange` | mV change newest − oldest (negative = improving) |
| `history` | `cellDelta` values oldest → newest |
| `balancingCount` | Snapshots where balancing was active |
| `currentBalancingStreak` | Consecutive trailing snapshots with balancing on |

## License

MIT
