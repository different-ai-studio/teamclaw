import { describe, it, expect } from "vitest";
import { buildConfig, appDisplayName } from "@/lib/build-config";

describe("build-config auth.webSSO", () => {
  it("defaults webSSO to false in the fallback config", () => {
    // When no build.config.*.json overrides auth, webSSO must be off.
    expect(buildConfig.features.auth?.webSSO ?? false).toBe(false);
  });
});

describe("build-config app.displayName", () => {
  it("falls back to app.name when displayName is unset", () => {
    // app.name stays the bundle identity; displayName only overrides the label.
    expect(appDisplayName).toBe(buildConfig.app.displayName ?? buildConfig.app.name);
  });
});
