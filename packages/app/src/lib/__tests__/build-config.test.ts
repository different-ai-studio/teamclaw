import { describe, it, expect } from "vitest";
import { buildConfig } from "@/lib/build-config";

describe("build-config auth.webSSO", () => {
  it("defaults webSSO to false in the fallback config", () => {
    // When no build.config.*.json overrides auth, webSSO must be off.
    expect(buildConfig.features.auth?.webSSO ?? false).toBe(false);
  });
});
