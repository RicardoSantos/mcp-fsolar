export interface Logger {
    info(msg: string, fields?: Record<string, unknown>): void;
    warn(msg: string, fields?: Record<string, unknown>): void;
    error(msg: string, fields?: Record<string, unknown>): void;
}
export interface LoggerOptions {
    write?: (line: string) => void;
}
export declare function createLogger(opts?: LoggerOptions): Logger;
export declare const logger: Logger;
