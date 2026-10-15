import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * The whiteboard (500 cards) and the mind map (1000 topics) in the real window. The window seeds its own empty Profile through the commands,
 * then opens the board and the map from the project's tabs and takes the timings inside the page (see apps/desktop/src/main/smoke/bench-canvas.ts).
 */
export async function runCanvasBench({ launch, cards, nodes, openRuns, zoomSamples, dragSamples, foldRounds }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manga-bench-canvas-"));
  const specFile = path.join(dir, "spec.json");
  fs.writeFileSync(specFile, JSON.stringify({ cards, nodes, openRuns, zoomSamples, dragSamples, foldRounds }));
  const root = path.join(dir, "root");
  const env = {
    ...process.env,
    MANGA_CHANNEL: "test",
    MANGA_PROFILE_ROOT: root,
    MANGA_DOCUMENTS_DIR: path.join(dir, "documents"),
    MANGA_POINTER_FILE: path.join(dir, "launcher", "pointer.json"),
    MANGA_SMOKE_PHASE: "bench-canvas",
    MANGA_SMOKE_CANVAS_SPEC: specFile,
    MANGA_SMOKE_LAUNCHED_AT: String(Date.now()),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = launch(env, dir);
  const file = path.join(root, "logs", "bench-canvas-window.json");
  const measured = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined;
  if (!child || child.status !== 0 || !measured) {
    return { ok: false, reason: `canvas window run failed (exit ${child?.status}, ${child?.error?.message ?? "no spawn error"})`, stdout: child?.stdout?.slice(-2000), stderr: child?.stderr?.slice(-2000), measured, dir };
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return measured;
}
