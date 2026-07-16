"use strict";

/**
 * Parsers for the two deploy manifests that hand env vars to services/fc.
 *
 * services/fc is deployed two ways and each declares its own env list:
 *   - Alibaba Function Compute  -> services/fc/s.yaml (environmentVariables:)
 *   - self-hosted container     -> deploy/self-host/docker-compose.yml (fc.environment:)
 *
 * The compose map is an explicit ALLOWLIST: a var absent from it never reaches
 * the container no matter what the box's .env says. So the two lists drift
 * silently, and a var added to only one side is invisible until the feature
 * misbehaves in that deployment. env-manifest.test.js pins the difference.
 *
 * These parsers are deliberately line-based (no YAML dependency): they only
 * need the KEYS of one known block in each file. Callers must sanity-check the
 * returned length — a silently-empty parse would make a drift test vacuously
 * pass, which is the exact failure this is meant to catch.
 */

/**
 * Collect the map keys directly under the first line matching `blockHeaderRe`.
 * Only keys exactly one level (2 spaces) deeper are returned, so nested maps
 * and the block's siblings are ignored. Returns null when the block is absent.
 */
function keysUnderBlock(text, blockHeaderRe) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => blockHeaderRe.test(line));
  if (start === -1) return null;
  const baseIndent = lines[start].match(/^ */)[0].length;
  const keys = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const indent = line.match(/^ */)[0].length;
    if (indent <= baseIndent) break;
    const m = line.match(/^ *([A-Za-z0-9_]+):/);
    if (m && indent === baseIndent + 2) keys.push(m[1]);
  }
  return keys;
}

/** Env var names declared in services/fc/s.yaml. */
function parseSyamlEnvVars(text) {
  return keysUnderBlock(text, /^ *environmentVariables: *$/);
}

/**
 * Env var names in the `fc` service's `environment:` map of
 * deploy/self-host/docker-compose.yml. Scoped to the fc service block first —
 * every other service has an `environment:` map too.
 */
function parseComposeFcEnvVars(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => /^ {2}fc: *$/.test(line));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}\S/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return keysUnderBlock(lines.slice(start, end).join("\n"), /^ *environment: *$/);
}

module.exports = { keysUnderBlock, parseSyamlEnvVars, parseComposeFcEnvVars };
