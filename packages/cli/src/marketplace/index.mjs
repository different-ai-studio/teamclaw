import { publishSkill } from "./publish.mjs";

export async function runMarketplace(argv) {
  const action = argv[0];
  const rest = argv.slice(1);
  if (!action || action === "-h" || action === "--help") {
    console.error(
      "Usage: teamclu marketplace publish <skill-dir> --slug <slug> --changelog <text> [--promote] [--no-create]",
    );
    process.exit(action ? 0 : 2);
  }
  if (action === "publish") {
    await publishSkill(rest);
    return;
  }
  console.error(`Unknown marketplace action: ${action}`);
  console.error("Available: publish");
  process.exit(2);
}
