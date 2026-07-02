"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.crypto = exports.TOKEN_TTL_MS = exports.REQUEST_TIMEOUT_MS = exports.API_HOST = exports.RSA_PUB = void 0;
exports.felicityRequest = felicityRequest;
const crypto_1 = __importDefault(require("crypto"));
exports.crypto = crypto_1.default;
exports.RSA_PUB = Buffer.from("LS0tLS1CRUdJTiBQVUJMSUMgS0VZLS0tLS0KTUlJQklqQU5CZ2txaGtpRzl3MEJBUUVGQUFPQ0FROEFNSUlCQ2dLQ0FRRUFuQUpFNjhwaldabXRTZzZaSnM5RgpadWdKWEM2YkJTbHVUVzZtSnR0T0xPYWxqcmRFclZuTTVETk4rWUZ6cEI5cEF5c1RFcmpZMWJuU1Z1RXdRU3dwCnRucVVqaTdDaDJxTWoybiswZUNwOHA2dnRTaDcvdEZyMnVsOG5EUnRrb3N3TEFOQUl3dFVrL0c4NWlwTXBtWTEKVzY0MkxJbW5FSm1Ha2tkZGxiamJqeEpUWldSNWhjL2Q5Y1BXYitBUjc3THhGRnJNaWszYys0NHYxa1FsSVBGUAo2RWpJYk92dC9MdjdmSFdEOUpJL1l6TjR5MWdLN0MvVlFkTkd1aWtReU5nKzVXM3JnOWVjWWY5STV1TEFRd1kKL2h4ZUkzbGJOc0VyZWJxS2UyRWJKOEF3Y05JQzBsREJ6NTNTcTBNTDg5UWFwRXV5M2ZCK3VwdWN0eExVTFZEQwpiTndJREFRQUIKLS0tLS1FTkQgUFVCTElDIEtFWS0tLS0t", "base64").toString();
exports.API_HOST = "shine-api.felicitysolar.com";
exports.REQUEST_TIMEOUT_MS = 10000;
exports.TOKEN_TTL_MS = parseInt(process.env.FELICITY_TOKEN_TTL_H ?? "6", 10) * 3600000;
async function felicityRequest(method, urlPath, body, token) {
    const payload = body ? JSON.stringify(body) : undefined;
    const resp = await fetch(`https://${exports.API_HOST}${urlPath}`, {
        method,
        headers: {
            ...(payload ? { "Content-Type": "application/json" } : {}),
            ...(token ? { Authorization: `Bearer_${token}` } : {}),
        },
        body: payload,
        signal: AbortSignal.timeout(exports.REQUEST_TIMEOUT_MS),
    });
    const text = await resp.text();
    try {
        return JSON.parse(text);
    }
    catch {
        throw new Error(`Felicity API returned non-JSON: ${text.slice(0, 120)}`);
    }
}
