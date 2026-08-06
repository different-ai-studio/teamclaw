#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const BRIDGES = [
  {
    name: "cursor-bridge",
    src: path.join("apps", "daemon", "cursor-bridge"),
  },
  {
    name: "claude-bridge",
    src: path.join("apps", "daemon", "claude-bridge"),
  },
];

function hashFile(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function bridgeFingerprint(srcDir) {
  const lock = path.join(srcDir, "package-lock.json");
  const pkg = path.join(srcDir, "package.json");
  if (!fs.existsSync(lock) || !fs.existsSync(pkg)) {
    return null;
  }
  return `${hashFile(pkg)}:${hashFile(lock)}`;
}

function npmCi(srcDir, env) {
  const isWindows = process.platform === "win32";
  const result = spawnSync("npm", ["ci", "--omit=dev"], {
    cwd: srcDir,
    stdio: "inherit",
    env,
    shell: isWindows,
  });
  if (result.status !== 0) {
    throw new Error(`npm ci failed in ${srcDir}`);
  }
}

/** npm's .bin symlinks are not used at runtime (amuxd runs node src/main.mjs). */
function pruneBridgeNodeModules(srcDir) {
  const binDir = path.join(srcDir, "node_modules", ".bin");
  if (fs.existsSync(binDir)) {
    fs.rmSync(binDir, { recursive: true, force: true });
  }
}

function copyBridgeTree(srcDir, destDir) {
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const from = path.join(srcDir, entry.name);
    const to = path.join(destDir, entry.name);
    fs.cpSync(from, to, { recursive: true });
  }
}

function writeStamp(destDir, fingerprint) {
  fs.writeFileSync(path.join(destDir, ".bundle-fingerprint"), `${fingerprint}\n`, "utf8");
}

function readStamp(destDir) {
  const stamp = path.join(destDir, ".bundle-fingerprint");
  if (!fs.existsSync(stamp)) return null;
  return fs.readFileSync(stamp, "utf8").trim();
}

function shouldRebuildBundle({ destDir, fingerprint, force }) {
  if (force) return true;
  if (!fingerprint) return true;
  if (readStamp(destDir) !== fingerprint) return true;
  const main = path.join(destDir, "src", "main.mjs");
  const sdk = path.join(destDir, "node_modules");
  return !fs.existsSync(main) || !fs.existsSync(sdk);
}

/**
 * Install cursor/claude bridge trees into apps/desktop/binaries/ for Tauri bundling.
 * @param {NodeJS.ProcessEnv} env
 * @param {{ logPrefix?: string, force?: boolean }} [opts]
 */
function ensureAgentBridgeBundles(env, opts) {
  const logPrefix = opts?.logPrefix ?? "[bridge-bundle]";
  const force =
    opts?.force === true ||
    env.TEAMCLAW_FORCE_BRIDGE_BUNDLES === "1" ||
    env.TEAMCLAW_FORCE_BRIDGE_BUNDLES === "true";
  const repoRoot = path.resolve(__dirname, "..");
  const destRoot = path.join(repoRoot, "apps", "desktop", "binaries");

  for (const bridge of BRIDGES) {
    const srcDir = path.join(repoRoot, bridge.src);
    const destDir = path.join(destRoot, bridge.name);
    if (!fs.existsSync(path.join(srcDir, "package.json"))) {
      console.warn(`${logPrefix} skip ${bridge.name}: missing ${srcDir}`);
      continue;
    }
    const fingerprint = bridgeFingerprint(srcDir);
    if (!shouldRebuildBundle({ destDir, fingerprint, force })) {
      continue;
    }
    console.log(`${logPrefix} preparing ${bridge.name} bundle...`);
    npmCi(srcDir, env);
    pruneBridgeNodeModules(srcDir);
    copyBridgeTree(srcDir, destDir);
    if (fingerprint) {
      writeStamp(destDir, fingerprint);
    }
    console.log(`${logPrefix} installed ${destDir}`);
  }
}

module.exports = {
  BRIDGES,
  bridgeFingerprint,
  ensureAgentBridgeBundles,
  shouldRebuildBundle,
};

if (require.main === module) {
  ensureAgentBridgeBundles(process.env, {
    logPrefix: "[ensure-agent-bridge-bundles]",
    force: process.argv.includes("--force"),
  });
}
