#!/usr/bin/env node
"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function readCargoPackageVersion(manifestPath) {
  const raw = fs.readFileSync(manifestPath, "utf8");
  const match = raw.match(/^\s*version\s*=\s*"([^"]+)"/m);
  return match ? match[1] : null;
}

function parseVersionFromOutput(output) {
  const match = String(output ?? "").match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/);
  return match ? match[1] : null;
}

function readExecutableVersion(executable, env) {
  if (!fs.existsSync(executable)) {
    return null;
  }
  const result = spawnSync(executable, ["--version"], { encoding: "utf8", env });
  if (result.error || result.status !== 0) {
    return null;
  }
  return parseVersionFromOutput(`${result.stdout}\n${result.stderr}`);
}

function shouldRebuildSidecar({ exists, expectedVersion, existingVersion }) {
  if (!exists) {
    return true;
  }
  if (!expectedVersion || !existingVersion) {
    return true;
  }
  return expectedVersion !== existingVersion;
}

/**
 * Build and install amuxd into apps/desktop/binaries/amuxd-<target> if missing.
 * Mirrors ensureTeamclawIntrospectSidecar so tauri bundling finds the sidecar.
 * @param {NodeJS.ProcessEnv} env
 * @param {{ logPrefix?: string }} [opts]
 */
function ensureAmuxdSidecar(env, opts) {
  if (env.CI) {
    return;
  }
  const logPrefix = opts?.logPrefix ?? "[rust-cli]";
  const repoRoot = path.resolve(__dirname, "..");
  const tauriDir = path.join(repoRoot, "apps/desktop");
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
  const binName = process.platform === "win32" ? "amuxd.exe" : "amuxd";
  const destName = process.platform === "win32" ? `amuxd-${target}.exe` : `amuxd-${target}`;
  const dest = path.join(tauriDir, "binaries", destName);
  const manifestPath = path.join(repoRoot, "apps/daemon", "Cargo.toml");
  if (!fs.existsSync(manifestPath)) {
    return;
  }
  const expectedVersion = readCargoPackageVersion(manifestPath);
  const exists = fs.existsSync(dest);
  const existingVersion = readExecutableVersion(dest, env);
  if (!shouldRebuildSidecar({ exists, expectedVersion, existingVersion })) {
    return;
  }
  if (exists) {
    console.log(
      `${logPrefix} Rebuilding amuxd sidecar (${existingVersion ?? "unknown"} -> ${expectedVersion ?? "unknown"})...`,
    );
  }
  console.log(`${logPrefix} Building amuxd sidecar...`);
  const targetDir = env.CARGO_TARGET_DIR || path.join(tauriDir, "target");
  const result = spawnSync(
    "cargo",
    ["build", "--manifest-path", manifestPath, "-p", "amuxd", "--target-dir", targetDir],
    { stdio: "inherit", env },
  );
  if (result.status !== 0) {
    console.error(`${logPrefix} Failed to build amuxd`);
    process.exit(1);
  }
  const built = path.join(targetDir, "debug", binName);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(built, dest);
  console.log(`${logPrefix} Installed ${dest}`);
}

module.exports = {
  ensureAmuxdSidecar,
  parseVersionFromOutput,
  readCargoPackageVersion,
  readExecutableVersion,
  shouldRebuildSidecar,
};
