import { MangaProductApp } from "./product-app.ts";
import fs from "node:fs";
import path from "node:path";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

const profile = flag("--profile");
const crashAt = flag("--crash-at");
const op = flag("--op") ?? "notes.create";
if (!profile) {
  console.error("crash-child requires --profile");
  process.exit(2);
}

const { TestVault } = await import("./credentials.ts");
const app = new MangaProductApp({
  profileRoot: profile,
  channel: "test",
  documentsDir: path.join(profile, "documents"),
  pointerPath: path.join(profile, "launcher", "pointer.json"),
  hostId: "crash-child",
  crashAt,
  vault: new TestVault("test-secret"),
});
await app.start();
const actor = { kind: "user" as const, id: "crash" };
const grant = app.issueOwnerGrant(actor);
if (op === "notes.create") {
  await app.call(actor, {
    commandId: "notes.create",
    idempotencyKey: flag("--key") ?? "crash-note-1",
    input: { title: "crash", text: "persisted?" },
  }, grant.handle);
}
if (op === "library.importText") {
  await app.call(actor, {
    commandId: "library.importText",
    idempotencyKey: "crash-import-1",
    input: { title: "crash-text", bytes: [...Buffer.from("crash body")] },
  }, grant.handle);
}
if (op === "package.import") {
  const source = flag("--source");
  if (!source) process.exit(2);
  const handle = app.registerPath("import", source);
  await app.call(actor, {
    commandId: "library.importPackage",
    idempotencyKey: "crash-package-1",
    input: { pathHandle: handle },
  }, grant.handle);
}
if (op === "locations.apply") {
  const target = flag("--target");
  if (!target) process.exit(2);
  fs.mkdirSync(target, { recursive: true });
  const handle = app.registerPath("directory", target);
  const proposed = await app.call(actor, {
    commandId: "settings.proposeLocations",
    idempotencyKey: "crash-loc-propose",
    input: { pathHandle: handle },
  }, grant.handle);
  if (proposed.status !== "ok") process.exit(3);
  await app.call(actor, {
    commandId: "settings.applyLocations",
    idempotencyKey: "crash-loc-apply",
    input: { checkpointId: proposed.value?.checkpointId, pathHandle: handle },
  }, grant.handle);
}
app.close();
process.exit(0);
