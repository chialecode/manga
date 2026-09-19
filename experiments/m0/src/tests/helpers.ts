import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isolateDir, repoRoot } from "../env.ts";
import { MangaApp, type AppOptions } from "../application/app.ts";
import type { CaseResult } from "@manga/contracts";
import { sourceFingerprint } from "../report.ts";

export function user() {
  return { kind: "user" as const, id: "tester" };
}

export function agent() {
  return { kind: "agent" as const, id: "fake-agent" };
}

export function tempApp(options: Partial<AppOptions> = {}) {
  const profileDir = isolateDir("profile");
  const app = new MangaApp({ profileDir, hostId: "test-host", ...options });
  return { app, profileDir };
}

export async function startedApp(features = ["library", "notes", "novel-reader", "metadata", "download"]) {
  const ctx = tempApp();
  await ctx.app.start(features);
  return ctx;
}

export function crashChild(args: string[]): { status: number | null; stderr: string } {
  const child = fileURLToPath(new URL("../crash-child.ts", import.meta.url));
  const result = spawnSync(process.execPath, ["--experimental-strip-types", child, ...args], {
    encoding: "utf8",
    cwd: repoRoot(),
    env: { ...process.env },
  });
  return { status: result.status, stderr: result.stderr };
}

export function writeCases(poc: string, cases: CaseResult[]): void {
  const dir = path.resolve(process.env.M0_EVIDENCE_DIR ?? path.join(repoRoot(), "docs/evidence/m0-closure"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${poc}.json`), `${JSON.stringify({ poc, sourceFingerprint: sourceFingerprint(repoRoot()), cases, at: new Date().toISOString() }, null, 2)}\n`);
}

export function expectOk(result: { status: string; error?: { message: string } }, label: string): void {
  assert.equal(result.status, "ok", `${label}: ${result.error?.message ?? ""}`);
}
