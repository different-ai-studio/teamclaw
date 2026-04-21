#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const tauriConfPath = path.join(rootDir, 'src-tauri', 'tauri.conf.json');

function readJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
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
      baseVal && overVal &&
      typeof baseVal === 'object' && !Array.isArray(baseVal) &&
      typeof overVal === 'object' && !Array.isArray(overVal)
    ) {
      result[key] = deepMerge(baseVal, overVal);
    } else if (overVal !== undefined) {
      result[key] = overVal;
    }
  }
  return result;
}

// Read and merge build configs
const buildEnv = process.env.BUILD_ENV;
const baseConfig = readJSON(path.join(rootDir, 'build.config.json')) || {};
const envConfig = buildEnv ? readJSON(path.join(rootDir, `build.config.${buildEnv}.json`)) : null;
const localConfig = readJSON(path.join(rootDir, 'build.config.local.json'));

let buildConfig = baseConfig;
if (envConfig) {
  buildConfig = deepMerge(buildConfig, envConfig);
}
if (localConfig) {
  buildConfig = deepMerge(buildConfig, localConfig);
}

// Update tauri.conf.json
const tauriConf = JSON.parse(fs.readFileSync(tauriConfPath, 'utf8'));

let updated = false;

function ensureUpdater() {
  if (!tauriConf.plugins) tauriConf.plugins = {};
  if (!tauriConf.plugins.updater) tauriConf.plugins.updater = {};
}

// Start from buildConfig override (array or singular), else keep existing endpoints.
let endpoints;
if (Array.isArray(buildConfig.app?.updater?.endpoints)) {
  endpoints = buildConfig.app.updater.endpoints.slice();
} else if (buildConfig.app?.updater?.endpoint) {
  endpoints = [buildConfig.app.updater.endpoint];
} else if (Array.isArray(tauriConf.plugins?.updater?.endpoints)) {
  endpoints = tauriConf.plugins.updater.endpoints.slice();
}

if (endpoints) {
  const ossBase = (process.env.OSS_BASE_URL || '').replace(/\/+$/, '');
  endpoints = endpoints
    .map((url) => (ossBase ? url.replace('__OSS_BASE_URL__', ossBase) : url))
    .filter((url) => !url.includes('__OSS_BASE_URL__'));

  ensureUpdater();
  tauriConf.plugins.updater.endpoints = endpoints;
  console.log(`✓ Updated updater endpoints (${endpoints.length}):`);
  for (const url of endpoints) console.log(`    - ${url}`);
  updated = true;
}

if (buildConfig.app?.updater?.pubkey) {
  ensureUpdater();
  tauriConf.plugins.updater.pubkey = buildConfig.app.updater.pubkey;
  console.log(`✓ Updated updater pubkey: ${buildConfig.app.updater.pubkey.substring(0, 50)}...`);
  updated = true;
}

if (updated) {
  fs.writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + '\n', 'utf8');
  console.log(`✓ Updated ${tauriConfPath}`);
} else {
  console.log('⚠ No updater configuration found in build.config.json');
}
