#!/usr/bin/env node
"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { installSidecarAtomic } = require("./lib/install-sidecar-atomic");

const VERSION_PROBE_TIMEOUT_MS = 5_000;

function readCargoPackageVersion(manifestPath) {
  const raw = fs.readFileSync(manifestPath, "utf8");
  const match = raw.match(/^\s*version\s*=\s*"([^"]+)"/m);
  return match ? match[1] : null;
}

function parseVersionFromOutput(output) {
  const match = String(output ?? "").match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/);
  return match ? match[1] : null;
}

/**
 * Probe `--version` with a hard timeout. A corrupted / in-place-overwritten
 * Mach-O on macOS can hang forever in UE without this.
 */
function readExecutableVersion(executable, env) {
  if (!fs.existsSync(executable)) {
    return null;
  }
  const result = spawnSync(executable, ["--version"], {
    encoding: "utf8",
    env,
    timeout: VERSION_PROBE_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
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
 * Build and install teamclaw-introspect into apps/desktop/binaries/ if missing,
 * version-stale, or forced.
 *
 * Must run before main cargo/tauri build: build.rs panics when the file is
 * absent (unless CI is set).
 *
 * @param {NodeJS.ProcessEnv} env - Use the same env as cargo (e.g. CARGO_TARGET_DIR)
 * @param {{ logPrefix?: string, force?: boolean }} [opts]
 */
function ensureTeamclawIntrospectSidecar(env, opts) {
  if (env.CI) {
    return;
  }
  const logPrefix = opts?.logPrefix ?? "[rust-cli]";
  const force =
    opts?.force === true ||
    env.TEAMCLAW_FORCE_INTROSPECT_SIDECAR === "1" ||
    env.TEAMCLAW_FORCE_INTROSPECT_SIDECAR === "true";
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
  const binName =
    process.platform === "win32" ? "teamclaw-introspect.exe" : "teamclaw-introspect";
  const destName =
    process.platform === "win32"
      ? `teamclaw-introspect-${target}.exe`
      : `teamclaw-introspect-${target}`;
  const dest = path.join(tauriDir, "binaries", destName);
  const packageManifestPath = path.join(
    tauriDir,
    "crates",
    "teamclaw-introspect",
    "Cargo.toml",
  );
  const workspaceManifestPath = path.join(tauriDir, "Cargo.toml");
  if (!fs.existsSync(packageManifestPath) || !fs.existsSync(workspaceManifestPath)) {
    return;
  }
  const expectedVersion = readCargoPackageVersion(packageManifestPath);
  const exists = fs.existsSync(dest);
  // Force must skip the probe: a corrupted dest can hang even with a timeout.
  const existingVersion = force ? null : readExecutableVersion(dest, env);
  if (
    !force &&
    !shouldRebuildSidecar({ exists, expectedVersion, existingVersion })
  ) {
    return;
  }
  if (force) {
    console.log(`${logPrefix} Forcing teamclaw-introspect sidecar rebuild...`);
  } else if (exists) {
    console.log(
      `${logPrefix} Rebuilding teamclaw-introspect sidecar (${existingVersion ?? "unknown"} -> ${expectedVersion ?? "unknown"})...`,
    );
  }
  console.log(`${logPrefix} Building teamclaw-introspect sidecar...`);
  const targetDir = env.CARGO_TARGET_DIR || path.join(tauriDir, "target");
  const result = spawnSync(
    "cargo",
    [
      "build",
      "--manifest-path",
      workspaceManifestPath,
      "-p",
      "teamclaw-introspect",
      "--target-dir",
      targetDir,
    ],
    { stdio: "inherit", env },
  );
  if (result.status !== 0) {
    console.error(`${logPrefix} Failed to build teamclaw-introspect`);
    process.exit(1);
  }
  const built = path.join(targetDir, "debug", binName);
  installSidecarAtomic(built, dest);
  console.log(`${logPrefix} Installed ${dest}`);
}

module.exports = {
  ensureTeamclawIntrospectSidecar,
  parseVersionFromOutput,
  readCargoPackageVersion,
  readExecutableVersion,
  shouldRebuildSidecar,
  VERSION_PROBE_TIMEOUT_MS,
};
