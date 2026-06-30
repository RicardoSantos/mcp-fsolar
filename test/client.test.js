"use strict";

const { test } = require("node:test");
const assert   = require("node:assert/strict");
const { FelicityClient, MemoryCacheAdapter } = require("../index.js");

// ── Fixtures ──────────────────────────────────────────────────────────────────

const LOGIN_OK = { code: 200, data: { token: "test-jwt-abc" } };

const DEVICE_LIST = {
  code: 200,
  data: {
    dataList: [
      { deviceSn: "SN001", alias: "Bat1", deviceType: "BP", deviceModel: "MOD", status: "NM", battSoc: "80", bmsPower: "0", battCapacity: "314", wifiSignal: "-60" },
      { deviceSn: "SN002", alias: "Bat2", deviceType: "BP", deviceModel: "MOD", status: "NM", battSoc: "75", bmsPower: "0", battCapacity: "314", wifiSignal: "-60" },
    ],
  },
};

const SNAP = {
  code: 200,
  data: {
    battSoc: "80", battSoh: "99", battVolt: "51.2", battCurr: "5",
    bmsPower: "256", bmsChargingState: 1,
    tempMax: "35", tempMin: "30", cellTempList: [30, 32, 34, 35],
    bmsVoltageList: Array(16).fill("3250"),
    maxVoltageNum2bms: "1", minVoltageNum2bms: "1",
    bmsState: "0", warningCount: "0", batCycleIndex: "100", batFullCount: "40",
    batUnderVoltageCount: "0", remainingBatteryEnergy1: "8",
    dataTimeStr: "2026-06-30 12:00:00", reportFreq: "60", wifiSignal: "-60",
  },
};

function routingMock(overrides = {}) {
  return async (method, urlPath) => {
    if (urlPath in overrides) return overrides[urlPath];
    if (urlPath === "/userlogin")                    return LOGIN_OK;
    if (urlPath === "/device/list_device_all_type")  return DEVICE_LIST;
    if (urlPath === "/device/get_device_snapshot")   return SNAP;
    throw new Error(`Unexpected URL: ${urlPath}`);
  };
}

function makeClient(overrides = {}, extra = {}) {
  return new FelicityClient({ user: "u@test.com", pass: "pass", _fetch: routingMock(overrides), ...extra });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("getBatteries throws when user is empty", async () => {
  const c = new FelicityClient({ user: "", pass: "x", cache: new MemoryCacheAdapter() });
  await assert.rejects(() => c.getBatteries(), /required/);
});

test("getBatteries throws when pass is empty", async () => {
  const c = new FelicityClient({ user: "x", pass: "", cache: new MemoryCacheAdapter() });
  await assert.rejects(() => c.getBatteries(), /required/);
});

test("getBatteries returns sorted array", async () => {
  const { batteries, fromCache } = await makeClient().getBatteries();
  assert.equal(batteries.length, 2);
  assert.equal(batteries[0].alias, "Bat1");
  assert.equal(batteries[1].alias, "Bat2");
  assert.equal(fromCache, false);
});

test("getBatteries returns fromCache on second call", async () => {
  let fetchCalls = 0;
  const client = new FelicityClient({
    user: "u", pass: "p", ttl: 60,
    _fetch: async (m, path) => { fetchCalls++; return routingMock()(m, path); },
  });
  await client.getBatteries();
  const callsAfterFirst = fetchCalls;
  const { fromCache } = await client.getBatteries();
  assert.equal(fromCache, true);
  assert.equal(fetchCalls, callsAfterFirst); // no new network calls
});

test("getBatteries includes fetchedAt timestamp", async () => {
  const { fetchedAt } = await makeClient().getBatteries();
  assert.ok(typeof fetchedAt === "string");
  assert.ok(!isNaN(Date.parse(fetchedAt)));
});

test("getBattery finds by alias (case-insensitive)", async () => {
  const { battery } = await makeClient().getBattery("bat1");
  assert.ok(battery);
  assert.equal(battery.alias, "Bat1");
  assert.equal(battery.sn, "SN001");
});

test("getBattery finds by serial number", async () => {
  const { battery } = await makeClient().getBattery("SN002");
  assert.ok(battery);
  assert.equal(battery.alias, "Bat2");
});

test("getBattery returns null for unknown id", async () => {
  const { battery } = await makeClient().getBattery("unknown");
  assert.equal(battery, null);
});

test("getBatteries throws on login failure", async () => {
  const client = makeClient({ "/userlogin": { code: 401, message: "Unauthorized" } });
  await assert.rejects(() => client.getBatteries(), /login failed/i);
});

test("getBatteries throws on device list failure", async () => {
  const client = makeClient({ "/device/list_device_all_type": { code: 500, message: "Server error" } });
  await assert.rejects(() => client.getBatteries(), /Device list failed/i);
});

test("token is reused within expiry window", async () => {
  let loginCalls = 0;
  const fetch = async (m, path, body) => {
    if (path === "/userlogin") { loginCalls++; return LOGIN_OK; }
    return routingMock()(m, path, body);
  };
  const client = new FelicityClient({ user: "u", pass: "p", _fetch: fetch });
  await client.getBatteries();
  await client.getBatteries(); // second call — token already valid
  assert.equal(loginCalls, 1);
});

test("non-BP devices are filtered out", async () => {
  const mixedDevices = {
    code: 200,
    data: {
      dataList: [
        { deviceSn: "INV001", alias: "Inverter", deviceType: "INVERTER", deviceModel: "INV", status: "NM", battSoc: "0", bmsPower: "0", battCapacity: "0", wifiSignal: "0" },
        { deviceSn: "SN001", alias: "Bat1",     deviceType: "BP",       deviceModel: "MOD", status: "NM", battSoc: "80", bmsPower: "0", battCapacity: "314", wifiSignal: "-60" },
      ],
    },
  };
  const client = makeClient({ "/device/list_device_all_type": mixedDevices });
  const { batteries } = await client.getBatteries();
  assert.equal(batteries.length, 1);
  assert.equal(batteries[0].alias, "Bat1");
});
