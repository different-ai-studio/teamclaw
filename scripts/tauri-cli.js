#!/usr/bin/env node
"use strict";

const { spawn } = require("child_process");
const path = require("path");
const { createRustBuildEnv } = require("./rust-build-env");
const { ensureTeamclawIntrospectSidecar } = require("./ensure-introspect-sidecar");
const { ensureAmuxdSidecar } = require("./ensure-amuxd-sidecar");
const { platform } = process;

let args = process.argv.slice(2);
const isWindows = platform === "win32";
const sub = args[0];

/**
 * Strip dev-only onboarding skip flags and expose them to Vite via VITE_* env vars.
 *
 * Usage:
 *   pnpm tauri:dev -- --skip-setup
 *   pnpm tauri:dev -- --skip-daemon-onboarding
 *   pnpm tauri:dev -- --skip-setup --skip-daemon-onboarding
 *
 * Aliases: --skip-onboarding → --skip-daemon-onboarding
 * Env fallbacks: TEAMCLAW_SKIP_SETUP=1, TEAMCLAW_SKIP_DAEMON_ONBOARDING=1
 */
function applyDevSkipFlags(argv, env) {
  if (argv[0] !== "dev") {
    return argv;
  }

  let skipSetup =
    env.TEAMCLAW_SKIP_SETUP === "1" || env.VITE_TEAMCLAW_SKIP_SETUP === "true";
  let skipDaemonOnboarding =
    env.TEAMCLAW_SKIP_DAEMON_ONBOARDING === "1" ||
    env.VITE_TEAMCLAW_SKIP_DAEMON_ONBOARDING === "true";

  const filtered = [];
  for (const arg of argv) {
    if (arg === "--skip-setup") {
      skipSetup = true;
      continue;
    }
    if (arg === "--skip-daemon-onboarding" || arg === "--skip-onboarding") {
      skipDaemonOnboarding = true;
      continue;
    }
    filtered.push(arg);
  }

  if (skipSetup) {
    env.VITE_TEAMCLAW_SKIP_SETUP = "true";
  }
  if (skipDaemonOnboarding) {
    env.VITE_TEAMCLAW_SKIP_DAEMON_ONBOARDING = "true";
  }

  if (skipSetup || skipDaemonOnboarding) {
    console.log(
      `[tauri-cli] dev onboarding skips: setup=${skipSetup}, daemon=${skipDaemonOnboarding}`,
    );
  }

  return filtered;
}

// On Windows, dev/build must use --no-default-features to avoid wmi/windows-core conflict (p2p/iroh).
// Strip any --features p2p so the broken dependency is not pulled in.
if (isWindows && (sub === "dev" || sub === "build")) {
  const filtered = args.filter((a, i) => {
    if (a === "--features" && args[i + 1] === "p2p") return false;
    if (a === "p2p" && args[i - 1] === "--features") return false;
    return true;
  });
  if (!filtered.includes("--no-default-features")) {
    const dashIdx = filtered.indexOf("--");
    const cargoFlags = ["--no-default-features"];
    if (dashIdx >= 0) {
      filtered.splice(dashIdx + 1, 0, ...cargoFlags);
    } else {
      filtered.push("--", ...cargoFlags);
    }
  }
  args.length = 0;
  args.push(...filtered);
}

const env = createRustBuildEnv(process.env, __dirname);
args = applyDevSkipFlags(args, env);
ensureTeamclawIntrospectSidecar(env, { logPrefix: "[tauri-cli]" });
ensureAmuxdSidecar(env, { logPrefix: "[tauri-cli]" });

const desktopDir = path.resolve(__dirname, "..", "apps", "desktop");
const child = spawn("pnpm", ["exec", "tauri", ...args], {
  stdio: "inherit",
  shell: isWindows,
  env,
  cwd: desktopDir,
});
child.on("exit", (code) => process.exit(code ?? 0));
