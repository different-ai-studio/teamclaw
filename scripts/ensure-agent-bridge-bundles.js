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
    // Optional native package installed via @cursor/sdk optionalDependencies.
    nativePackage: (npmPlatform) =>
      npmPlatform ? `@cursor/sdk-${npmPlatform.os}-${npmPlatform.cpu}` : null,
  },
  {
    name: "claude-bridge",
    src: path.join("apps", "daemon", "claude-bridge"),
  },
];

/** @typedef {{ os: string, cpu: string }} NpmPlatform */

/**
 * Map a Rust target triple to npm's `--os` / `--cpu` filters (npm ≥ 10).
 * @param {string} target
 * @returns {NpmPlatform}
 */
function rustTargetToNpmPlatform(target) {
  const table = {
    "aarch64-apple-darwin": { os: "darwin", cpu: "arm64" },
    "x86_64-apple-darwin": { os: "darwin", cpu: "x64" },
    "aarch64-unknown-linux-gnu": { os: "linux", cpu: "arm64" },
    "x86_64-unknown-linux-gnu": { os: "linux", cpu: "x64" },
    "x86_64-pc-windows-msvc": { os: "win32", cpu: "x64" },
    "x86_64-pc-windows-gnu": { os: "win32", cpu: "x64" },
  };
  const mapped = table[target];
  if (!mapped) {
    throw new Error(
      `unsupported rust target for bridge npm platform: ${target}`,
    );
  }
  return mapped;
}

/**
 * Host platform as npm `--os` / `--cpu` values.
 * @returns {NpmPlatform}
 */
function hostNpmPlatform() {
  const os =
    process.platform === "win32"
      ? "win32"
      : process.platform === "darwin"
        ? "darwin"
        : process.platform === "linux"
          ? "linux"
          : null;
  const cpu =
    process.arch === "arm64"
      ? "arm64"
      : process.arch === "x64"
        ? "x64"
        : null;
  if (!os || !cpu) {
    throw new Error(
      `unsupported host platform for bridge npm install: ${process.platform}/${process.arch}`,
    );
  }
  return { os, cpu };
}

/**
 * @param {string | null | undefined} target Rust target triple, or null for host
 * @returns {NpmPlatform}
 */
function resolveNpmPlatform(target) {
  if (target) {
    return rustTargetToNpmPlatform(target);
  }
  return hostNpmPlatform();
}

/**
 * @param {NpmPlatform} npmPlatform
 * @returns {string}
 */
function npmPlatformKey(npmPlatform) {
  return `${npmPlatform.os}-${npmPlatform.cpu}`;
}

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

/**
 * Stamp includes npm platform so cross-target builds (arm64 CI building
 * x86_64-apple-darwin) cannot reuse a wrong-arch node_modules tree.
 * @param {string | null} contentFingerprint
 * @param {NpmPlatform} npmPlatform
 * @returns {string | null}
 */
function bundleStamp(contentFingerprint, npmPlatform) {
  if (!contentFingerprint) return null;
  return `${contentFingerprint}:${npmPlatformKey(npmPlatform)}`;
}

/**
 * @param {string} srcDir
 * @param {NodeJS.ProcessEnv} env
 * @param {NpmPlatform} npmPlatform
 */
function npmCi(srcDir, env, npmPlatform) {
  const isWindows = process.platform === "win32";
  // --os / --cpu force optionalDependencies for the *bundle* target, not the
  // runner. Without this, macos-latest (arm64) installs only darwin-arm64
  // when packaging x86_64-apple-darwin (see #778).
  const args = [
    "ci",
    "--omit=dev",
    `--os=${npmPlatform.os}`,
    `--cpu=${npmPlatform.cpu}`,
  ];
  const result = spawnSync("npm", args, {
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
 * @param {string} destDir
 * @param {string | null | undefined} nativePackage
 */
function assertNativePackage(destDir, nativePackage) {
  if (!nativePackage) return;
  const dir = path.join(destDir, "node_modules", nativePackage);
  if (!fs.existsSync(dir)) {
    throw new Error(
      `bridge bundle missing native package ${nativePackage} under ${destDir}`,
    );
  }
}

/**
 * Parse CLI flags for the standalone entrypoint.
 * @param {string[]} argv
 * @returns {{ force: boolean, target: string | null }}
 */
function parseCliArgs(argv) {
  let force = false;
  let target = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--target") {
      target = argv[++i] ?? null;
      continue;
    }
    if (arg.startsWith("--target=")) {
      target = arg.slice("--target=".length) || null;
    }
  }
  return { force, target };
}

/**
 * Extract `--target <triple>` / `--target=<triple>` from a tauri argv list.
 * @param {string[]} argv
 * @returns {string | null}
 */
function extractTargetFromArgv(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--target") {
      return argv[i + 1] ?? null;
    }
    if (arg.startsWith("--target=")) {
      return arg.slice("--target=".length) || null;
    }
  }
  return null;
}

/**
 * Install cursor/claude bridge trees into apps/desktop/binaries/ for Tauri bundling.
 * @param {NodeJS.ProcessEnv} env
 * @param {{ logPrefix?: string, force?: boolean, target?: string | null }} [opts]
 */
function ensureAgentBridgeBundles(env, opts) {
  const logPrefix = opts?.logPrefix ?? "[bridge-bundle]";
  const force =
    opts?.force === true ||
    env.TEAMCLAW_FORCE_BRIDGE_BUNDLES === "1" ||
    env.TEAMCLAW_FORCE_BRIDGE_BUNDLES === "true";
  const target =
    opts?.target ||
    env.TEAMCLAW_BRIDGE_TARGET ||
    env.TARGET ||
    null;
  const npmPlatform = resolveNpmPlatform(target);
  const repoRoot = path.resolve(__dirname, "..");
  const destRoot = path.join(repoRoot, "apps", "desktop", "binaries");

  console.log(
    `${logPrefix} npm platform ${npmPlatformKey(npmPlatform)}` +
      (target ? ` (target ${target})` : " (host)"),
  );

  for (const bridge of BRIDGES) {
    const srcDir = path.join(repoRoot, bridge.src);
    const destDir = path.join(destRoot, bridge.name);
    if (!fs.existsSync(path.join(srcDir, "package.json"))) {
      console.warn(`${logPrefix} skip ${bridge.name}: missing ${srcDir}`);
      continue;
    }
    const contentFingerprint = bridgeFingerprint(srcDir);
    const fingerprint = bundleStamp(contentFingerprint, npmPlatform);
    if (!shouldRebuildBundle({ destDir, fingerprint, force })) {
      continue;
    }
    console.log(`${logPrefix} preparing ${bridge.name} bundle...`);
    npmCi(srcDir, env, npmPlatform);
    pruneBridgeNodeModules(srcDir);
    copyBridgeTree(srcDir, destDir);
    const nativePackage =
      typeof bridge.nativePackage === "function"
        ? bridge.nativePackage(npmPlatform)
        : null;
    assertNativePackage(destDir, nativePackage);
    if (fingerprint) {
      writeStamp(destDir, fingerprint);
    }
    console.log(`${logPrefix} installed ${destDir}`);
  }
}

module.exports = {
  BRIDGES,
  bridgeFingerprint,
  bundleStamp,
  ensureAgentBridgeBundles,
  extractTargetFromArgv,
  hostNpmPlatform,
  npmPlatformKey,
  parseCliArgs,
  resolveNpmPlatform,
  rustTargetToNpmPlatform,
  shouldRebuildBundle,
};

if (require.main === module) {
  const { force, target } = parseCliArgs(process.argv.slice(2));
  ensureAgentBridgeBundles(process.env, {
    logPrefix: "[ensure-agent-bridge-bundles]",
    force,
    target,
  });
}
