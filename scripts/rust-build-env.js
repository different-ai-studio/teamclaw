"use strict";

const fs = require("fs");
const path = require("path");

function findRepoRoot(startDir) {
  let current = startDir;

  while (true) {
    const gitPath = path.join(current, ".git");
    if (fs.existsSync(gitPath) && fs.existsSync(path.join(current, "package.json"))) {
      // In a git worktree, .git is a file containing "gitdir: <path>".
      // Resolve to the main repo root so all worktrees share .cargo-target/.
      try {
        const stat = fs.statSync(gitPath);
        if (stat.isFile()) {
          const content = fs.readFileSync(gitPath, "utf8").trim();
          const match = content.match(/^gitdir:\s*(.+)$/);
          if (match) {
            // gitdir points to <main-repo>/.git/worktrees/<name>
            const gitdir = path.resolve(current, match[1]);
            const mainGitDir = path.resolve(gitdir, "..", "..");
            const mainRoot = path.dirname(mainGitDir);
            if (fs.existsSync(path.join(mainRoot, "package.json"))) {
              return mainRoot;
            }
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

function createRustBuildEnv(baseEnv = process.env, scriptDir = __dirname) {
  const env = { ...baseEnv };
  const repoRoot = findRepoRoot(scriptDir);

  delete env.CI;

  // Only override CARGO_TARGET_DIR locally; in CI, tauri-action expects
  // the default src-tauri/target/ path for artifact discovery.
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
