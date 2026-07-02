import { test, after } from "node:test";
import assert from "node:assert/strict";

import { readState, startPoller, snapshotEmitter } from "../src/state";
import { FelicityClient }                          from "../src/client";

// ── readState ─────────────────────────────────────────────────────────────────

test("readState — returns null when no state file exists", async () => {
  // Point to a non-existent directory so no state file can be found.
  const orig = process.env.SNAPSHOT_DIR;
  process.env.SNAPSHOT_DIR = "/nonexistent-path-that-cannot-exist-12345";
  try {
    const s = await readState();
    assert.equal(s, null);
  } finally {
    if (orig === undefined) delete process.env.SNAPSHOT_DIR;
    else process.env.SNAPSHOT_DIR = orig;
  }
});

// ── startPoller ───────────────────────────────────────────────────────────────

function makeMockClient(batteries: unknown[] = []): FelicityClient {
  return {
    getBatteries: async () => ({ batteries, fetchedAt: new Date().toISOString(), fromCache: false, trend: {} }),
    getBattery:   async () => ({ battery: null, fetchedAt: new Date().toISOString(), fromCache: false }),
  } as unknown as FelicityClient;
}

test("startPoller — onTick called with null error on success", async () => {
  const client = makeMockClient([]);
  await new Promise<void>((resolve, reject) => {
    const poller = startPoller(client, {
      onTick: (err) => {
        poller.stop();
        if (err) reject(err);
        else resolve();
      },
    });
  });
});

test("startPoller — onTick called with error when client throws", async () => {
  const badClient = {
    getBatteries: async () => { throw new Error("network failure"); },
  } as unknown as FelicityClient;

  await new Promise<void>((resolve) => {
    const poller = startPoller(badClient, {
      onTick: (err) => {
        poller.stop();
        assert.ok(err instanceof Error);
        assert.equal(err.message, "network failure");
        resolve();
      },
    });
  });
});

test("startPoller — stop() prevents further ticks", async () => {
  let tickCount = 0;
  const client  = makeMockClient([]);
  await new Promise<void>((resolve) => {
    const poller = startPoller(client, {
      onTick: () => {
        tickCount++;
        poller.stop();
        // Wait briefly to confirm no second tick fires after stop
        setTimeout(() => {
          assert.equal(tickCount, 1);
          resolve();
        }, 200);
      },
    });
  });
});

// ── snapshotEmitter ───────────────────────────────────────────────────────────

test("snapshotEmitter — emits snapshot event on each tick", async () => {
  const client  = makeMockClient([]);
  await new Promise<void>((resolve) => {
    const handler = (payload: unknown) => {
      snapshotEmitter.off("snapshot", handler);
      poller.stop();
      assert.ok(typeof (payload as Record<string, unknown>).ts === "string", "payload.ts should be a string");
      assert.ok(Array.isArray((payload as Record<string, unknown>).batteries), "payload.batteries should be an array");
      resolve();
    };
    snapshotEmitter.on("snapshot", handler);
    const poller = startPoller(client);
  });
});

test("snapshotEmitter — payload includes health map", async () => {
  const client = makeMockClient([]);
  await new Promise<void>((resolve) => {
    const handler = (payload: unknown) => {
      snapshotEmitter.off("snapshot", handler);
      poller.stop();
      assert.ok(typeof (payload as Record<string, unknown>).health === "object", "payload.health should be an object");
      resolve();
    };
    snapshotEmitter.on("snapshot", handler);
    const poller = startPoller(client);
  });
});
