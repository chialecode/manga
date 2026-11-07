import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MangaProductApp, TestVault } from "@manga/app-core";

let seq = 0;

export function tempProfile(): string {
  seq += 1;
  return mkdtempSync(path.join(os.tmpdir(), "manga-m1b-"));
}

export async function startApp(overrides: { useParseWorker?: boolean; profileRoot?: string } = {}) {
  seq += 1;
  const profileRoot = overrides.profileRoot ?? tempProfile();
  const app = new MangaProductApp({
    profileRoot,
    channel: "test",
    documentsDir: path.join(profileRoot, "documents"),
    pointerPath: path.join(profileRoot, "launcher", "pointer.json"),
    hostId: `m1b-${seq}`,
    vault: new TestVault("m1b-test-vault"),
    useParseWorker: overrides.useParseWorker,
  });
  await app.start();
  const actor = { kind: "user" as const, id: "tester" };
  const grant = app.issueOwnerGrant(actor);
  return { app, actor, grant, profileRoot };
}
