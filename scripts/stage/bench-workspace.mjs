import fs from "node:fs";
import path from "node:path";
import { phase } from "./bench-reader.mjs";
import { repoRoot } from "./lib.mjs";

/**
 * The workspace in the real window (plan 7; see apps/desktop/src/main/smoke/bench-workspace.ts):
 *
 * - `window`: switching tabs, switching contexts (loaded, and made anew after a restart), the readers kept loaded after ten were opened, and the frames
 *   given to the page while a video plays in four columns.
 * - `memory`: what the application's working set grows by from a video in a single column to the four columns.
 *
 * The first runs in one window; the memory figure runs in a window of its own for each sample, because a window that has shown a player keeps the memory it
 * was given (see bench-reader.mjs).
 */
export async function runWorkspaceBench({ executable, args, window: windowSpec, memory }) {
  if (!fs.existsSync(path.join(repoRoot, "dist/samples/media/manifest.json"))) return { ok: false, reason: "the synthetic samples are missing; run: node scripts/samples/generate-media-samples.mjs" };
  const common = { executable, args, specEnv: "MANGA_SMOKE_WORKSPACE_SPEC" };
  const measured = await phase({ ...common, name: "bench-workspace", spec: windowSpec, file: "bench-workspace-window.json" });
  const rows = [];
  const raw = [];
  const failures = [];
  const stderr = [];
  for (let i = 0; i < memory.runs; i += 1) {
    const one = await phase({ ...common, name: "bench-workspace-memory", spec: { runs: 1 }, file: "bench-workspace-memory-window.json" });
    if (!one.ok) failures.push(...(one.failures ?? [one.reason ?? "the window run failed"]));
    if (!one.ok && one.stderr) stderr.push(one.stderr);
    raw.push(...(one.raw ?? []));
    rows.push(...(one.rows ?? []));
  }
  return { window: measured, memory: { ok: failures.length === 0 && raw.length === memory.runs, failures, raw, rows, unit: "MiB", stderr: stderr.join(" | ") } };
}
