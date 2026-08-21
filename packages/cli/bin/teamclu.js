#!/usr/bin/env node
/**
 * @teamclu/cli entry — routes `teamclu <domain> <action> …`
 *
 * Domains in use: marketplace
 * Reserved (planned): mcp, env, knowledge
 */
import { runMarketplace } from "../src/marketplace/index.mjs";

const DOMAINS = {
  marketplace: {
    status: "ready",
    run: runMarketplace,
    help: "marketplace publish <dir> --slug <slug> --changelog <text> [--promote] [--no-create]",
  },
  mcp: {
    status: "planned",
    help: "mcp … (reserved — not implemented yet)",
  },
  env: {
    status: "planned",
    help: "env … (reserved — not implemented yet)",
  },
  knowledge: {
    status: "planned",
    help: "knowledge … (reserved — not implemented yet)",
  },
};

function printHelp(code = 0) {
  const lines = [
    "Usage: teamclu <domain> <action> [options]",
    "",
    "Domains:",
  ];
  for (const [name, d] of Object.entries(DOMAINS)) {
    const tag = d.status === "ready" ? "" : `  [${d.status}]`;
    lines.push(`  ${name.padEnd(12)} ${d.help}${tag}`);
  }
  lines.push(
    "",
    "Env (marketplace):",
    "  TEAMCLU_API_BASE or MARKETPLACE_API_BASE   default https://api.teamclu-dev.ucar.cc",
    "  TEAMCLU_ADMIN_SECRET or MARKETPLACE_ADMIN_SECRET  required (x-webhook-secret)",
    "",
    "Install:",
    "  npx @teamclu/cli marketplace publish ./skill --slug x --changelog '…' --promote",
    "  npm i -g @teamclu/cli && teamclu marketplace publish …",
  );
  console.error(lines.join("\n"));
  process.exit(code);
}

const argv = process.argv.slice(2);
if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
  printHelp(0);
}

const domain = argv[0];
const rest = argv.slice(1);
const entry = DOMAINS[domain];

if (!entry) {
  console.error(`Unknown domain: ${domain}\n`);
  printHelp(2);
}

if (entry.status !== "ready") {
  console.error(`Domain "${domain}" is reserved but not implemented yet.`);
  console.error(`Planned help: ${entry.help}`);
  process.exit(2);
}

entry.run(rest).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
