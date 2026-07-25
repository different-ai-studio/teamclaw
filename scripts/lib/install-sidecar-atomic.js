#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

/**
 * Install via temp file + rename so the destination path gets a new inode.
 * In-place `copyFileSync(built, dest)` over a running Mach-O corrupts the
 * mapped text pages on macOS and leaves later execs hung in UE.
 *
 * @param {string} built
 * @param {string} dest
 */
function installSidecarAtomic(built, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp.${process.pid}`;
  try {
    fs.copyFileSync(built, tmp);
    if (process.platform !== "win32") {
      fs.chmodSync(tmp, 0o755);
    }
    try {
      fs.renameSync(tmp, dest);
    } catch (err) {
      // Windows (and some NFS): rename refuses to replace an existing file.
      if (fs.existsSync(dest)) {
        fs.rmSync(dest, { force: true });
      }
      fs.renameSync(tmp, dest);
      void err;
    }
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // best-effort cleanup
    }
    throw err;
  }
}

module.exports = { installSidecarAtomic };
