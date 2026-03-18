#!/usr/bin/env node
"use strict";
const { spawnSync } = require("child_process");
const path = require("path");

const isWindows = process.platform === "win32";
const root = path.resolve(__dirname, "..");
const script = isWindows
  ? path.join(root, "src-tauri", "binaries", "download-opencode.ps1")
  : path.join(root, "src-tauri", "binaries", "download-opencode.sh");

const args = process.argv.slice(2);
const result = isWindows
  ? spawnSync(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args],
      { stdio: "inherit", cwd: root }
    )
  : spawnSync("sh", [script, ...args], { stdio: "inherit", cwd: root });

process.exit(result.status ?? 1);
