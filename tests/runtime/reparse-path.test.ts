import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { pathToFileURL } from "node:url";
import { assertSafeMigrationTarget, isReparsePath } from "../../packages/app-core/src/locations.ts";
import { isAppPage } from "../../apps/desktop/src/main/permissions.ts";

/** The 8.3 short form of an existing path, or null where the volume does not make short names. */
function shortPath(target: string): string | null {
  const result = spawnSync("cmd.exe", ["/d", "/c", `for %I in ("${target}") do @echo %~sI`], { encoding: "utf8", windowsHide: true, windowsVerbatimArguments: true });
  const short = result.stdout.trim();
  return result.status === 0 && short && short.toLowerCase() !== target.toLowerCase() && fs.existsSync(short) ? short : null;
}

describe.skipIf(process.platform !== "win32")("telling a link from another spelling of the same folder", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "manga-reparse-"));
  const real = path.join(root, "a folder with a long name");
  const inner = path.join(real, "inner");
  fs.mkdirSync(inner, { recursive: true });
  const junction = path.join(root, "junction");
  fs.symlinkSync(real, junction, "junction");

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it("flags a junction and a folder reached through one", () => {
    expect(isReparsePath(junction)).toBe(true);
    expect(isReparsePath(path.join(junction, "inner"))).toBe(true);
    expect(() => assertSafeMigrationTarget(path.join(root, "profile"), path.join(junction, "inner"))).toThrow(/reparse points or links/);
  });

  it("accepts a plain folder, a folder not created yet, and the same folder spelled in another letter case", () => {
    expect(isReparsePath(inner)).toBe(false);
    expect(isReparsePath(path.join(real, "not yet"))).toBe(false);
    expect(isReparsePath(inner.toUpperCase())).toBe(false);
  });

  it("accepts the same folder through its 8.3 short name, as the temporary folder of a CI runner is spelled", (ctx) => {
    const short = shortPath(inner);
    if (!short) ctx.skip();
    expect(isReparsePath(short!)).toBe(false);
    expect(() => assertSafeMigrationTarget(path.join(root, "profile"), short!)).not.toThrow();
  });
});

describe.skipIf(process.platform !== "win32")("the app's own page started through a short name", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "manga-page-"));
  const folder = path.join(root, "an installation folder");
  fs.mkdirSync(folder, { recursive: true });
  const page = path.join(folder, "index.html");
  fs.writeFileSync(page, "<!doctype html>\n");
  const other = path.join(root, "other.html");
  fs.writeFileSync(other, "<!doctype html>\n");

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it("is the same page whether its address uses the short or the long name", () => {
    const short = shortPath(folder);
    if (!short) return; // the volume makes no short names
    const appUrl = pathToFileURL(path.join(short, "index.html")).href;
    expect(isAppPage(`${pathToFileURL(page).href}#/light`, appUrl)).toBe(true);
    expect(isAppPage(pathToFileURL(other).href, appUrl)).toBe(false);
  });
});
