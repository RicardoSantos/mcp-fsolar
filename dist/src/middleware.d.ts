import http from "http";
export declare const MAX_BODY_SIZE = 65536;
export declare function makeGetAllowedOrigin(corsOrigin: string | null): (req: http.IncomingMessage) => string | null;
export declare function makeCheckAuth(apiKey: string | null): (req: http.IncomingMessage, res: http.ServerResponse) => boolean;
export declare function makeRateLimit(rateLimit: number, trustProxy: boolean): {
    checkRateLimit(req: http.IncomingMessage, res: http.ServerResponse): boolean;
    stopPurge(): void;
};
export declare function readBody(req: http.IncomingMessage): Promise<string>;
