#!/usr/bin/env node
"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

/**
 * Build and install teamclaw-introspect into apps/desktop/binaries/ if missing.
 * Must run before main cargo/tauri build: build.rs panics when the file is absent (unless CI is set).
 * @param {NodeJS.ProcessEnv} env - Use the same env as cargo (e.g. CARGO_TARGET_DIR from createRustBuildEnv)
 * @param {{ logPrefix?: string }} [opts]
 */
function ensureTeamclawIntrospectSidecar(env, opts) {
  if (env.CI) {
    return;
  }
  const logPrefix = opts?.logPrefix ?? "[rust-cli]";
  const tauriDir = path.resolve(__dirname, "..", "apps/desktop");
  const target =
    env.TARGET ||
    (() => {
      const r = spawnSync("rustc", ["-vV"], { encoding: "utf8", env });
      const m = r.stdout && r.stdout.match(/host:\s*(\S+)/);
      return m ? m[1] : "";
    })();
  if (!target) {
    return;
  }
  const dest = path.join(tauriDir, "binaries", `teamclaw-introspect-${target}`);
  if (fs.existsSync(dest)) {
    return;
  }
  const manifestPath = path.join(tauriDir, "crates", "teamclaw-introspect", "Cargo.toml");
  if (!fs.existsSync(manifestPath)) {
    return;
  }
  console.log(`${logPrefix} Building teamclaw-introspect sidecar...`);
  const targetDir = env.CARGO_TARGET_DIR || path.join(tauriDir, "target");
  const result = spawnSync(
    "cargo",
    ["build", "--manifest-path", manifestPath, "--target-dir", targetDir],
    { stdio: "inherit", env },
  );
  if (result.status !== 0) {
    console.error(`${logPrefix} Failed to build teamclaw-introspect`);
    process.exit(1);
  }
  const profile = "debug";
  const binName = process.platform === "win32" ? "teamclaw-introspect.exe" : "teamclaw-introspect";
  const built = path.join(targetDir, profile, binName);
  fs.copyFileSync(built, dest);
  console.log(`${logPrefix} Installed ${dest}`);
}

module.exports = { ensureTeamclawIntrospectSidecar };
