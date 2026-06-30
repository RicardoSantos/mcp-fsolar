#!/usr/bin/env node
/**
 * One-shot probe — login, list devices, print live data.
 * Usage: node fsolar/probe.js
 */

const fs   = require("fs");
const path = require("path");
const { FelicityClient } = require("./index.js");

fs.readFileSync(path.join(__dirname, ".env"), "utf8")
  .split("\n")
  .forEach((line) => {
    const eq = line.indexOf("=");
    if (eq > 0) process.env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  });

async function main() {
  const client = new FelicityClient({
    user: process.env.FELICITY_USER,
    pass: process.env.FELICITY_PASS,
  });

  console.log("Fetching batteries...\n");
  const { batteries, fetchedAt, fromCache } = await client.getBatteries();

  console.log(`fetchedAt: ${fetchedAt}  fromCache: ${fromCache}\n`);
  batteries.forEach((b) => {
    console.log(`${b.alias}  (${b.sn})`);
    console.log(`  SOC ${b.soc}%  SOH ${b.soh}%  ${b.chargingState}  ${b.power} W`);
    console.log(`  Voltage ${b.voltage} V  Current ${b.current} A  Temp ${b.tempMin}–${b.tempMax} °C`);
    console.log(`  Remaining ${b.remainingKwh} kWh  Cells ${b.cellVoltageMin}–${b.cellVoltageMax} mV (Δ${b.cellDelta} mV)`);
    console.log();
  });
}

main().catch(console.error);
