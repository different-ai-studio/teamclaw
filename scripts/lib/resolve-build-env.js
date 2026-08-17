"use strict";

const fs = require("fs");
const path = require("path");

/**
 * Resolve BUILD_ENV for local dev: honor an explicit env var, otherwise default
 * to "dev" when build.config.dev.json exists (common local checkout layout).
 *
 * The dev fallback is a LOCAL convenience only. The file is untracked
 * (`.gitignore` keeps every root `build.config.*.json` but the example,
 * production and teal flavors), so a CI checkout does not have one and this
 * fallback cannot fire there. It used to be checked in, which is how
 * v0.2.24-beta.1 shipped pointing at api.teamclu-dev.ucar.cc: the dev backend
 * deep-merged over the release build.config.json written from the
 * BUILD_CONFIG_* secret. The `env.CI` guard below is what stopped that; it now
 * guards a case that should no longer be reachable, and stays as belt and
 * braces for a runner that resurrects the file.
 */
function resolveBuildEnv(repoRoot, env = process.env) {
  if (env.BUILD_ENV?.trim()) return env.BUILD_ENV.trim();
  if (env.CI) return undefined;
  const devConfig = path.join(repoRoot, "build.config.dev.json");
  if (fs.existsSync(devConfig)) return "dev";
  return undefined;
}

module.exports = { resolveBuildEnv };
