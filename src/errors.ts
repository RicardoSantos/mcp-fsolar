import { constants } from "node:http2";

const { HTTP_STATUS_INTERNAL_SERVER_ERROR } = constants;

export class AppError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number = HTTP_STATUS_INTERNAL_SERVER_ERROR) {
    super(message);
    this.name       = "AppError";
    this.statusCode = statusCode;
  }
}
