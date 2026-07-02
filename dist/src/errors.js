"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppError = void 0;
const node_http2_1 = require("node:http2");
const { HTTP_STATUS_INTERNAL_SERVER_ERROR } = node_http2_1.constants;
class AppError extends Error {
    constructor(message, statusCode = HTTP_STATUS_INTERNAL_SERVER_ERROR) {
        super(message);
        this.name = "AppError";
        this.statusCode = statusCode;
    }
}
exports.AppError = AppError;
