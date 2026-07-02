import { EventEmitter } from "events";
import type { FelicityClient } from "./client";
import type { BatterySnapshotStore } from "./store";
import type { HookStore } from "./hooks";
import type { Battery } from "./battery";
import type { BalanceTrend } from "./store";
import type { BatteryHealth, AutonomyResult } from "./compute";
export declare const snapshotEmitter: EventEmitter;
export interface MaterializedState {
    updatedAt: string;
    batteries: Battery[];
    trend: Record<string, BalanceTrend>;
    health: Record<string, BatteryHealth>;
    autonomy: AutonomyResult;
}
export declare function readState(): Promise<MaterializedState | null>;
export declare function startPoller(client: FelicityClient, opts?: {
    snapshotStore?: BatterySnapshotStore;
    hookStore?: HookStore;
}): {
    stop(): void;
};
