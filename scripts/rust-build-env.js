"use strict";

const fs = require("fs");
const path = require("path");
const { resolveBuildEnv } = require("./lib/resolve-build-env");

function findRepoRoot(startDir) {
  let current = startDir;

  while (true) {
    const gitPath = path.join(current, ".git");
    if (fs.existsSync(gitPath) && fs.existsSync(path.join(current, "package.json"))) {
      // In a git worktree, .git is a file containing "gitdir: <path>".
      // Keep build artifacts scoped to the active checkout: Cargo/Tauri build
      // metadata can contain absolute source paths, and sharing a target dir
      // across worktrees can make builds read files from deleted checkouts.
      try {
        const stat = fs.statSync(gitPath);
        if (stat.isFile()) {
          const content = fs.readFileSync(gitPath, "utf8").trim();
          const match = content.match(/^gitdir:\s*(.+)$/);
          if (match) {
            return current;
          }
        }
      } catch (_) {
        // Fall through to return current worktree root
      }
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return startDir;
    }

    current = parent;
  }
}

function commandExists(command) {
  const pathEnv = process.env.PATH || "";
  const suffixes = process.platform === "win32"
    ? [".exe", ".cmd", ".bat", ""]
    : [""];

  for (const entry of pathEnv.split(path.delimiter)) {
    if (!entry) continue;
    for (const suffix of suffixes) {
      const candidate = path.join(entry, command + suffix);
      if (fs.existsSync(candidate)) {
        return true;
      }
    }
  }

  return false;
}

function loadDotEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const out = {};
  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function createRustBuildEnv(baseEnv = process.env, scriptDir = __dirname) {
  const env = { ...baseEnv };
  const repoRoot = findRepoRoot(scriptDir);

  const resolvedBuildEnv = resolveBuildEnv(repoRoot, env);
  if (resolvedBuildEnv && !env.BUILD_ENV) {
    env.BUILD_ENV = resolvedBuildEnv;
  }

  // Mirror Vite: packages/app/.env.local overrides for Rust build.rs (CLOUD_API_URL).
  // Without this, the JS frontend talks to 127.0.0.1:9000 while team-share Tauri
  // commands still hit build.config.json cloudApiUrl → PGRST301 on the remote FC.
  const appEnvDir = path.join(repoRoot, "packages", "app");
  for (const name of [".env.local", ".env"]) {
    for (const [key, val] of Object.entries(loadDotEnvFile(path.join(appEnvDir, name)))) {
      if (env[key] === undefined || env[key] === "") {
        env[key] = val;
      }
    }
  }

  // Only override CARGO_TARGET_DIR locally; in CI, tauri-action expects
  // the default apps/desktop/target/ path for artifact discovery.
  if (!env.CARGO_TARGET_DIR && !baseEnv.GITHUB_ACTIONS) {
    env.CARGO_TARGET_DIR = path.join(repoRoot, ".cargo-target");
  }

  if (!env.RUSTC_WRAPPER && commandExists("sccache")) {
    env.RUSTC_WRAPPER = "sccache";
  }

  if (process.platform === "darwin" && process.arch === "arm64" && !env.BINDGEN_EXTRA_CLANG_ARGS) {
    env.BINDGEN_EXTRA_CLANG_ARGS = "--target=aarch64-apple-darwin";
  }

  if (process.platform === "darwin" && !env.CMAKE_OSX_DEPLOYMENT_TARGET) {
    env.CMAKE_OSX_DEPLOYMENT_TARGET = "10.15";
  }

  return env;
}

module.exports = {
  createRustBuildEnv,
};
