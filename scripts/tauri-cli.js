#!/usr/bin/env node
"use strict";

const { spawn } = require("child_process");
const { platform } = process;

const args = process.argv.slice(2);
const isWindows = platform === "win32";
const sub = args[0];

// On Windows, dev/build must use --no-default-features to avoid wmi/windows-core conflict (p2p/iroh).
// Strip any --features p2p so the broken dependency is not pulled in.
if (isWindows && (sub === "dev" || sub === "build")) {
  const filtered = args.filter((a, i) => {
    if (a === "--features" && args[i + 1] === "p2p") return false;
    if (a === "p2p" && args[i - 1] === "--features") return false;
    return true;
  });
  if (!filtered.includes("--no-default-features")) {
    const dashIdx = filtered.indexOf("--");
    const cargoFlags = ["--no-default-features"];
    if (dashIdx >= 0) {
      filtered.splice(dashIdx + 1, 0, ...cargoFlags);
    } else {
      filtered.push("--", ...cargoFlags);
    }
  }
  args.length = 0;
  args.push(...filtered);
}

// Unset CI so tauri/cargo don't treat this as CI (e.g. for build output).
const env = { ...process.env };
delete env.CI;

// Workaround: Xcode 26 beta clang reports "arm64-apple-darwin" which causes
// bindgen to fail with an assertion error (expects "aarch64-apple-darwin").
if (platform === "darwin" && process.arch === "arm64" && !env.BINDGEN_EXTRA_CLANG_ARGS) {
  env.BINDGEN_EXTRA_CLANG_ARGS = "--target=aarch64-apple-darwin";
}

// Build command string with proper quoting for shell
const commandStr = args.map((arg) => {
  // Quote arguments that contain spaces or special characters (like JSON)
  if (/[\s'"${}\\]/.test(arg)) {
    return "'" + arg.replace(/'/g, "'\\''") + "'";
  }
  return arg;
}).join(" ");

const child = spawn("tauri " + commandStr, [], {
  stdio: "inherit",
  shell: true,
  env,
});
child.on("exit", (code) => process.exit(code ?? 0));
