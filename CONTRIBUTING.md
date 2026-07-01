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

```bash
npm version patch   # or minor / major
git push --follow-tags
```

`npm version` updates `package.json`, creates a commit (`chore(release): vX.Y.Z`), and tags it. The tag triggers the publish workflow.

## Pull Requests

- One logical change per PR.
- PR title must be a valid Conventional Commit message (it becomes the squash-merge commit).
- `npm test` must pass before requesting review.
- Update the relevant section of README.md if the change affects public API, MCP tools, or configuration.
- Add a CHANGELOG entry for any user-facing change (see format below).

Use the PR template when opening a pull request — it will pre-populate the description.

## Coding conventions

### No magic numbers

Every non-obvious numeric literal must be a named constant. "Non-obvious" means a reader would have to know the hardware spec, algorithm design, or protocol to understand the value without the name.

```js
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

1. Define it at the top of the file where it is used, with a `// unit — reason` comment.
2. Export it from the module if it is useful to callers (e.g. thresholds they may want to compare against).
3. Add a row to the relevant table in `docs/ALGORITHMS.md` if it affects observable behaviour.

### No magic strings

All discriminant string values must be referenced through the enums in `src/enums.js` — never as bare string literals. The same rule applies to any new discriminant you introduce.

```js
// ✗ wrong
if (bat.chargingState === "discharging") { ... }

// ✓ correct
const { ChargingState } = require("./enums");
if (bat.chargingState === ChargingState.DISCHARGING) { ... }
```

The four enums exported by the package:

| Enum | Values |
|---|---|
| `ChargingState` | `CHARGING`, `DISCHARGING`, `STANDBY` |
| `HealthStatus` | `OK`, `WARN`, `CRIT` |
| `TrendDirection` | `IMPROVING`, `STABLE`, `DEGRADING` |
| `HookEvent` | `CELL_DELTA_CRIT`, `CELL_DELTA_WARN`, `TEMP_CRIT`, `TEMP_WARN`, `SOH_WARN`, `LOW_SOC`, `FULL`, `ONLINE`, `OFFLINE` |

When adding a new discriminant string (a new event, state, or status):

1. Add the constant to the appropriate enum in `src/enums.js`.
2. Use it everywhere — in production code, tests, and documentation.
3. Export it from `index.js` and declare it in `index.d.ts`.
4. Add a row to the relevant table in `docs/ALGORITHMS.md`.

Full documentation of all enum values, their trigger conditions, and cooldowns is in [docs/ALGORITHMS.md](./docs/ALGORITHMS.md#string-enums).

## Tests

```bash
npm test          # runs all tests under test/
```

Tests use Node's built-in test runner (`node:test`). No external test framework is needed. New behaviour must be covered by tests.

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
