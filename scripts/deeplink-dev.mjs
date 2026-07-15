#!/usr/bin/env node
/**
 * macOS dev deep-link helpers for TeamClaw.
 *
 * `pnpm tauri:dev` runs a bare binary that does NOT register URL schemes with
 * Launch Services. Use the debug .app bundle + this script instead.
 *
 * Usage:
 *   pnpm tauri:deeplink:clean              # drop stale LS handlers
 *   pnpm tauri:deeplink:register           # register debug .app (build first)
 *   pnpm tauri:deeplink:open <sessionId>   # open teamclaw-dev://session/<id>
 *   pnpm tauri:deeplink:test <sessionId>   # clean + build:debug + register + open
 */
"use strict";

import { execFileSync, spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const repoRoot = path.resolve(__dirname, "..");
const lsregister =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function deepMerge(base, overlay) {
  if (!overlay) return base;
  const result = { ...base };
  for (const key of Object.keys(overlay)) {
    const baseVal = result[key];
    const overVal = overlay[key];
    if (
      baseVal &&
      overVal &&
      typeof baseVal === "object" &&
      !Array.isArray(baseVal) &&
      typeof overVal === "object" &&
      !Array.isArray(overVal)
    ) {
      result[key] = deepMerge(baseVal, overVal);
    } else if (overVal !== undefined) {
      result[key] = overVal;
    }
  }
  return result;
}

function loadBuildConfig() {
  let config = readJSON(path.join(repoRoot, "build.config.json")) || {};
  const buildEnv = process.env.BUILD_ENV;
  if (buildEnv) {
    config = deepMerge(
      config,
      readJSON(path.join(repoRoot, `build.config.${buildEnv}.json`)),
    );
  }
  config = deepMerge(config, readJSON(path.join(repoRoot, "build.config.local.json")));
  return config;
}

function debugAppPath() {
  return path.join(repoRoot, ".cargo-target/debug/bundle/macos/TeamClaw.app");
}

function appScheme(buildConfig) {
  return (buildConfig.app && buildConfig.app.scheme) || "teamclaw";
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    stdio: "inherit",
    cwd: repoRoot,
    ...opts,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function runQuiet(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: "pipe", cwd: repoRoot });
    return true;
  } catch {
    return false;
  }
}

function ghostHandlerPaths() {
  const known = [
    path.join(repoRoot, ".cargo-target/release/bundle/macos/TeamClaw.app"),
    "/Applications/TeamClaw.app",
    "/Volumes/dmg.290lNC/TeamClaw.app",
  ];
  const fromDump = [];
  try {
    const dump = execFileSync(lsregister, ["-dump"], { encoding: "utf8" });
    for (const line of dump.split("\n")) {
      const m = line.match(/^\s*path:\s+(.+\.app)\s/);
      if (!m) continue;
      const p = m[1].trim();
      if (/teamclaw/i.test(p)) fromDump.push(p);
    }
  } catch {
    // lsregister unavailable — skip scan
  }
  return [...new Set([...known, ...fromDump])];
}

function cmdClean() {
  console.log("Cleaning stale teamclaw:// Launch Services handlers…");
  for (const p of ghostHandlerPaths()) {
    if (fs.existsSync(p)) {
      console.log(`  skip (still exists): ${p}`);
      continue;
    }
    if (runQuiet(lsregister, ["-u", p])) {
      console.log(`  unregistered ghost: ${p}`);
    }
  }
  console.log("Done. If links still mis-route, run:");
  console.log(
    `  ${lsregister} -kill -r -domain local -domain system -domain user`,
  );
}

function cmdRegister() {
  const app = debugAppPath();
  if (!fs.existsSync(app)) {
    console.error(`Debug app not found: ${app}`);
    console.error("Run: pnpm tauri:build:debug");
    process.exit(1);
  }
  console.log(`Registering ${app}`);
  run(lsregister, ["-f", "-R", app]);
  const scheme = appScheme(loadBuildConfig());
  console.log(`Registered scheme: ${scheme}://`);
}

function normalizeSessionUrl(input, scheme) {
  if (!input) {
    console.error("Usage: pnpm tauri:deeplink:open <session-uuid|full-url>");
    process.exit(1);
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) return input;
  if (UUID_RE.test(input)) return `${scheme}://session/${input}`;
  console.error(`Expected a session UUID or ${scheme}:// URL, got: ${input}`);
  process.exit(1);
}

function cmdOpen(sessionArg) {
  const buildConfig = loadBuildConfig();
  const scheme = appScheme(buildConfig);
  const url = normalizeSessionUrl(sessionArg, scheme);
  const app = debugAppPath();
  if (!fs.existsSync(app)) {
    console.error(`Debug app not found: ${app}`);
    console.error("Run: pnpm tauri:build:debug && pnpm tauri:deeplink:register");
    process.exit(1);
  }
  console.log(`Opening via debug app:\n  ${url}`);
  run("open", ["-a", app, "--url", url]);
}

function cmdTest(sessionArg) {
  cmdClean();
  console.log("\nBuilding debug .app (this may take a few minutes)…");
  run("pnpm", ["tauri:build:debug"]);
  cmdRegister();
  console.log("");
  cmdOpen(sessionArg);
}

const [command, ...rest] = process.argv.slice(2);
const sessionArg = rest[0];

switch (command) {
  case "clean":
    cmdClean();
    break;
  case "register":
    cmdRegister();
    break;
  case "open":
    cmdOpen(sessionArg);
    break;
  case "test":
    if (!sessionArg) {
      console.error("Usage: pnpm tauri:deeplink:test <session-uuid>");
      process.exit(1);
    }
    cmdTest(sessionArg);
    break;
  default:
    console.error(`Unknown command: ${command || "(none)"}`);
    console.error("Commands: clean | register | open | test");
    process.exit(1);
}
