"use strict";

const fs = require("fs");
const path = require("path");

/**
 * Resolve BUILD_ENV for local dev: honor an explicit env var, otherwise default
 * to "dev" when build.config.dev.json exists (common local checkout layout).
 *
 * The dev fallback is a LOCAL convenience only. build.config.dev.json is
 * checked into git, so on CI it always exists — without the CI guard it
 * deep-merges the dev backend over the release build.config.json written from
 * the BUILD_CONFIG_* secret (v0.2.24-beta.1 shipped pointing at
 * api.teamclaw-dev.ucar.cc this way).
 */
function resolveBuildEnv(repoRoot, env = process.env) {
  if (env.BUILD_ENV?.trim()) return env.BUILD_ENV.trim();
  if (env.CI) return undefined;
  const devConfig = path.join(repoRoot, "build.config.dev.json");
  if (fs.existsSync(devConfig)) return "dev";
  return undefined;
}

module.exports = { resolveBuildEnv };
