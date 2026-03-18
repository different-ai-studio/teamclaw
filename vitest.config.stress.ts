import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/stress/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 40 * 60 * 1000,
    hookTimeout: 120_000,
  },
});
