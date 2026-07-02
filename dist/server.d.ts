#!/usr/bin/env node
import http from "http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FelicityClient } from "./src/client";
import { type Logger } from "./src/logger";
import type { BatterySnapshotStore } from "./src/store";
import type { HookStore } from "./src/hooks";
export interface ServerOptions {
    apiKey?: string | null;
    rateLimit?: number;
    corsOrigin?: string | null;
    trustProxy?: boolean;
    port?: number;
    snapshotStore?: BatterySnapshotStore;
    hookStore?: HookStore;
    logger?: Logger;
}
export interface ServerResult {
    httpServer: http.Server;
    mcp: InstanceType<typeof McpServer>;
    setPollError(err: Error | string | null): void;
    close(): Promise<void>;
}
export declare function createServer(client: FelicityClient, opts?: ServerOptions): ServerResult;
export declare function startServer(client: FelicityClient, opts?: ServerOptions): Promise<{
    port: number;
    url: string;
    setPollError(err: Error | string | null): void;
    close(): Promise<void>;
}>;
export declare function main(): Promise<void>;
