import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cdnEnabled, signCdnUrl } from "../src/lib/cdn.js";

function withEnv(env: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("cdnEnabled requires both domain and auth key", () => {
  withEnv({ CDN_DOMAIN: undefined, CDN_AUTH_KEY: undefined }, () =>
    assert.equal(cdnEnabled(), false),
  );
  withEnv({ CDN_DOMAIN: "amux.ucar.cc", CDN_AUTH_KEY: undefined }, () =>
    assert.equal(cdnEnabled(), false),
  );
  withEnv({ CDN_DOMAIN: "amux.ucar.cc", CDN_AUTH_KEY: "k" }, () =>
    assert.equal(cdnEnabled(), true),
  );
});

test("signCdnUrl builds an Alibaba type-A signed URL", () => {
  withEnv({ CDN_DOMAIN: "amux.ucar.cc", CDN_AUTH_KEY: "secretkey", CDN_SCHEME: undefined }, () => {
    const ossKey = "teams/abc/blobs/sha256/27/15/2715deadbeef";
    const now = 1_700_000_000;
    const ttl = 900;
    const url = signCdnUrl(ossKey, ttl, now);
    const u = new URL(url);
    assert.equal(u.protocol, "https:");
    assert.equal(u.host, "amux.ucar.cc");
    assert.equal(u.pathname, "/" + ossKey);
    const ts = now + ttl;
    const expectedMd5 = createHash("md5")
      .update(`/${ossKey}-${ts}-0-0-secretkey`)
      .digest("hex");
    assert.equal(u.searchParams.get("auth_key"), `${ts}-0-0-${expectedMd5}`);
  });
});

test("signCdnUrl honours CDN_SCHEME and strips extra leading slashes", () => {
  withEnv({ CDN_DOMAIN: "amux.ucar.cc", CDN_AUTH_KEY: "k", CDN_SCHEME: "http" }, () => {
    const url = signCdnUrl("//teams/x/y", 60, 1000);
    const u = new URL(url);
    assert.equal(u.protocol, "http:");
    assert.equal(u.pathname, "/teams/x/y");
  });
});

test("signCdnUrl throws when CDN not configured", () => {
  withEnv({ CDN_DOMAIN: undefined, CDN_AUTH_KEY: undefined }, () => {
    assert.throws(() => signCdnUrl("teams/x", 900, 1));
  });
});
