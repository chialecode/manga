import { defineConfig } from "vitest/config";

// Tests that spawn heavy external subprocesses run sequentially in their own projects after the parallel unit suite (#95):
// - `media`: FFmpeg/ffprobe pipelines (serialized so AT-80's PRIORITY_BELOW_NORMAL ffprobe calls are not starved on Windows).
// - `update`: Windows PowerShell/installer recovery tests (serialized so concurrent PowerShell/CIM probes do not time out under load).
const MEDIA_SUBPROCESS_TESTS = [
  "tests/agent/agent-media.test.ts",
  "tests/agent/agent-media-native.test.ts",
  "tests/agent/media-context.test.ts",
  "tests/agent/proposal-integrity.test.ts",
  "tests/agent/proposals.test.ts",
  "tests/creative/roughcut-export.test.ts",
  "tests/library/library-locations.test.ts",
  "tests/library/unassigned-recover.test.ts",
  "tests/light/light-open.test.ts",
  "tests/media/ffmpeg.test.ts",
  "tests/media/media-regressions.test.ts",
  "tests/metadata/local-file.test.ts",
  "tests/metadata/metadata-commands.test.ts",
  "tests/reading/video-player.test.tsx",
  "tests/shell/media-flows.test.tsx",
  "tests/shell/roughcut-ui.test.tsx",
  "tests/video/import-light.test.ts",
  "tests/video/video-commands.test.ts",
  "tests/video/video-regressions.test.ts",
];

const UPDATE_SUBPROCESS_TESTS = [
  "tests/update/install-dev-recovery.test.ts",
  "tests/update/release-and-install-dev.test.ts",
  "tests/update/release-integrity.test.ts",
];

const SUBPROCESS_TESTS = [...MEDIA_SUBPROCESS_TESTS, ...UPDATE_SUBPROCESS_TESTS];

// Environment per file: tests that need a DOM declare `/** @vitest-environment jsdom */` in their first line.
export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    setupFiles: ["tests/helpers/setup-dom.ts"],
    globalSetup: ["tests/helpers/global-temp.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: "forks",
    // Node 24's V8 (13.6) can abort while freeing WebAssembly code after a worker thread that ran it exits ("jit_page_->allocations_.erase(addr)
    // == 1", nodejs/node#66366, open; the V8 fix is not in a 24.x release yet). It took down the voice filter's test process once (LOOP-08).
    // The test processes keep WebAssembly code instead of collecting it; the app runs on Electron's own V8, not this Node.
    execArgv: ["--no-wasm-code-gc"],
    // Non-subprocess files run in parallel on half the logical processors (10 on the development machine, 2 on a CI runner): about 80 s instead of
    // about 480 s one file after another, with headroom so a test that waits for a render is not starved (LOOP-27; measured 2026-11-06, 计划 4.7).
    fileParallelism: true,
    maxWorkers: "50%",
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
          exclude: SUBPROCESS_TESTS,
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: "media",
          include: MEDIA_SUBPROCESS_TESTS,
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
      {
        extends: true,
        test: {
          name: "update",
          include: UPDATE_SUBPROCESS_TESTS,
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
