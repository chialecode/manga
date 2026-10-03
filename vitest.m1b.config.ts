import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    include: ["tests/m1b/**/*.test.ts", "tests/m1b/**/*.test.tsx"],
    environment: "node",
    environmentMatchGlobs: [["tests/m1b/**/*.test.tsx", "jsdom"]],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: "forks",
    fileParallelism: false,
  },
});
