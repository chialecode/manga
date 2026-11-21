import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EXPECTED_VERSION } from "../../apps/desktop/src/renderer/readers/pdf-doc.ts";
import { PDFJS_PARSER_ID, PDFJS_VERSION } from "../../packages/app-core/src/domain/pdfjs-assets.ts";

/**
 * The pdf.js version the readers check at run time is the one installed. The other tests load a fake pdf.js that says whatever version they are given, so
 * without this a dependency upgrade that leaves a written-down version behind is only caught by the packaged reader (A-132).
 */

const root = path.join(import.meta.dirname, "../..");
const installed = (workspace: string) => {
  const require = createRequire(path.join(root, workspace, "package.json"));
  const manifest = require.resolve("pdfjs-dist/package.json");
  return (JSON.parse(fs.readFileSync(manifest, "utf8")) as { version: string }).version;
};

describe("the pdf.js version", () => {
  it("is the installed one in the renderer's check and in the main process's assets", () => {
    expect(EXPECTED_VERSION).toBe(installed("apps/desktop"));
    expect(PDFJS_VERSION).toBe(installed("packages/app-core"));
    expect(PDFJS_PARSER_ID).toBe(`pdfjs-dist@${PDFJS_VERSION}`);
  });
});
