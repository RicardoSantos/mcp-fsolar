"use strict";

const { test } = require("node:test");
const assert   = require("node:assert/strict");
const { MemoryCacheAdapter } = require("../index.js");

test("miss on empty cache", async () => {
  const cache = new MemoryCacheAdapter();
  assert.equal(await cache.get("missing"), null);
});

test("hit before TTL expires", async () => {
  const cache = new MemoryCacheAdapter();
  await cache.set("k", { x: 1 }, 60);
  assert.deepEqual(await cache.get("k"), { x: 1 });
});

test("miss after TTL expires (negative TTL)", async () => {
  const cache = new MemoryCacheAdapter();
  await cache.set("k", { x: 1 }, -1); // expiresAt is already in the past
  assert.equal(await cache.get("k"), null);
});

test("expired entry is deleted from internal store", async () => {
  const cache = new MemoryCacheAdapter();
  await cache.set("k", "v", -1);
  await cache.get("k"); // triggers delete
  assert.equal(cache._store.size, 0);
});

test("different keys are independent", async () => {
  const cache = new MemoryCacheAdapter();
  await cache.set("a", 1, 60);
  await cache.set("b", 2, 60);
  assert.equal(await cache.get("a"), 1);
  assert.equal(await cache.get("b"), 2);
});

test("overwrite same key", async () => {
  const cache = new MemoryCacheAdapter();
  await cache.set("k", "first", 60);
  await cache.set("k", "second", 60);
  assert.equal(await cache.get("k"), "second");
});
