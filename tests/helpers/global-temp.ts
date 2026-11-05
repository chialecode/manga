import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Every temporary directory a test run makes, in the test processes and in what they start, lands under one root of this run, which is removed when
 * the run ends (LOOP-25). `MANGA_KEEP_TEST_TMP=1` keeps it for looking at what a failed test left behind.
 */
export const TEST_TMP_PREFIX = "manga-vitest-run-";
export const TEST_TMP_ENV = "MANGA_TEST_TMP_ROOT";
const KEYS = [TEST_TMP_ENV, "TMP", "TEMP", "TMPDIR"] as const;

export function testTempRoot(): string {
  const configured = process.env[TEST_TMP_ENV];
  if (configured && fs.existsSync(configured)) return configured;
  return os.tmpdir();
}

export default function setup(): () => Promise<void> {
  const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), TEST_TMP_PREFIX));
  for (const key of KEYS) process.env[key] = root;
  return async () => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
    if (process.env.MANGA_KEEP_TEST_TMP === "1") {
      console.log(`test temporary files kept in ${root}`);
      return;
    }
    let lastError: unknown;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch (error) {
        lastError = error;
      }
      if (!fs.existsSync(root)) return;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    console.warn(`test temporary files could not all be removed: ${lastError instanceof Error ? lastError.message : String(lastError ?? root)}`);
  };
}
