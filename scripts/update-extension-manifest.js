#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { applyNameToExtensionManifest, resolveExtensionIconPlan } = require('./lib/branding');

const rootDir = path.resolve(__dirname, '..');
const manifestPath = path.join(rootDir, 'apps/extension', 'manifest.json');

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

// Read and merge build configs (same precedence as update-tauri-config.js:
// base -> build.config.<BUILD_ENV>.json -> build.config.local.json).
const buildEnv = process.env.BUILD_ENV;
const baseConfig = readJSON(path.join(rootDir, 'build.config.json')) || {};
const envConfig = buildEnv ? readJSON(path.join(rootDir, `build.config.${buildEnv}.json`)) : null;
const localConfig = readJSON(path.join(rootDir, 'build.config.local.json'));

let buildConfig = baseConfig;
if (envConfig) buildConfig = deepMerge(buildConfig, envConfig);
if (localConfig) buildConfig = deepMerge(buildConfig, localConfig);

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

let updated = false;

if (applyNameToExtensionManifest(manifest, buildConfig)) {
  console.log(`✓ Updated extension name: ${buildConfig.app.name}`);
  updated = true;
}

// Chrome Web Store requires x.y.z(.w) version numbers — mirror app version if set.
if (buildConfig.app && buildConfig.app.version && manifest.version !== buildConfig.app.version) {
  manifest.version = buildConfig.app.version;
  console.log(`✓ Updated extension version: ${manifest.version}`);
  updated = true;
}

if (updated) {
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}

const iconPlan = resolveExtensionIconPlan(rootDir);
if (iconPlan) {
  fs.mkdirSync(iconPlan.outDir, { recursive: true });
  for (const { source, dest } of iconPlan.files) {
    fs.copyFileSync(source, dest);
    console.log(`✓ Wrote branded icon: ${dest}`);
  }
} else {
  console.log('ℹ️ No branding/extension/icons found — keeping default icons');
}
