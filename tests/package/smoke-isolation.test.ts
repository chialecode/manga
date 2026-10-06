import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const main = path.resolve(import.meta.dirname, "../../apps/desktop/src/main");

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? sources(full) : entry.name.endsWith(".ts") ? [full] : [];
  });
}

describe("test hooks stay out of a normal start (C5)", () => {
  const outside = sources(main).filter((file) => !file.startsWith(path.join(main, "smoke")));
  const smokeImport = /\bfrom\s+["']\.{1,2}\/(?:\.\.\/)*(?:main\/)?smoke(?:\/[^"']*)?["']|\bimport\s+["'][^"']*\/smoke\//;

  it("no module outside the smoke directory imports it statically", () => {
    for (const file of outside) expect(fs.readFileSync(file, "utf8"), path.basename(file)).not.toMatch(smokeImport);
  });

  it("the entry point loads it only with a dynamic import under the smoke flag", () => {
    const text = fs.readFileSync(path.join(main, "index.ts"), "utf8");
    const loads = [...text.matchAll(/import\(\s*["']\.\/smoke\/[^"']+["']\s*\)/g)];
    expect(loads).toHaveLength(1);
    const before = text.slice(0, loads[0]!.index);
    expect(before.slice(before.lastIndexOf("if (")).startsWith("if (smoke)")).toBe(true);
    expect(text).toMatch(/const smoke = process\.argv\.includes\("--manga-smoke"\)/);
  });

  it("the smoke directory is not reachable from the other main-process modules at all", () => {
    for (const file of outside) {
      const text = fs.readFileSync(file, "utf8");
      const mentions = [...text.matchAll(/["'](\.{1,2}\/[^"']*smoke[^"']*)["']/g)].map((match) => match[1]);
      expect(mentions, path.basename(file)).toEqual(file.endsWith(`${path.sep}index.ts`) ? ["./smoke/index.ts"] : []);
    }
  });
});
