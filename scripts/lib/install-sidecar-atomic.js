#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const HASH_CHUNK = 8 * 1024 * 1024;

/** sha256 of a file, read in chunks so a 180MB sidecar never lands in one Buffer. */
function hashFile(file) {
  const hash = crypto.createHash("sha256");
  const buf = Buffer.allocUnsafe(HASH_CHUNK);
  const fd = fs.openSync(file, "r");
  try {
    let read;
    while ((read = fs.readSync(fd, buf, 0, HASH_CHUNK, null)) > 0) {
      hash.update(buf.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

/**
 * Install only when the bytes actually differ, and report whether it did.
 *
 * The desktop build script declares `rerun-if-changed=binaries/amuxd-<target>`,
 * so re-staging a byte-identical sidecar still bumps its mtime, which re-runs
 * that build script, recompiles teamclu_lib and relinks the whole binary. Dev
 * rebuilds the sidecar on every run, so an unconditional copy would hand that
 * cost to every single `tauri:dev` start.
 *
 * Compare by content, not size+mtime: `--force-amuxd` doubles as the recovery
 * path for a corrupted destination, and a corrupted file can keep its size.
 *
 * @param {string} built
 * @param {string} dest
 * @returns {boolean} true when dest was replaced
 */
function installSidecarIfChanged(built, dest) {
  if (fs.existsSync(dest) && fs.statSync(dest).size === fs.statSync(built).size) {
    if (hashFile(dest) === hashFile(built)) {
      return false;
    }
  }
  installSidecarAtomic(built, dest);
  return true;
}

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

module.exports = { installSidecarAtomic, installSidecarIfChanged, hashFile };
