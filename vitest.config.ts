import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    // Property tests and 100-match sim runs need more than the 5s default.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
