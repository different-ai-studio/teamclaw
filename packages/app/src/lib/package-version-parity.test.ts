import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

type AppPackageJson = {
  dependencies?: Record<string, string>;
};

describe("package dependency version parity", () => {
  it("keeps react and react-dom on the exact same version", () => {
    const packageJsonPath = path.resolve(__dirname, "../../package.json");
    const packageJson = JSON.parse(
      readFileSync(packageJsonPath, "utf8"),
    ) as AppPackageJson;

    expect(packageJson.dependencies?.react).toBeDefined();
    expect(packageJson.dependencies?.["react-dom"]).toBeDefined();
    expect(packageJson.dependencies?.["react-dom"]).toBe(
      packageJson.dependencies?.react,
    );
  });
});
