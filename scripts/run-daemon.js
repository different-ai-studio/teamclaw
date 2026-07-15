#!/usr/bin/env node
"use strict";

const { spawn } = require("child_process");
const path = require("path");
const { createRustBuildEnv } = require("./rust-build-env");

const repoRoot = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const env = createRustBuildEnv(process.env, __dirname);

const child = spawn("cargo", ["run", "-p", "amuxd", "--", ...args], {
  cwd: repoRoot,
  stdio: "inherit",
  env,
  shell: false,
});

child.on("exit", (code) => process.exit(code ?? 0));
