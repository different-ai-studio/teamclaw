#!/usr/bin/env node
/**
 * Emit desktop brand profiles as TSV: app_id<TAB>short_name<TAB>display_name
 * Used by scripts/reset-local-state.sh to resolve white-label install paths.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..", "..");

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

function deriveShortName(name) {
  return String(name || "teamclaw")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase();
}

function profileFromBuildConfig() {
  let cfg = readJSON(path.join(rootDir, "build.config.json")) || {};
  const buildEnv = process.env.BUILD_ENV;
  if (buildEnv) {
    cfg = deepMerge(cfg, readJSON(path.join(rootDir, `build.config.${buildEnv}.json`)) || {});
  }
  cfg = deepMerge(cfg, readJSON(path.join(rootDir, "build.config.local.json")) || {});

  const displayName = cfg.app?.name || "TeamClaw";
  const shortName = cfg.app?.shortName || deriveShortName(displayName);
  const appId = cfg.app?.identifier || "com.teamclaw.app";
  return { appId, shortName, displayName };
}

function emit(profile) {
  process.stdout.write(`${profile.appId}\t${profile.shortName}\t${profile.displayName}\n`);
}

const known = [
  { appId: "com.teamclaw.app", shortName: "teamclaw", displayName: "TeamClaw" },
  { appId: "com.copilot361.app", shortName: "copilot361", displayName: "Copilot 361" },
];

const seen = new Set();
function add(profile) {
  const key = `${profile.appId}\0${profile.shortName}`;
  if (seen.has(key)) return;
  seen.add(key);
  emit(profile);
}

add(profileFromBuildConfig());
for (const profile of known) add(profile);
