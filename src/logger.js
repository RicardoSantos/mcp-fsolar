"use strict";

/**
 * Minimal structured JSON logger. Writes to stderr so it is safe in both
 * stdio (MCP) and HTTP modes — stdout is reserved for the MCP protocol.
 *
 * @param {object}   [opts]
 * @param {Function} [opts.write]  Override the output sink (defaults to process.stderr).
 *                                 Receives one JSON string per call (no trailing newline added by caller).
 */
function createLogger(opts = {}) {
  const write = opts.write ?? ((line) => process.stderr.write(line + "\n"));

  function log(level, msg, fields = {}) {
    write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }));
  }

  return {
    info:  (msg, fields) => log("info",  msg, fields),
    warn:  (msg, fields) => log("warn",  msg, fields),
    error: (msg, fields) => log("error", msg, fields),
  };
}

const logger = createLogger();

module.exports = { createLogger, logger };
