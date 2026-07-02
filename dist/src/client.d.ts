import { felicityRequest } from "./http";
import { type CacheAdapter } from "./cache";
import type { Battery } from "./battery";
import type { BatterySnapshotStore, DailySnapshotStore, BalanceTrend } from "./store";
export interface BatteriesResult {
    batteries: Battery[];
    fetchedAt: string;
    fromCache: boolean;
    trend: Record<string, BalanceTrend>;
}
export interface BatteryResult {
    battery: Battery | null;
    fetchedAt: string;
    fromCache: boolean;
}
export interface FelicityClientOptions {
    user: string;
    pass: string;
    cache?: CacheAdapter;
    ttl?: number;
    snapshotStore?: BatterySnapshotStore;
    dailySnapshotStore?: DailySnapshotStore;
    /** Internal: override HTTP transport (for testing). */
    _fetch?: typeof felicityRequest;
}
export declare class FelicityClient {
    private _user;
    private _pass;
    private _cache;
    private _ttl;
    private _fetch;
    private _token;
    private _tokenExpiry;
    private _snapshotStore;
    private _dailySnapshotStore;
    constructor({ user, pass, cache, ttl, snapshotStore, dailySnapshotStore, _fetch }: FelicityClientOptions);
    private _ensureToken;
    private _fetchAll;
    getBatteries(): Promise<BatteriesResult>;
    getBattery(id: string): Promise<BatteryResult>;
}
