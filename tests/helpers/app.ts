import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MangaProductApp, TestVault, type ProductAppOptions } from "@manga/app-core";
import { syntheticWav } from "@manga/model-protocol";

let seq = 0;

export function tempProfile(): string {
  seq += 1;
  return mkdtempSync(path.join(os.tmpdir(), "manga-test-"));
}

export async function startApp(overrides: { useParseWorker?: boolean; profileRoot?: string; hostId?: string; options?: Partial<ProductAppOptions> } = {}) {
  seq += 1;
  const profileRoot = overrides.profileRoot ?? tempProfile();
  const app = new MangaProductApp({
    profileRoot,
    channel: "test",
    documentsDir: path.join(profileRoot, "documents"),
    pointerPath: path.join(profileRoot, "launcher", "pointer.json"),
    hostId: overrides.hostId ?? `host-${seq}`,
    vault: new TestVault("test-vault"),
    useParseWorker: overrides.useParseWorker,
    ...overrides.options,
  });
  await app.start();
  const actor = { kind: "user" as const, id: "tester" };
  const grant = app.issueOwnerGrant(actor);
  return { app, actor, grant, profileRoot };
}

export async function waitForRun(
  app: MangaProductApp,
  actor: { kind: "user" | "agent"; id: string },
  grantHandle: string,
  runId: string,
  timeoutMs = 12_000,
) {
  const started = Date.now();
  let latest: Awaited<ReturnType<MangaProductApp["call"]>> | undefined;
  while (Date.now() - started < timeoutMs) {
    latest = await app.call(actor, { commandId: "agent.getRun", idempotencyKey: `wait-${runId}-${Date.now()}`, input: { runId } }, grantHandle);
    const status = String(latest.value?.status ?? latest.value?.run?.status ?? "");
    if (status && !["queued", "running", "waiting_input"].includes(status)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`run ${runId} did not finish: ${JSON.stringify(latest?.value ?? latest)}`);
}

export function writeTempWav(dir: string, name = "probe.wav"): string {
  const file = path.join(dir, name);
  writeFileSync(file, syntheticWav());
  return file;
}

/**
 * Makes `dir` a library path without starting a scan, so the files imported from it have a place to be read from (A-80). A folder that already
 * lies inside a library path is left alone.
 */
export function libraryRoot(app: Pick<MangaProductApp, "store">, dir: string, mediaKind: "novel" | "comic" | "video" = "novel"): string {
  const abs = path.resolve(dir);
  const same = (a: string, b: string) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
  const inside = (root: string, target: string) => same(root, target) || (process.platform === "win32" ? target.toLowerCase() : target).startsWith((process.platform === "win32" ? root.toLowerCase() : root) + path.sep);
  const rows = app.store.sqlite.prepare("SELECT id, path FROM library_paths WHERE managed = 0").all() as Array<{ id: string; path: string }>;
  if (rows.some((row) => inside(path.resolve(row.path), abs))) return abs;
  // Library paths never overlap: a folder that contains one that is already there has to be registered first.
  for (const row of rows) if (inside(abs, path.resolve(row.path))) throw new Error(`${abs} contains the library path ${row.path}; register the larger folder first`);
  app.store.sqlite.prepare("INSERT INTO library_paths(id, path, media_kind, auto_scan, created_at) VALUES (?,?,?,0,?)").run(`lpath_test_${seq++}`, abs, mediaKind, new Date().toISOString());
  return abs;
}
