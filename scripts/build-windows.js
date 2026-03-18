#!/usr/bin/env node
"use strict";
const { spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const root = path.resolve(__dirname, "..");
const binariesDir = path.join(root, "src-tauri", "binaries");
const opencodeExe = path.join(binariesDir, "opencode-x86_64-pc-windows-msvc.exe");

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: root, shell: true, ...opts });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

console.log("[build-windows] Repo root:", root);

console.log("[build-windows] Installing dependencies (pnpm install)...");
run("pnpm", ["install"]);

if (!fs.existsSync(opencodeExe)) {
  console.warn("[build-windows] OpenCode binary not found. Trying pnpm update-opencode...");
  const r = spawnSync("pnpm", ["update-opencode"], { stdio: "inherit", cwd: root, shell: true });
  if (r.status !== 0) {
    console.warn("[build-windows] update-opencode failed (PowerShell may not be in PATH).");
    console.warn("  Place opencode-x86_64-pc-windows-msvc.exe in src-tauri/binaries/ or run:");
    console.warn("  src-tauri\\binaries\\download-opencode.ps1");
  }
  if (!fs.existsSync(opencodeExe)) {
    console.warn("[build-windows] Continuing without OpenCode; build may fail if Tauri requires it.");
  }
} else {
  console.log("[build-windows] OpenCode binary present:", opencodeExe);
}

console.log("[build-windows] Building Tauri app (NSIS installer, no p2p)...");
const tempConfig = path.join(os.tmpdir(), `tauri-build-config-${Date.now()}.json`);
fs.writeFileSync(tempConfig, '{"bundle":{"createUpdaterArtifacts":false}}', "utf8");
try {
  run("pnpm", [
    "tauri", "build", "--bundles", "nsis", "--config", tempConfig,
    "--", "--", "--no-default-features"
  ]);
} finally {
  try { fs.unlinkSync(tempConfig); } catch (_) {}
}

const nsisDir = path.join(root, "src-tauri", "target", "release", "bundle", "nsis");
const msiDir = path.join(root, "src-tauri", "target", "release", "bundle", "msi");
console.log("\n[build-windows] Build completed.");
if (fs.existsSync(nsisDir)) {
  fs.readdirSync(nsisDir).filter((f) => f.endsWith(".exe")).forEach((f) => {
    console.log("  NSIS installer:", path.join(nsisDir, f));
  });
}
if (fs.existsSync(msiDir)) {
  fs.readdirSync(msiDir).filter((f) => f.endsWith(".msi")).forEach((f) => {
    console.log("  MSI installer:", path.join(msiDir, f));
  });
}
