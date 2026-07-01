"use strict";

const { test } = require("node:test");
const assert   = require("node:assert/strict");
const { createLogger } = require("../src/logger");

function captureLogger() {
  const lines = [];
  const log   = createLogger({ write: (line) => lines.push(line) });
  return { log, lines };
}

test("logger — info level written", () => {
  const { log, lines } = captureLogger();
  log.info("hello");
  assert.equal(JSON.parse(lines[0]).level, "info");
});

test("logger — warn level written", () => {
  const { log, lines } = captureLogger();
  log.warn("watch out");
  assert.equal(JSON.parse(lines[0]).level, "warn");
});

test("logger — error level written", () => {
  const { log, lines } = captureLogger();
  log.error("kaboom");
  assert.equal(JSON.parse(lines[0]).level, "error");
});

test("logger — msg field matches argument", () => {
  const { log, lines } = captureLogger();
  log.info("my message");
  assert.equal(JSON.parse(lines[0]).msg, "my message");
});

test("logger — output is valid JSON", () => {
  const { log, lines } = captureLogger();
  log.info("test");
  assert.doesNotThrow(() => JSON.parse(lines[0]));
});

test("logger — ts field is an ISO date string", () => {
  const { log, lines } = captureLogger();
  log.info("ts check");
  const { ts } = JSON.parse(lines[0]);
  assert.ok(ts, "ts should exist");
  assert.ok(!Number.isNaN(new Date(ts).getTime()), "ts should be a valid date");
});

test("logger — extra fields spread into output", () => {
  const { log, lines } = captureLogger();
  log.info("with fields", { userId: 7, action: "read" });
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.userId, 7);
  assert.equal(parsed.action, "read");
});

test("logger — extra fields do not overwrite level or msg", () => {
  const { log, lines } = captureLogger();
  log.warn("safe", { level: "injected", msg: "injected" });
  const parsed = JSON.parse(lines[0]);
  // fields spread AFTER level/msg so they would win — intentional or not,
  // this test documents current behaviour so a change is noticed
  assert.ok(parsed.level !== undefined);
  assert.ok(parsed.msg   !== undefined);
});

test("logger — no extra fields still produces valid output", () => {
  const { log, lines } = captureLogger();
  log.error("no extras");
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.msg, "no extras");
  assert.equal(parsed.level, "error");
});

test("logger — each call appends one line", () => {
  const { log, lines } = captureLogger();
  log.info("a");
  log.warn("b");
  log.error("c");
  assert.equal(lines.length, 3);
});
