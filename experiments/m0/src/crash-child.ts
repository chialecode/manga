import { MangaApp } from "./application/app.ts";

const profile = flag("--profile");
const crashAt = flag("--crash-at");
const op = flag("--op") ?? "notes.create";
if (!profile) {
  console.error("crash-child requires --profile");
  process.exit(2);
}

const app = new MangaApp({ profileDir: profile, hostId: "crash-child", crashAt });
await app.start(["library", "notes", "novel-reader", "download"]);
if (op === "notes.create") {
  await app.call({ kind: "user", id: "crash" }, {
    commandId: "notes.create",
    idempotencyKey: flag("--key") ?? "crash-note-1",
    input: { title: "crash", text: "persisted?" },
  });
}
if (op === "library.importText") {
  await app.call({ kind: "user", id: "crash" }, {
    commandId: "library.importText",
    idempotencyKey: "crash-import-1",
    input: { title: "crash-text", bytes: [...Buffer.from("crash body")] },
  });
}
app.close();
process.exit(0);

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}
