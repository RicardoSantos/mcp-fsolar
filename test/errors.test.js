"use strict";

const { test } = require("node:test");
const assert   = require("node:assert/strict");
const { AppError } = require("../src/errors");
const { constants: { HTTP_STATUS_INTERNAL_SERVER_ERROR,
                     HTTP_STATUS_NOT_FOUND,
                     HTTP_STATUS_BAD_REQUEST } } = require("node:http2");

test("AppError is instanceof Error", () => {
  assert.ok(new AppError("oops") instanceof Error);
});

test("AppError is instanceof AppError", () => {
  assert.ok(new AppError("oops") instanceof AppError);
});

test("AppError.name is AppError", () => {
  assert.equal(new AppError("oops").name, "AppError");
});

test("AppError.message is set", () => {
  assert.equal(new AppError("something went wrong").message, "something went wrong");
});

test("AppError.statusCode defaults to 500", () => {
  assert.equal(new AppError("oops").statusCode, HTTP_STATUS_INTERNAL_SERVER_ERROR);
});

test("AppError.statusCode uses supplied value", () => {
  assert.equal(new AppError("not found", HTTP_STATUS_NOT_FOUND).statusCode, HTTP_STATUS_NOT_FOUND);
});

test("AppError.statusCode 400 works", () => {
  assert.equal(new AppError("bad", HTTP_STATUS_BAD_REQUEST).statusCode, HTTP_STATUS_BAD_REQUEST);
});

test("AppError has a stack trace", () => {
  assert.ok(new AppError("oops").stack);
});
