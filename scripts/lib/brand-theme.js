"use strict";

const fs = require("fs");
const path = require("path");

/**
 * Extract the CSS custom-property names declared in the bare top-level
 * `:root { … }` block of a stylesheet (NOT `.dark` or `:root[data-palette=…]`).
 * Used as the allow-list of valid brand-theme token names (single source of
 * truth so theme.json keys can't drift from the real palette tokens).
 */
function extractRootTokenNames(css) {
  // Every bare top-level `:root { … }` block (excludes `:root[data-palette="…"]`
  // — next char is `[` — and `.dark {}`). Merge tokens from all such blocks.
  const names = new Set();
  for (const block of css.matchAll(/:root(?!\[)\s*\{([^}]*)\}/g)) {
    for (const d of block[1].matchAll(/(--[a-zA-Z0-9_-]+)\s*:/g)) names.add(d[1]);
  }
  return names;
}

/**
 * Validate brand tokens against the allow-list and produce a single CSS rule
 * `:root[data-palette="<palette>"]{…}`. Throws (to fail the build) on an
 * unknown token name or a value containing CSS-breaking characters.
 */
function generateBrandThemeCss(palette, tokens, allowedTokens) {
  if (typeof palette !== "string" || !/^[a-zA-Z0-9_-]+$/.test(palette)) {
    throw new Error(`brand theme: invalid palette id: ${palette}`);
  }
  const entries = Object.entries(tokens || {});
  const unknown = entries
    .map(([k]) => k)
    .filter((k) => !k.startsWith("--") || !allowedTokens.has(k));
  if (unknown.length) {
    throw new Error(`brand theme: unknown token name(s): ${unknown.join(", ")}`);
  }
  const invalid = entries
    .filter(([, v]) => typeof v !== "string" || v.trim() === "" || /[;{}<]/.test(v))
    .map(([k]) => k);
  if (invalid.length) {
    throw new Error(`brand theme: invalid token value(s): ${invalid.join(", ")}`);
  }
  const body = entries.map(([k, v]) => `${k}:${v};`).join("");
  return `:root[data-palette="${palette}"]{${body}}`;
}

/**
 * Resolve the brand theme for the configured palette. Returns null when there
 * is nothing to generate (no palette, the built-in `default`/`teal` flavors,
 * or no theme.json on disk). Throws if a present theme.json is malformed.
 */
function resolveBrandTheme(buildConfig, repoRoot) {
  const palette = buildConfig && buildConfig.app && buildConfig.app.palette;
  if (!palette || palette === "default" || palette === "teal") return null;
  const themePath = path.join(repoRoot, "branding", palette, "theme.json");
  if (!fs.existsSync(themePath)) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(themePath, "utf8"));
  } catch (e) {
    throw new Error(`brand theme: ${themePath} is not valid JSON: ${e.message}`);
  }
  if (!parsed.tokens || typeof parsed.tokens !== "object" || Array.isArray(parsed.tokens)) {
    throw new Error(`brand theme: ${themePath} must have a "tokens" object`);
  }
  return { palette, tokens: parsed.tokens };
}

module.exports = { extractRootTokenNames, generateBrandThemeCss, resolveBrandTheme };
