"use strict";

const { constants: { HTTP_STATUS_INTERNAL_SERVER_ERROR } } = require("node:http2");

class AppError extends Error {
  constructor(message, statusCode = HTTP_STATUS_INTERNAL_SERVER_ERROR) {
    super(message);
    this.name       = "AppError";
    this.statusCode = statusCode;
  }
}

module.exports = { AppError };
