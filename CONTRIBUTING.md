# Contributing

## Branching

Work is done on short-lived topic branches. Branch names must follow:

```
<type>/<short-description>
```

| Type | When to use |
|---|---|
| `feat/` | New feature or tool |
| `fix/` | Bug fix |
| `chore/` | Tooling, deps, config — no production code change |
| `docs/` | Documentation only |
| `refactor/` | Code restructuring with no behaviour change |
| `test/` | Adding or fixing tests |

Examples: `feat/balance-trend-tool`, `fix/token-refresh-race`, `docs/cell-voltage-fields`

**Direct commits to `main` are blocked.** All changes must arrive via Pull Request.

## Commit messages

This repo follows [Conventional Commits 1.0](https://www.conventionalcommits.org/en/v1.0.0/).

```
<type>(<optional scope>): <short imperative summary>

[optional body]

[optional footer(s)]
```

Valid types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`, `perf`, `ci`, `revert`.

Use `!` or a `BREAKING CHANGE:` footer for breaking changes:

```
feat!: drop Node 16 support

BREAKING CHANGE: minimum Node version is now 18
```

Commitlint enforces this on every commit via a `commit-msg` hook. After cloning, run once to activate it:

```bash
# Standard (non-UNC path)
npm run setup

# If the repo is on a UNC share (\\server\share\...) use PowerShell directly:
git config core.hooksPath .githooks
```

### Examples

```
feat(client): add retry on 429 with exponential backoff
fix(server): prevent duplicate SSE subscribers on reconnect
chore: bump @modelcontextprotocol/sdk to 1.30.0
docs: document cellDelta field in README
test(cache): cover TTL expiry edge case
refactor(transform): extract normaliseCell helper
```

## Versioning

This package follows [Semantic Versioning 2.0](https://semver.org/):

| Change | Version bump |
|---|---|
| Breaking API or protocol change | `major` |
| New backward-compatible tool / field | `minor` |
| Bug fix, internal change | `patch` |

Release process:

1. Bump `version` in `package.json` manually
2. Add a `## [X.Y.Z] — YYYY-MM-DD` entry in `CHANGELOG.md`
3. Run `npm run build` to update `dist/`
4. Commit: `chore: bump to vX.Y.Z`
5. Push the commit and tag:

```bash
git tag vX.Y.Z
git push origin main
git push origin vX.Y.Z
```

The tag triggers the CI publish workflow — **never run `npm publish` manually**.

## Pull Requests

- One logical change per PR.
- PR title must be a valid Conventional Commit message (it becomes the squash-merge commit).
- `npm test` must pass before requesting review.
- Update the relevant section of README.md if the change affects public API, MCP tools, or configuration.
- Add a CHANGELOG entry for any user-facing change (see format below).

Use the PR template when opening a pull request — it will pre-populate the description.

## Coding conventions

### TypeScript

All source files are TypeScript (`src/*.ts`, `index.ts`, `server.ts`). The compiler is configured with `strict: true` — no implicit `any`, no unchecked nullable access.

```ts
// ✗ wrong — implicit any, raw require
const { foo } = require("./bar")
function process(data) { ... }

// ✓ correct — typed import, explicit signature
import { Foo } from "./bar"
function process(data: Foo): Result { ... }
```

Use `import type` for type-only imports to keep runtime output clean:

```ts
import type { Battery } from "./battery"
import type { BatterySnapshot } from "./store"
```

Never add `// @ts-ignore` or `as any` — fix the underlying type gap instead. If a third-party API returns `unknown`, narrow it explicitly before use.

**Build before running:** `npm run build` compiles TypeScript to `dist/`. Tests run directly against the TypeScript source via `tsx/cjs` — no build step needed for `npm test`.

### No magic numbers

Every non-obvious numeric literal must be a named constant. "Non-obvious" means a reader would have to know the hardware spec, algorithm design, or protocol to understand the value without the name.

```ts
// ✗ wrong
.filter((t) => !isNaN(t) && t < 200)
if (totalPowerW < -100) { ... }
const batLastN = batSnaps.slice(-3);

// ✓ correct
.filter((t) => !isNaN(t) && t < TEMP_SENTINEL_MAX_C)
if (totalPowerW < -MIN_ACTIVE_DISCHARGE_W) { ... }
const batLastN = batSnaps.slice(-OUTLIER_SNAP_WINDOW);
```

Numbers that are fine as literals: `0`, `1` (index/offset arithmetic), `100` (percentage denominator), `1000` (W→kW unit conversion), `2` (median index), `10`/`/ 10` (one-decimal rounding). These are universally understood and naming them adds noise.

When adding a named number constant:

1. Define it at the top of the file where it is used.
2. Export it from the module if it is useful to callers (e.g. thresholds they may want to compare against).
3. Add a row to the relevant table in `docs/ALGORITHMS.md` if it affects observable behaviour.

### No magic strings

All discriminant string values must be referenced through the enums in `src/enums.ts` — never as bare string literals. The same rule applies to any new discriminant you introduce.

```ts
// ✗ wrong
if (bat.chargingState === "discharging") { ... }

// ✓ correct
import { ChargingState } from "./enums"
if (bat.chargingState === ChargingState.DISCHARGING) { ... }
```

The four enums exported by the package:

| Enum | Values |
|---|---|
| `ChargingState` | `CHARGING`, `DISCHARGING`, `STANDBY` |
| `HealthStatus` | `OK`, `WARN`, `CRIT` |
| `TrendDirection` | `IMPROVING`, `STABLE`, `DEGRADING` |
| `HookEvent` | `CELL_DELTA_CRIT`, `CELL_DELTA_WARN`, `TEMP_CRIT`, `TEMP_WARN`, `SOH_WARN`, `LOW_SOC`, `FULL`, `ONLINE`, `OFFLINE`, `SNAPSHOT` |

Each enum is both a runtime frozen object and a TypeScript union type — the same name serves both roles:

```ts
export const ChargingState = Object.freeze({ CHARGING: "charging", ... } as const)
export type  ChargingState = typeof ChargingState[keyof typeof ChargingState]
```

When adding a new discriminant string (a new event, state, or status):

1. Add the constant to the appropriate enum in `src/enums.ts`.
2. Add the corresponding type export if introducing a new enum.
3. Use it everywhere — in production code, tests, and documentation.
4. Export it from `index.ts` (types are generated automatically — no separate `.d.ts` to update).
5. Add a row to the relevant table in `docs/ALGORITHMS.md`.

Full documentation of all enum values, their trigger conditions, and cooldowns is in [docs/ALGORITHMS.md](./docs/ALGORITHMS.md#string-enums).

### HTTP status codes

Always use `node:http2` named constants — never raw numbers. See `CLAUDE.md` for the full import pattern.

## Tests

```bash
npm test          # runs all 205 unit tests — no build step needed
```

Tests use Node's built-in test runner (`node:test`) with `tsx/cjs` as the loader so they run directly against TypeScript source. No external test framework or build step required.

Test files live in `test/` and are plain JavaScript (`.js`) — they `require("../index")` which tsx resolves to the TypeScript source at runtime:

| File | What it covers |
|---|---|
| `cache.test.js` | `MemoryCacheAdapter` TTL and key isolation |
| `client.test.js` | `FelicityClient` auth, caching, pagination |
| `compute.test.js` | `computeHealth` and `computeAutonomy` logic |
| `errors.test.js` | `AppError` shape and inheritance |
| `helpers.test.js` | `nullableInt`, `clamp`, `sleep`, `pickSnapshotFields`, `pickNextSunrise` |
| `hooks.test.js` | `HookStore` SSRF validation, cooldowns, event filtering |
| `logger.test.js` | `createLogger` JSON output format |
| `middleware.test.js` | CORS, auth, rate limit, body parsing |
| `snapshot.test.js` | `BatterySnapshotStore` trend computation |
| `transform.test.js` | `buildBattery` field mapping and edge cases |

New behaviour must be covered by a test. Write the test file in `test/`, require from `"../index"` or `"../src/module-name"`, and add it to the `test` script in `package.json`.

### Security tests

`test/security.test.js` is a live integration suite that runs against a real server process. It is not included in `npm test`:

```bash
# terminal 1 — build and start server in test mode
npm run build
FELICITY_USER=x FELICITY_PASS=y FELICITY_API_KEY=test-key FELICITY_MODE=http FELICITY_RATE_LIMIT=0 node dist/server.js

# terminal 2 — run the suite
FELICITY_API_KEY=test-key npm run test:security
```

Any change that touches authentication, CORS, rate limiting, webhook URL validation, or request body handling must be re-verified against this suite.

## CHANGELOG format

Entries live in `CHANGELOG.md` under an `## [Unreleased]` heading until release:

```markdown
## [Unreleased]

### Added
- `get_fleet_summary` now includes `warningCount` per battery (#12)

### Fixed
- Token refresh no longer races on concurrent requests (#9)

### Breaking
- Removed `rawSnapshot` field from `get_snapshots` response
```

At release time, `## [Unreleased]` is renamed to `## [X.Y.Z] — YYYY-MM-DD`.
