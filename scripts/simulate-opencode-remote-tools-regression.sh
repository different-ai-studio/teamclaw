#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

cargo test -p amuxd opencode_desktop_attach_does_not_drop_plugin_remote_tools -- --nocapture
