"use strict";

const fs   = require("fs");
const os   = require("os");
const path = require("path");
const { snapshotStore }              = require("./store");
const { hookStore }                  = require("./hooks");
const { computeHealth, computeAutonomy } = require("./compute");

const POLL_MS = parseInt(process.env.FELICITY_POLL_MS ?? "30000", 10);

function _stateFile() {
  return path.join(process.env.SNAPSHOT_DIR ?? os.tmpdir(), "felicity-state.json");
}

function _writeState(batteries, snapshots, health) {
  try {
    const trend    = snapshotStore.getAllTrends(batteries, snapshots);
    const autonomy = computeAutonomy(batteries, snapshots);
    const tmp = _stateFile() + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(
      { batteries, trend, health, autonomy, updatedAt: new Date().toISOString() },
      null, 2
    ));
    fs.renameSync(tmp, _stateFile());
  } catch (e) {
    console.error(`[fsolar] _writeState failed: ${e.message}`);
  }
}

function readState() {
  try { return JSON.parse(fs.readFileSync(_stateFile(), "utf8")); }
  catch { return null; }
}

let _tickRunning = false;

function startPoller(client) {
  async function tick() {
    if (_tickRunning) return;
    _tickRunning = true;
    try {
      const { batteries } = await client.getBatteries();
      const snapshots = snapshotStore.getSnapshots();
      const health    = computeHealth(batteries, snapshots);
      _writeState(batteries, snapshots, health);
      await hookStore.fire(batteries, health);
    } catch (err) {
      console.error(`[fsolar] tick error: ${err.message}`);
    } finally {
      _tickRunning = false;
    }
  }

  tick();
  setInterval(tick, POLL_MS);
}

module.exports = { startPoller, readState };
