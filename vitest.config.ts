import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    exclude: ["tests/fixtures/**", "node_modules/**", "dist/**"],
    testTimeout: 30_000,
  },
});
