import { defineConfig } from "vitest/config";

// Environment per file: tests that need a DOM declare `/** @vitest-environment jsdom */` in their first line.
export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    setupFiles: ["tests/helpers/setup-dom.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: "forks",
    // Node 24's V8 (13.6) can abort while freeing WebAssembly code after a worker thread that ran it exits ("jit_page_->allocations_.erase(addr)
    // == 1", nodejs/node#66366, open; the V8 fix is not in a 24.x release yet). It took down the voice filter's test process once (LOOP-08).
    // The test processes keep WebAssembly code instead of collecting it; the app runs on Electron's own V8, not this Node.
    execArgv: ["--no-wasm-code-gc"],
    fileParallelism: false,
  },
});
