import { type SnapshotEntry } from "./helpers";
import { TrendDirection } from "./enums";
import type { Battery } from "./battery";
export interface BatterySnapshot {
    ts: string;
    batteries: SnapshotEntry[];
}
export interface BalanceTrend {
    direction: TrendDirection;
    deltaChange: number;
    history: number[];
    balancingCount: number;
    snapshotCount: number;
    currentBalancingStreak: number;
}
export declare function resolveSnapshotConfig(): {
    enabled: boolean;
    ms: number;
    maxIntra: number;
    ddays: number;
};
export declare class SnapshotStore {
    protected _fileName: string;
    protected _maxSnapshots: number;
    protected _intervalMs: number;
    constructor({ fileName, maxSnapshots, intervalMs }: {
        fileName: string;
        maxSnapshots: number;
        intervalMs: number;
    });
    protected get _file(): string;
    protected _load(): BatterySnapshot[];
    protected _save(snapshots: BatterySnapshot[]): void;
    maybeAdd(batteries: Battery[]): void;
    getSnapshots(): BatterySnapshot[];
}
export declare class BatterySnapshotStore extends SnapshotStore {
    constructor();
    private _computeTrend;
    getTrend(sn: string): BalanceTrend | null;
    getAllTrends(batteries: Pick<Battery, "sn">[], snapshots?: BatterySnapshot[]): Record<string, BalanceTrend>;
}
export declare class DailySnapshotStore extends SnapshotStore {
    constructor();
}
export declare const snapshotStore: BatterySnapshotStore;
export declare const dailySnapshotStore: DailySnapshotStore;
