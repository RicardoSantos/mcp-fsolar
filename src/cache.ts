import type { Battery } from "./battery";

export interface CacheValue {
  batteries: Battery[];
  fetchedAt: string;
}

export interface CacheAdapter {
  get(key: string): Promise<CacheValue | null>;
  set(key: string, value: CacheValue, ttlSeconds: number): Promise<void>;
}

interface CacheEntry {
  value:     CacheValue;
  expiresAt: number;
}

export class MemoryCacheAdapter implements CacheAdapter {
  private readonly _store = new Map<string, CacheEntry>();

  async get(key: string): Promise<CacheValue | null> {
    const entry = this._store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) { this._store.delete(key); return null; }
    return entry.value;
  }

  async set(key: string, value: CacheValue, ttlSeconds: number): Promise<void> {
    this._store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }
}
