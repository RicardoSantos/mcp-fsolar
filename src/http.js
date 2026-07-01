"use strict";

const crypto = require("crypto");

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
const TOKEN_TTL_MS       = parseInt(process.env.FELICITY_TOKEN_TTL_H ?? "6", 10) * 3_600_000;

async function felicityRequest(method, urlPath, body, token) {
  const payload = body ? JSON.stringify(body) : undefined;
  const resp = await fetch(`https://${API_HOST}${urlPath}`, {
    method,
    headers: {
      ...(payload ? { "Content-Type": "application/json" } : {}),
      ...(token   ? { Authorization: `Bearer_${token}` }   : {}),
    },
    body:   payload,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await resp.text();
  try { return JSON.parse(text); }
  catch { throw new Error(`Felicity API returned non-JSON: ${text.slice(0, 120)}`); }
}

module.exports = { RSA_PUB, API_HOST, REQUEST_TIMEOUT_MS, TOKEN_TTL_MS, felicityRequest };
