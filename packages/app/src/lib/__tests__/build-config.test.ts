import { describe, it, expect } from "vitest";
import {
  buildConfig,
  appDisplayName,
  FALLBACK_BUILD_CONFIG,
  resolveAmuxdDirName,
} from "@/lib/build-config";

describe("build-config auth.webSSO", () => {
  it("defaults webSSO to false in the fallback config", () => {
    // Assert the fallback itself, not the merged `buildConfig`: a local run
    // bakes in build.config.dev.json, which turns webSSO on deliberately, so
    // reading the merged value made this test fail on every dev machine while
    // passing on CI.
    expect(FALLBACK_BUILD_CONFIG.features.auth?.webSSO ?? false).toBe(false);
  });
});

describe("build-config app.displayName", () => {
  it("falls back to app.name when displayName is unset", () => {
    // app.name stays the bundle identity; displayName only overrides the label.
    expect(appDisplayName).toBe(buildConfig.app.displayName ?? buildConfig.app.name);
  });
});

describe("resolveAmuxdDirName", () => {
  it("keeps official brands on ~/.amuxd and namespaces white-labels", () => {
    expect(resolveAmuxdDirName("teamclu")).toBe("amuxd");
    expect(resolveAmuxdDirName("teamcludev")).toBe("amuxd");
    expect(resolveAmuxdDirName("copilot361")).toBe("amuxd-copilot361");
  });
});
