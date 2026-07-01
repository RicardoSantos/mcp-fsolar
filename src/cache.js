"use strict";

class MemoryCacheAdapter {
  constructor() { this._store = new Map(); }

  async get(key) {
    const entry = this._store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) { this._store.delete(key); return null; }
    return entry.value;
  }

  async set(key, value, ttlSeconds) {
    this._store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }
}

module.exports = { MemoryCacheAdapter };
