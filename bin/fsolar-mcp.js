#!/usr/bin/env node
"use strict";
require("../dist/server").main().catch(function (err) {
  process.stderr.write("startup failed: " + err.message + "\n");
  process.exit(1);
});
