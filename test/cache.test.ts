import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryCacheAdapter, type CacheValue } from "../index";

test("miss on empty cache", async () => {
  const cache = new MemoryCacheAdapter();
  assert.equal(await cache.get("missing"), null);
});

test("hit before TTL expires", async () => {
  const cache = new MemoryCacheAdapter();
  await cache.set("k", { x: 1 } as unknown as CacheValue, 60);
  assert.deepEqual(await cache.get("k"), { x: 1 });
});

test("miss after TTL expires (negative TTL)", async () => {
  const cache = new MemoryCacheAdapter();
  await cache.set("k", { x: 1 } as unknown as CacheValue, -1);
  assert.equal(await cache.get("k"), null);
});

test("expired entry is deleted from internal store", async () => {
  const cache = new MemoryCacheAdapter();
  await cache.set("k", "v" as unknown as CacheValue, -1);
  await cache.get("k");
  assert.equal((cache as unknown as { _store: Map<string, unknown> })._store.size, 0);
});

test("different keys are independent", async () => {
  const cache = new MemoryCacheAdapter();
  await cache.set("a", 1 as unknown as CacheValue, 60);
  await cache.set("b", 2 as unknown as CacheValue, 60);
  assert.equal(await cache.get("a"), 1);
  assert.equal(await cache.get("b"), 2);
});

test("overwrite same key", async () => {
  const cache = new MemoryCacheAdapter();
  await cache.set("k", "first"  as unknown as CacheValue, 60);
  await cache.set("k", "second" as unknown as CacheValue, 60);
  assert.equal(await cache.get("k"), "second");
});
