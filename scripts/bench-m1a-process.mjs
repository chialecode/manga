import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { MangaProductApp, TestVault } from "../packages/app-core/src/index.ts";

const profile = process.argv[2];
const out = process.argv[3];
if (!profile || !out) {
  console.error("usage: bench-m1a-process.mjs <profileRoot> <out.json>");
  process.exit(2);
}

const started = performance.now();
const app = new MangaProductApp({
  profileRoot: profile,
  documentsDir: path.join(profile, "documents"),
  pointerPath: path.join(profile, "launcher", "pointer.json"),
  channel: "test",
  hostId: `cold-${process.pid}-${Date.now()}`,
  vault: new TestVault("bench"),
});
await app.start();
const ms = performance.now() - started;
app.close();
fs.writeFileSync(out, `${JSON.stringify({ ms })}\n`);
