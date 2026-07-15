#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readAppName } from "./lib/read-app-name.mjs";

const REPO = "different-ai-studio/teamclaw-next";

export function renderDesktopReleaseBody({
  appName = readAppName(),
  repo = REPO,
  macArchHint = !process.argv.includes("--no-arch-hint"),
} = {}) {
  const appBundle = `/Applications/${appName}.app`;
  const quarantineCmd = `sudo xattr -dr com.apple.quarantine ${JSON.stringify(appBundle)}`;
  const dmgHint = macArchHint
    ? " (choose `aarch64` for Apple Silicon, `x64` for Intel)"
    : "";

  return `## Installation

### macOS (one-line install)
\`\`\`bash
curl -fsSL https://raw.githubusercontent.com/${repo}/main/scripts/install-mac.sh | bash
\`\`\`

### macOS (manual)
1. Download the \`.dmg\` file below${dmgHint}
2. Open the DMG and drag **${appName}** to Applications
3. Before opening, run in Terminal:
   \`\`\`
   ${quarantineCmd}
   \`\`\`
4. Open **${appName}** from Applications

> **Why is this needed?** ${appName} is not yet notarized with Apple. macOS blocks unsigned apps downloaded from the internet. The command above removes this restriction.

### Windows
Download and run the \`.exe\` installer below.
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.stdout.write(renderDesktopReleaseBody());
}
