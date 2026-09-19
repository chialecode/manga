import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MangaProductApp, TestVault } from "@manga/app-core";
import { syntheticWav } from "@manga/model-protocol";

let seq = 0;

export function tempProfile(): string {
  seq += 1;
  return mkdtempSync(path.join(os.tmpdir(), "manga-m1a-"));
}

export async function startApp(overrides: { useParseWorker?: boolean; profileRoot?: string; hostId?: string } = {}) {
  seq += 1;
  const profileRoot = overrides.profileRoot ?? tempProfile();
  const app = new MangaProductApp({
    profileRoot,
    channel: "test",
    documentsDir: path.join(profileRoot, "documents"),
    pointerPath: path.join(profileRoot, "launcher", "pointer.json"),
    hostId: overrides.hostId ?? `host-${seq}`,
    vault: new TestVault("m1a-test-vault"),
    useParseWorker: overrides.useParseWorker,
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
