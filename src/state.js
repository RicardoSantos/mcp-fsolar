"use strict";

const { EventEmitter } = require("events");
const fs   = require("fs");
const os   = require("os");
const path = require("path");
const { snapshotStore: _defaultSnapshotStore } = require("./store");
const { hookStore:     _defaultHookStore     } = require("./hooks");
const { computeHealth, computeAutonomy }       = require("./compute");
const { logger }                               = require("./logger");

const POLL_MS      = parseInt(process.env.FELICITY_POLL_MS      ?? "30000",  10);
const TELEMETRY_MS = parseInt(process.env.FELICITY_TELEMETRY_MS ?? "300000", 10);

const snapshotEmitter = new EventEmitter();

function _stateFile() {
  return path.join(process.env.SNAPSHOT_DIR ?? os.tmpdir(), "felicity-state.json");
}

function _writeState(batteries, snapshots, health, snapshotStore) {
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
  } catch (e) {
    logger.error("_writeState failed", { err: e.message });
  }
}

async function readState() {
  try { return JSON.parse(await fs.promises.readFile(_stateFile(), "utf8")); }
  catch { return null; }
}

/**
 * Start background polling: health computation, state persistence, webhook delivery,
 * and periodic telemetry snapshots.
 *
 * @param {object} client  FelicityClient instance.
 * @param {object} [opts]
 * @param {object} [opts.snapshotStore]  Override the default snapshotStore singleton.
 * @param {object} [opts.hookStore]      Override the default hookStore singleton.
 * @returns {{ stop(): void }}  Call stop() to clear both polling intervals.
 */
function startPoller(client, opts = {}) {
  const snapshotStore = opts.snapshotStore ?? _defaultSnapshotStore;
  const hookStore     = opts.hookStore     ?? _defaultHookStore;

  let _tickRunning   = false;
  let _lastBatteries = null;
  let _lastHealth    = null;

  function _emitSnapshot() {
    if (!_lastBatteries) return;
    const payload = { batteries: _lastBatteries, health: _lastHealth, ts: new Date().toISOString() };
    snapshotEmitter.emit("snapshot", payload);
    hookStore.fireSnapshot(payload).catch(() => {});
  }

  async function tick() {
    if (_tickRunning) return;
    _tickRunning = true;
    try {
      const { batteries } = await client.getBatteries();
      const snapshots = snapshotStore.getSnapshots();
      const health    = computeHealth(batteries, snapshots);
      _lastBatteries  = batteries;
      _lastHealth     = health;
      _writeState(batteries, snapshots, health, snapshotStore);
      await hookStore.fire(batteries, health);
    } catch (err) {
      logger.error("tick error", { err: err.message });
    } finally {
      _tickRunning = false;
    }
  }

  tick();
  const tickInterval      = setInterval(tick, POLL_MS);
  const telemetryInterval = setInterval(_emitSnapshot, TELEMETRY_MS);

  return {
    stop() {
      clearInterval(tickInterval);
      clearInterval(telemetryInterval);
    },
  };
}

module.exports = { startPoller, readState, snapshotEmitter };
