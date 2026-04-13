#!/usr/bin/env node
"use strict";

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { createRustBuildEnv } = require("./rust-build-env");

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

// ── Auto-build teamclaw-introspect sidecar if missing ──
// Unlike opencode (downloaded externally), introspect is a local crate.
// Build it before invoking cargo to avoid build.rs deadlock.
{
  const tauriDir = path.resolve(__dirname, "..", "src-tauri");
  const target = process.env.TARGET || (() => {
    const r = spawnSync("rustc", ["-vV"], { encoding: "utf8" });
    const m = r.stdout && r.stdout.match(/host:\s*(\S+)/);
    return m ? m[1] : "";
  })();
  if (target) {
    const dest = path.join(tauriDir, "binaries", `teamclaw-introspect-${target}`);
    if (!fs.existsSync(dest)) {
      const manifestPath = path.join(tauriDir, "crates", "teamclaw-introspect", "Cargo.toml");
      if (fs.existsSync(manifestPath)) {
        console.log("[rust-cli] Building teamclaw-introspect sidecar...");
        const targetDir = env.CARGO_TARGET_DIR || path.join(tauriDir, "target");
        const result = spawnSync("cargo", [
          "build", "--manifest-path", manifestPath, "--target-dir", targetDir,
        ], { stdio: "inherit", env });
        if (result.status !== 0) {
          console.error("[rust-cli] Failed to build teamclaw-introspect");
          process.exit(1);
        }
        const profile = "debug";
        const binName = process.platform === "win32" ? "teamclaw-introspect.exe" : "teamclaw-introspect";
        const built = path.join(targetDir, profile, binName);
        fs.copyFileSync(built, dest);
        console.log(`[rust-cli] Installed ${dest}`);
      }
    }
  }
}

const child = spawn("cargo", args, {
  stdio: "inherit",
  shell: false,
  env,
});

child.on("exit", (code) => process.exit(code ?? 0));
