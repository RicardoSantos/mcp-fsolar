import { type BatteryHealth } from "./compute";
import type { Battery } from "./battery";
export declare const HOOK_COOLDOWNS_H: Record<string, number>;
export interface HookSubscription {
    id: string;
    url: string;
    events: string[];
    createdAt: string;
}
export interface HookDelivery {
    event: string;
    url: string;
    ok: boolean;
    status: number;
    attempts: number;
    ts: string;
}
export interface SnapshotPayload {
    batteries: Battery[];
    health: Record<string, BatteryHealth>;
    ts: string;
}
export declare class HookStore {
    private _prevBatInfo;
    private _hooks;
    private _cooldowns;
    private _deliveryLog;
    constructor();
    private _loadFromDisk;
    private _loadCooldownsFromDisk;
    private _save;
    private _saveCooldowns;
    add({ url, events, secret }: {
        url: string;
        events?: string[];
        secret?: string;
    }): HookSubscription;
    remove(id: string): boolean;
    list(): HookSubscription[];
    private _httpPost;
    private _logDelivery;
    getDeliveries(hookId: string): HookDelivery[];
    private _deliver;
    fireSnapshot(payload: SnapshotPayload): Promise<void>;
    fire(batteries: Battery[], health: Record<string, BatteryHealth>): Promise<void>;
}
export declare const hookStore: HookStore;
