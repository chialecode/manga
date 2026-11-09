import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The system temporary folder around a gate run (LOOP-26). `stage package` and `stage bench` make isolated Profiles, sample libraries and plugin
 * homes there; a run that passed removes what it made under these prefixes and then must leave no other new `manga-*` entry, and a run that failed
 * keeps everything it made and names it in the log, for the person looking into the failure.
 */
export const GATE_TEMP_PREFIXES = [
  "manga-package-",
  "manga-smoke-library-",
  "manga-bench-",
  "manga-cold-",
  "manga-installer-",
  "manga-release-rehearsal-",
  "manga-release-build-",
  "manga-update-",
  "manga-smoke-key-",
  "manga-light-",
  "manga-full-open-",
];

const entries = () => {
  try { return new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("manga-"))); } catch { return new Set(); }
};

/** Starts watching; `passed()` cleans up and answers what is still left over, and a failed exit names what was kept. */
export function watchGateTemp(check) {
  const before = entries();
  let settled = false;
  const made = () => [...entries()].filter((name) => !before.has(name));
  process.on("exit", (code) => {
    if (settled || code === 0) return;
    const kept = made();
    if (kept.length) console.error(JSON.stringify({ check, kept: kept.map((name) => path.join(os.tmpdir(), name)) }));
  });
  return {
    /** The run passed: its own entries under the gate's prefixes are removed; any other new `manga-*` entry is reported (and fails the run). */
    passed() {
      settled = true;
      let removed = 0;
      for (const name of made()) {
        if (!GATE_TEMP_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
        try { fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); removed += 1; } catch { /* counted below */ }
      }
      const left = made();
      return { removed, left: left.length, prefixes: [...new Set(left.map((name) => name.replace(/[^-]*$/, "")))] };
    },
  };
}
