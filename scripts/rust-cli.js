#!/usr/bin/env node
"use strict";

const { spawn } = require("child_process");
const { createRustBuildEnv } = require("./rust-build-env");
const { ensureTeamclawIntrospectSidecar } = require("./ensure-introspect-sidecar");
const { ensureAmuxdSidecar } = require("./ensure-amuxd-sidecar");

const args = process.argv.slice(2);
const env = createRustBuildEnv(process.env, __dirname);

if (args[0] === "check" && !env.CI) {
  // `cargo check` should be usable without downloading the local sidecar binary.
  env.CI = "1";

  if (!env.TAURI_CONFIG) {
    env.TAURI_CONFIG = JSON.stringify({
      bundle: {
        externalBin: [],
      },
    });
  }
}

// introspect is a local crate.
// Build before invoking cargo to avoid build.rs deadlock. Skipped when env.CI is set (e.g. rust:check).
ensureTeamclawIntrospectSidecar(env);
ensureAmuxdSidecar(env);

const child = spawn("cargo", args, {
  stdio: "inherit",
  shell: false,
  env,
});

child.on("exit", (code) => process.exit(code ?? 0));
