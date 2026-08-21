#!/usr/bin/env node
/**
 * Compat shim — prefer `npx @teamclu/cli` or `pnpm marketplace:publish`.
 * Forwards to packages/cli so older docs/scripts keep working.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, "../packages/cli/bin/teamclu.js");
const result = spawnSync(process.execPath, [bin, "marketplace", "publish", ...process.argv.slice(2)], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
