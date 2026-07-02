import type { Battery } from "./battery";
export interface CacheValue {
    batteries: Battery[];
    fetchedAt: string;
}
export interface CacheAdapter {
    get(key: string): Promise<CacheValue | null>;
    set(key: string, value: CacheValue, ttlSeconds: number): Promise<void>;
}
export declare class MemoryCacheAdapter implements CacheAdapter {
    private readonly _store;
    get(key: string): Promise<CacheValue | null>;
    set(key: string, value: CacheValue, ttlSeconds: number): Promise<void>;
}
