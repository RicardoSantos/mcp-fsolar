/**
 * Felicity Solar cloud API probe.
 * Logs in, lists devices, pulls snapshot + realtime data for every battery.
 *
 * Usage:
 *   Fill in fsolar/.env, then:
 *   npx ts-node fsolar/probe.ts
 */

import * as crypto from "crypto";
import * as https from "https";
import * as fs from "fs";
import * as path from "path";

// Load .env from this folder
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, "utf8")
    .split("\n")
    .forEach((line) => {
      const [k, ...v] = line.split("=");
      if (k && v.length) process.env[k.trim()] = v.join("=").trim();
    });
}

const BASE = "shine-api.felicitysolar.com";

// RSA-2048 public key extracted from Fsolar-android4.0.4.apk (classes2.dex)
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

function encryptPassword(plain: string): string {
  return crypto
    .publicEncrypt(
      { key: RSA_PUB, padding: crypto.constants.RSA_PKCS1_PADDING },
      Buffer.from(plain, "utf8")
    )
    .toString("base64");
}

function request(method: "GET" | "POST", urlPath: string, body?: object, token?: string): Promise<any> {
  const payload = body ? JSON.stringify(body) : undefined;
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: BASE,
        path: urlPath,
        method,
        headers: {
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          ...(token ? { Authorization: `Bearer_${token}` } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try { resolve(JSON.parse(data)); } catch { resolve(data); }
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  const user = process.env.FELICITY_USER;
  const pass = process.env.FELICITY_PASS;
  if (!user || !pass) {
    console.error("Fill in fsolar/.env with FELICITY_USER and FELICITY_PASS");
    process.exit(1);
  }

  // 1. Login
  console.log("\n── LOGIN ──────────────────────────────────");
  const login = await request("POST", "/userlogin", {
    userName: user,
    password: encryptPassword(pass),
    version: "1.0",
  });
  console.log(JSON.stringify(login, null, 2));

  if (login.code !== 200 && login.code !== 0) {
    console.error("Login failed — check credentials in fsolar/.env");
    process.exit(1);
  }

  const rawToken: string = login.data?.token ?? login.data?.data?.token ?? login.data;
  const token = String(rawToken).replace(/^Bearer_/, "");
  console.log(`\nToken: ${token.slice(0, 30)}...`);

  // 2. List all devices
  console.log("\n── DEVICES ────────────────────────────────");
  const devList = await request("POST", "/device/list_device_all_type", { pageNum: 1, pageSize: 100 }, token);
  console.log(JSON.stringify(devList, null, 2));

  const allDevices: any[] = devList.data?.dataList ?? devList.data ?? [];
  const batteries = allDevices.filter((d: any) =>
    ["BP", "OC"].includes(d.deviceType) ||
    /BP|LV|bat/i.test(d.deviceModel ?? "")
  );
  console.log(`\nBatteries found: ${batteries.length}`);

  if (!batteries.length) {
    console.error("No batteries found — check your account has registered devices.");
    process.exit(1);
  }

  const sns: string[] = batteries.map((b: any) => b.deviceSn);

  const now = new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "");

  for (const sn of sns) {
    // 3. Snapshot
    console.log(`\n── SNAPSHOT  SN=${sn} ──────────────────────`);
    const snap = await request("POST", "/device/get_device_snapshot", { deviceSn: sn, deviceType: "BP", date_str: now }, token);
    console.log(JSON.stringify(snap, null, 2));

    // 4. Realtime
    console.log(`\n── REALTIME  SN=${sn} ──────────────────────`);
    const rt = await request("POST", "/device/get_device_realtime", { deviceSn: sn }, token);
    console.log(JSON.stringify(rt, null, 2));
  }
}

main().catch(console.error);
