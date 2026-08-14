#!/usr/bin/env node
"use strict";

const { spawn } = require("child_process");
const { createRustBuildEnv } = require("./rust-build-env");
const { ensureTeamcluIntrospectSidecar } = require("./ensure-introspect-sidecar");
const { ensureAmuxdSidecar } = require("./ensure-amuxd-sidecar");
const {
  ensureAgentBridgeBundles,
  extractTargetFromArgv,
} = require("./ensure-agent-bridge-bundles");

const args = process.argv.slice(2);
const env = createRustBuildEnv(process.env, __dirname);

// Analysis-only subcommands: they type-check but produce nothing to ship, so
// they have no business needing sidecar binaries or bundled resources.
const isAnalysisOnly = args[0] === "check" || args[0] === "clippy";

if (isAnalysisOnly && !env.CI) {
  // `cargo check` should be usable without downloading the local sidecar binary.
  env.CI = "1";

  if (!env.TAURI_CONFIG) {
    env.TAURI_CONFIG = JSON.stringify({
      bundle: {
        externalBin: [],
        // `resources` globs binaries/{cursor,claude}-bridge/**/*, and all of
        // binaries/ is gitignored. On a fresh checkout those globs match
        // nothing and tauri-build fails the build script before a single
        // crate compiles. Only `pnpm tauri:*` populates the bridges (via
        // ensureAgentBridgeBundles), and a compile check has no use for
        // runtime resources — so drop them here rather than make `rust:check`
        // run `npm ci` in two bridge packages.
        resources: [],
      },
    });
  }
}

// introspect is a local crate.
// Build before invoking cargo to avoid build.rs deadlock. Skipped when env.CI is set (e.g. rust:check).
ensureTeamcluIntrospectSidecar(env);
ensureAmuxdSidecar(env);
// A real build keeps the `resources` globs, so the bridge trees have to exist
// on disk — same requirement `pnpm tauri:*` satisfies. Analysis-only runs
// neutralized the globs above and skip this, staying fast and offline.
if (!isAnalysisOnly) {
  ensureAgentBridgeBundles(env, {
    logPrefix: "[rust-cli]",
    target: extractTargetFromArgv(args),
  });
}

const child = spawn("cargo", args, {
  stdio: "inherit",
  shell: false,
  env,
});

child.on("exit", (code) => process.exit(code ?? 0));
