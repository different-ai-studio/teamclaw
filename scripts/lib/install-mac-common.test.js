"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..", "..");
const commonSh = path.join(__dirname, "install-mac-common.sh");

function bash(fn, ...args) {
  const script = `
    set -euo pipefail
    source "${commonSh}"
    ${fn} "$@"
  `;
  return execFileSync("bash", ["-c", script, "bash", ...args], {
    encoding: "utf8",
  }).trim();
}

test("install_mac_read_config_app_name reads app.name from build config", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "install-mac-"));
  const cfg = path.join(dir, "build.config.json");
  fs.writeFileSync(cfg, JSON.stringify({ app: { name: "Copilot 361" } }));
  const name = bash("install_mac_read_config_app_name", cfg);
  assert.equal(name, "Copilot 361");
});

test("install_mac_product_name_candidates prefers APP_NAME and build.config", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "install-mac-"));
  fs.writeFileSync(
    path.join(dir, "build.config.json"),
    JSON.stringify({ app: { name: "Acme Chat" } }),
  );
  const out = bash(
    'APP_NAME="Override" install_mac_product_name_candidates',
    dir,
  );
  const lines = out.split("\n").filter(Boolean);
  assert.equal(lines[0], "Override");
  assert.ok(lines.includes("Acme Chat"));
  assert.ok(lines.includes("TeamClaw"));
});

test("install_mac_asset_slug replaces spaces with dots", () => {
  assert.equal(bash("install_mac_asset_slug", "Copilot 361"), "Copilot.361");
  assert.equal(bash("install_mac_asset_slug", "TeamClaw"), "TeamClaw");
});

test("install_mac_github_latest_tag resolves tag from releases/latest redirect", () => {
  const tag = execFileSync(
    "bash",
    [
      "-c",
      `
        set -euo pipefail
        source "${commonSh}"
        gh() { return 1; }
        curl() {
          printf '%s' "https://github.com/different-ai-studio/teamclaw/releases/tag/v1.2.3"
        }
        install_mac_github_latest_tag "different-ai-studio/teamclaw"
      `,
    ],
    { encoding: "utf8" },
  ).trim();
  assert.equal(tag, "v1.2.3");
});

test("install_mac_resolve_github_dmg_url finds branded aarch64 DMG without GitHub API assets", () => {
  const url = execFileSync(
    "bash",
    [
      "-c",
      `
        set -euo pipefail
        source "${commonSh}"
        install_mac_fetch_github_release_json() { return 1; }
        gh() { return 1; }
        curl() {
          local url="\${*: -1}"
          if [[ "\$url" == "https://github.com/different-ai-studio/teamclaw/releases/latest" ]]; then
            printf '%s' "https://github.com/different-ai-studio/teamclaw/releases/tag/v1.2.3"
            return 0
          fi
          if [[ "\$url" == "https://github.com/different-ai-studio/teamclaw/releases/download/v1.2.3/Copilot.361_1.2.3_aarch64.dmg" ]]; then
            printf '200'
            return 0
          fi
          printf '404'
          return 0
        }
        install_mac_resolve_github_dmg_url "different-ai-studio/teamclaw" "aarch64.dmg" ""
      `,
    ],
    { encoding: "utf8" },
  ).trim();
  assert.match(url, /Copilot\.361_.*_aarch64\.dmg$/);
});

test("install scripts pass bash syntax check", () => {
  for (const rel of [
    "scripts/install-mac.sh",
    "scripts/install-mac-cn.sh",
    "scripts/lib/install-mac-common.sh",
  ]) {
    execFileSync("bash", ["-n", path.join(repoRoot, rel)]);
  }
});

test("source_install_mac_common falls back to TEAMCLAW_SCRIPTS_RAW when local lib missing", () => {
  const scriptsDir = path.join(repoRoot, "scripts");
  execFileSync(
    "bash",
    [
      "-c",
      `
        set -euo pipefail
        TEAMCLAW_SCRIPTS_RAW="file://${scriptsDir}"
        source_install_mac_common() {
          local script_dir="\${1:-}"
          local local_lib="\${script_dir}/lib/install-mac-common.sh"
          if [[ -n "\$script_dir" && -f "\$local_lib" ]]; then
            source "\$local_lib"
            return 0
          fi
          local tmp
          tmp="\$(mktemp /tmp/teamclaw-install-common-XXXXXX.sh)"
          curl -fsSL "\${TEAMCLAW_SCRIPTS_RAW}/lib/install-mac-common.sh" -o "\$tmp"
          source "\$tmp"
          rm -f "\$tmp"
        }
        source_install_mac_common ""
        type install_mac_mount_dmg >/dev/null
      `,
    ],
  );
});
