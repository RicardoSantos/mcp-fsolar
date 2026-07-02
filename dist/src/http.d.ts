import crypto from "crypto";
export declare const RSA_PUB: string;
export declare const API_HOST = "shine-api.felicitysolar.com";
export declare const REQUEST_TIMEOUT_MS = 10000;
export declare const TOKEN_TTL_MS: number;
export declare function felicityRequest(method: string, urlPath: string, body?: unknown, token?: string | null): Promise<unknown>;
export { crypto };
