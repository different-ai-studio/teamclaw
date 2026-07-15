import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/v2-e2e/**/*.test.ts"],
    environment: "node",
    passWithNoTests: true,
    fileParallelism: false,
    testTimeout: 90_000,
    hookTimeout: 120_000,
    sequence: {
      shuffle: false,
      concurrent: false,
    },
  },
});
