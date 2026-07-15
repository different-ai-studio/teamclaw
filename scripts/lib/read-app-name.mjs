import fs from "node:fs";
import path from "node:path";

/**
 * Resolve the desktop app display / bundle name for install docs and release notes.
 * Prefers build.config.json (production branding), then tauri.conf.json productName.
 */
export function readAppName(repoRoot = process.cwd()) {
  const candidates = [
    {
      file: "build.config.json",
      pick: (json) => json?.app?.name,
    },
    {
      file: "apps/desktop/tauri.conf.json",
      pick: (json) => json?.productName,
    },
  ];

  for (const { file, pick } of candidates) {
    try {
      const raw = fs.readFileSync(path.join(repoRoot, file), "utf8");
      const name = pick(JSON.parse(raw));
      if (typeof name === "string" && name.trim()) {
        return name.trim();
      }
    } catch {
      // try next source
    }
  }

  return "TeamClaw";
}
