"use strict";

const crypto = require("crypto");
const https  = require("https");

const RSA_PUB =
  "-----BEGIN PUBLIC KEY-----\n" +
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAnAJE68pjWZmtSg6ZJs9F\n" +
  "ZugJXC6bBSluTW6mJttOLOaljrdErVnM5DNN+YFzpB9pAysTErjY1bnSVuEwQSwp\n" +
  "tnqUji7Ch2qMj2n+0eCp8p6vtSh7/tFr2ul8nDRtkoswLANAIwtUk/G85ipMpmY1\n" +
  "W642LImnEJmGkkddlbjbjxJTZWR5hc/d9cPWb+AR77LxFFrMik3c+44v1kQlIPFP\n" +
  "6EjIbOvt/Lv7fHWD9JI/YzN4y1gK7C/VQdNGuikQyNg+5W3rg9ecYf9I5uLAQwY\n" +
  "/hxeI3lbNsErebqKe2EbJ8AwcNIC0lDBz53Sq0ML89QapEuy3fB+upuctxLULVDC\n" +
  "bNwIDAQAB\n" +
  "-----END PUBLIC KEY-----";

const API_HOST           = "shine-api.felicitysolar.com";
const REQUEST_TIMEOUT_MS = 10_000;
const TOKEN_TTL_MS       = 72 * 60 * 60 * 1000;

function felicityRequest(method, urlPath, body, token) {
  const payload = body ? JSON.stringify(body) : undefined;
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: API_HOST,
        path:     urlPath,
        method,
        headers: {
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          ...(token   ? { Authorization: `Bearer_${token}` } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try { resolve(JSON.parse(data)); }
          catch { reject(new Error(`Felicity API returned non-JSON: ${data.slice(0, 120)}`)); }
        });
      }
    );
    req.setTimeout(REQUEST_TIMEOUT_MS, () => { req.destroy(new Error("Felicity API request timed out")); });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

module.exports = { RSA_PUB, API_HOST, REQUEST_TIMEOUT_MS, TOKEN_TTL_MS, felicityRequest };
