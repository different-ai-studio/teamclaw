"use strict";
const path = require("path");

/**
 * Apply the configured app name to a parsed tauri.conf.json object (mutates it).
 * `app.name` is the bundle identity → `productName` (the .app / installer
 * filename). `app.displayName` is the human-facing label → the first window's
 * `title`; it falls back to `app.name` when unset. Setting only `displayName`
 * renames the window without touching the bundle. Returns true if anything changed.
 */
function applyNameToTauriConf(tauriConf, buildConfig) {
  const app = (buildConfig && buildConfig.app) || {};
  const name = app.name;
  const displayName = app.displayName || name;
  let changed = false;
  if (name && tauriConf.productName !== name) {
    tauriConf.productName = name;
    changed = true;
  }
  const win = tauriConf.app && Array.isArray(tauriConf.app.windows) && tauriConf.app.windows[0];
  if (displayName && win && win.title !== displayName) {
    win.title = displayName;
    changed = true;
  }
  return changed;
}

/**
 * Build a (side-effect-free) plan describing how to regenerate icons from
 * buildConfig.app.logo. Returns null when no logo is configured.
 */
function resolveLogoPlan(buildConfig, repoRoot) {
  const logo = buildConfig && buildConfig.app && buildConfig.app.logo;
  if (!logo) return null;
  const iconsOutDir = path.join(repoRoot, "apps/desktop/icons");
  return {
    source: path.resolve(repoRoot, logo),
    iconsOutDir,
    generatedIcon: path.join(iconsOutDir, "128x128.png"),
    publicLogoTargets: [
      path.join(repoRoot, "packages/app/public/logo.png"),
      path.join(repoRoot, "packages/app/public/logo-64.png"),
    ],
  };
}

/**
 * Apply the configured bundle identifier and deep-link scheme to a parsed
 * tauri.conf.json object (mutates it). Both are optional. Throws (to fail the
 * build) when a provided value is malformed. Returns true if anything changed.
 *
 * - identifier: reverse-DNS, ≥2 dot-separated segments, [A-Za-z0-9-] per segment
 *   (Tauri's rule: no underscores).
 * - scheme: a URL scheme — must start with a letter, then [a-z0-9+.-].
 *   Uppercase is rejected; supply a lowercase scheme.
 */
function applyIdentityToTauriConf(tauriConf, buildConfig) {
  const app = (buildConfig && buildConfig.app) || {};
  let changed = false;

  if (app.identifier) {
    if (!/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(app.identifier)) {
      throw new Error(
        `brand identity: invalid identifier '${app.identifier}' — must be reverse-DNS (e.g. com.acme.app), letters/digits/hyphens, no underscores`
      );
    }
    if (tauriConf.identifier !== app.identifier) {
      tauriConf.identifier = app.identifier;
      changed = true;
    }
  }

  if (app.scheme) {
    if (!/^[a-z][a-z0-9+.-]*$/.test(app.scheme)) {
      throw new Error(
        `brand identity: invalid scheme '${app.scheme}' — must start with a lowercase letter, then [a-z0-9+.-]`
      );
    }
    if (!tauriConf.plugins) tauriConf.plugins = {};
    if (!tauriConf.plugins["deep-link"]) tauriConf.plugins["deep-link"] = {};
    if (!tauriConf.plugins["deep-link"].desktop) tauriConf.plugins["deep-link"].desktop = {};
    const desktop = tauriConf.plugins["deep-link"].desktop;
    if (desktop.schemes?.length !== 1 || desktop.schemes[0] !== app.scheme) {
      desktop.schemes = [app.scheme];
      changed = true;
    }
  }

  return changed;
}

/**
 * Apply the configured app name/short name to a parsed extension manifest.json
 * object (mutates it). Both fields are browser-facing labels, so they follow
 * `app.displayName` and fall back to `app.name`.
 *
 * The description follows the same brand, read from `extension.description`
 * (or `extensions.description`). Leaving it unbranded is what shipped a
 * "Copilot 361" package still describing itself as TeamClu — the Chrome Web
 * Store shows the package name and description side by side, and a mismatch
 * between them reads to a reviewer as a misleading listing.
 *
 * Returns true if anything changed.
 */
function applyNameToExtensionManifest(manifest, buildConfig) {
  const cfg = buildConfig || {};
  const app = cfg.app || {};
  const extensionBlock =
    (cfg.extension && typeof cfg.extension === "object" ? cfg.extension : null) ||
    (cfg.extensions && typeof cfg.extensions === "object" ? cfg.extensions : null) ||
    {};
  const name = app.displayName || app.name;
  const description = extensionBlock.description || app.description;
  let changed = false;

  if (name) {
    if (manifest.name !== name) {
      manifest.name = name;
      changed = true;
    }
    if (manifest.action && manifest.action.default_title !== name) {
      manifest.action.default_title = name;
      changed = true;
    }
  }

  if (description && manifest.description !== description) {
    // Chrome truncates past 132 chars in the toolbar tooltip and rejects >132
    // in the manifest, so fail the build rather than ship a silently cut label.
    if (String(description).length > 132) {
      throw new Error(
        `brand identity: extension description is ${String(description).length} chars — Chrome allows at most 132`
      );
    }
    manifest.description = description;
    changed = true;
  }

  return changed;
}

/**
 * Build a (side-effect-free) plan describing where to copy pre-rendered
 * extension icons from, if the branding repo ships them. Unlike the desktop
 * icon set (generated from a single source logo via `tauri icon`), the
 * extension expects exact 16/48/128px PNGs — the branding repo provides
 * these directly under branding/extension/icons/icon-{16,48,128}.png so CI
 * does not need image-processing tooling. Returns null when none are present.
 */
function resolveExtensionIconPlan(repoRoot) {
  const fs = require("fs");
  const srcDir = path.join(repoRoot, "branding/extension/icons");
  if (!fs.existsSync(srcDir)) return null;
  const names = ["icon-16.png", "icon-48.png", "icon-128.png"];
  const files = names
    .map((name) => ({ name, source: path.join(srcDir, name) }))
    .filter((f) => fs.existsSync(f.source));
  if (files.length === 0) return null;
  const outDir = path.join(repoRoot, "apps/extension/icons");
  return {
    outDir,
    files: files.map((f) => ({ source: f.source, dest: path.join(outDir, f.name) })),
  };
}

module.exports = {
  applyNameToTauriConf,
  resolveLogoPlan,
  applyIdentityToTauriConf,
  applyNameToExtensionManifest,
  resolveExtensionIconPlan,
};
