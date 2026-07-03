import { EventEmitter }                                from "events";
import fs   from "fs";
import os   from "os";
import path from "path";
import { snapshotStore as _defaultSnapshotStore,
         dailyEnergyStore as _defaultDailyEnergyStore } from "./store";
import { hookStore     as _defaultHookStore     }      from "./hooks";
import { computeHealth, computeAutonomy }              from "./compute";
import { computeEnergyHistory }                        from "./analyze";
import { POLL_BACKOFF_MAX_MS }                         from "./constants";
import { logger }                                      from "./logger";
import type { FelicityClient }                         from "./client";
import type { BatterySnapshotStore, DailyEnergyStore, DailyEnergy } from "./store";
import type { HookStore }                              from "./hooks";
import type { Battery }                                from "./battery";
import type { BatterySnapshot, BalanceTrend }          from "./store";
import type { BatteryHealth, AutonomyResult }          from "./compute";

const POLL_MS      = parseInt(process.env.FELICITY_POLL_MS      ?? "30000",  10);
const TELEMETRY_MS = parseInt(process.env.FELICITY_TELEMETRY_MS ?? "300000", 10);

export const snapshotEmitter: EventEmitter = new EventEmitter();

export interface MaterializedState {
  updatedAt: string;
  batteries: Battery[];
  trend:     Record<string, BalanceTrend>;
  health:    Record<string, BatteryHealth>;
  autonomy:  AutonomyResult;
}

function _stateFile(): string {
  return path.join(process.env.SNAPSHOT_DIR ?? os.tmpdir(), "felicity-state.json");
}

function _writeState(
  batteries:     Battery[],
  snapshots:     BatterySnapshot[],
  health:        Record<string, BatteryHealth>,
  snapshotStore: BatterySnapshotStore
): void {
  try {
    const trend    = snapshotStore.getAllTrends(batteries, snapshots);
    const autonomy = computeAutonomy(batteries, snapshots);
    const dest = _stateFile();
    const tmp  = dest + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(
      { batteries, trend, health, autonomy, updatedAt: new Date().toISOString() },
      null, 2
    ));
    fs.renameSync(tmp, dest);
    try { fs.chmodSync(dest, 0o600); } catch { /* Windows */ }
  } catch (e: unknown) {
    logger.error("_writeState failed", { err: (e as Error).message });
  }
}

export async function readState(): Promise<MaterializedState | null> {
  try { return JSON.parse(await fs.promises.readFile(_stateFile(), "utf8")) as MaterializedState; }
  catch { return null; }
}

export function startPoller(
  client: FelicityClient,
  opts: {
    snapshotStore?:    BatterySnapshotStore;
    dailyEnergyStore?: DailyEnergyStore;
    hookStore?:        HookStore;
    onTick?:           (err: Error | null, batteries?: Battery[]) => void;
  } = {}
): { stop(): void } {
  const snapshotStore   = opts.snapshotStore   ?? _defaultSnapshotStore;
  const dailyEnergyStore = opts.dailyEnergyStore ?? _defaultDailyEnergyStore;
  const hookStore       = opts.hookStore       ?? _defaultHookStore;
  const onTick          = opts.onTick;

  let _tickRunning       = false;
  let _consecutiveErrors = 0;
  let _backoffUntil      = 0;
  let _lastBatteries: Battery[] | null                    = null;
  let _lastHealth:    Record<string, BatteryHealth> | null = null;

  function _emitWebhookSnapshot(): void {
    if (!_lastBatteries) return;
    const payload = { batteries: _lastBatteries, health: _lastHealth ?? {}, ts: new Date().toISOString() };
    hookStore.fireSnapshot(payload).catch(() => {});
  }

  async function tick(): Promise<void> {
    if (_tickRunning) return;
    if (Date.now() < _backoffUntil) return;
    _tickRunning = true;
    try {
      const { batteries } = await client.getBatteries();
      const snapshots = snapshotStore.getSnapshots();
      const health    = computeHealth(batteries, snapshots);
      _lastBatteries     = batteries;
      _lastHealth        = health;
      _consecutiveErrors = 0;
      _backoffUntil      = 0;
      _writeState(batteries, snapshots, health, snapshotStore);
      dailyEnergyStore.update(computeEnergyHistory(snapshots) as DailyEnergy[]);
      // Emit every tick so SSE /events clients get 30 s updates
      snapshotEmitter.emit("snapshot", { batteries, health, ts: new Date().toISOString() });
      await hookStore.fire(batteries, health);
      await hookStore.retryFailed();
      onTick?.(null, batteries);
    } catch (err: unknown) {
      _consecutiveErrors++;
      const delayMs = Math.min(POLL_BACKOFF_MAX_MS, POLL_MS * Math.pow(2, _consecutiveErrors - 1));
      _backoffUntil = Date.now() + delayMs;
      onTick?.(err as Error);
      logger.error("tick error", { err: (err as Error).message, consecutiveErrors: _consecutiveErrors, backoffMs: delayMs });
    } finally {
      _tickRunning = false;
    }
  }

  tick();
  const tickInterval      = setInterval(tick, POLL_MS);
  // Webhook SNAPSHOT events fire on their own slower cadence
  const telemetryInterval = setInterval(_emitWebhookSnapshot, TELEMETRY_MS);

  return {
    stop() {
      clearInterval(tickInterval);
      clearInterval(telemetryInterval);
    },
  };
}
