"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.logger = void 0;
exports.createLogger = createLogger;
function createLogger(opts = {}) {
    const write = opts.write ?? ((line) => process.stderr.write(line + "\n"));
    function log(level, msg, fields = {}) {
        write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }));
    }
    return {
        info: (msg, fields) => log("info", msg, fields),
        warn: (msg, fields) => log("warn", msg, fields),
        error: (msg, fields) => log("error", msg, fields),
    };
}
exports.logger = createLogger();
