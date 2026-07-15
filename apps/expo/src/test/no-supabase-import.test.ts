import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Guardrail mirroring packages/app: the expo app is cloud-only and must never
// import the Supabase SDK. Scans both `src/` and the expo-router `app/` tree.
const __filename = fileURLToPath(import.meta.url);
const SELF = path.resolve(__filename);
const EXPO_ROOT = path.resolve(path.dirname(SELF), "..", "..");
const SCAN_DIRS = [path.join(EXPO_ROOT, "src"), path.join(EXPO_ROOT, "app")];

const SUPABASE_IMPORT_RE = /from\s+['"]@supabase\//;

function walk(dir: string, acc: string[] = []): string[] {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      walk(full, acc);
    } else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

describe("guardrail: no @supabase imports in expo source", () => {
  it("apps/expo src + app contain zero `from '@supabase/...'` lines", () => {
    const files = SCAN_DIRS.flatMap((dir) => walk(dir));
    const offenders: Array<{ file: string; line: number; text: string }> = [];
    for (const file of files) {
      if (path.resolve(file) === SELF) continue;
      const lines = fs.readFileSync(file, "utf8").split("\n");
      lines.forEach((line, idx) => {
        if (SUPABASE_IMPORT_RE.test(line)) {
          offenders.push({ file, line: idx + 1, text: line.trim() });
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
