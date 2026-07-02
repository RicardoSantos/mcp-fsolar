export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export interface LoggerOptions {
  write?: (line: string) => void;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const write = opts.write ?? ((line: string) => process.stderr.write(line + "\n"));

  function log(level: string, msg: string, fields: Record<string, unknown> = {}): void {
    write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }));
  }

  return {
    info:  (msg, fields) => log("info",  msg, fields),
    warn:  (msg, fields) => log("warn",  msg, fields),
    error: (msg, fields) => log("error", msg, fields),
  };
}

export const logger: Logger = createLogger();
