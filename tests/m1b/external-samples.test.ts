import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseEpubBytes, parseMobiBytes, parsePdfBytes } from "@manga/app-core";

/**
 * Independent source samples: written by scripts/build-m1b-samples.py (CPython stdlib) rather than by
 * the in-repo fixture builders, so the parsers are exercised on containers they did not author.
 */
const root = path.resolve(__dirname, "..", "..");
const samplesDir = path.join(root, "tests", "m1b", "samples", "external");
const manifest = JSON.parse(fs.readFileSync(path.join(samplesDir, "manifest.json"), "utf8")) as {
  generator: string;
  toolchain: string;
  samples: Array<{ name: string; bytes: number; sha256: string }>;
};

function sample(name: string): Uint8Array {
  const declared = manifest.samples.find((item) => item.name === name);
  expect(declared, `${name} is listed in the sample manifest`).toBeTruthy();
  const bytes = fs.readFileSync(path.join(samplesDir, name));
  // The recorded hash pins the exact artefact these results belong to.
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(declared!.sha256);
  expect(bytes.byteLength).toBe(declared!.bytes);
  return new Uint8Array(bytes);
}

describe("M1b independent reading samples", () => {
  it("reads an EPUB written by an external zip writer", () => {
    const parsed = parseEpubBytes(sample("reading-sample.epub"));
    expect(parsed.format).toBe("epub");
    expect(parsed.title).toBe("外部样本书");
    expect(parsed.parts.map((part) => part.id)).toEqual(["c1", "c2", "plate"]);
    const first = parsed.parts[0]!;
    expect(first.normalized).toContain("第一段正文");
    expect(first.normalized).toContain("emoji");
    // Script and author CSS never reach the readable text, and the illustration stays per chapter.
    expect(first.normalized).not.toContain("must not leak");
    expect(first.normalized).not.toContain("margin");
    expect(first.images?.length).toBe(1);
    expect(parsed.traits.externalHrefs).toContain("https://example.invalid/outside");
    // A pre-paginated page with no text layer keeps its illustration as an image part.
    const plate = parsed.parts[2]!;
    expect(plate.kind).toBe("image");
    expect(plate.images?.length).toBe(1);
    const asset = parsed.assets?.find((item) => item.partId.split(",").includes("plate"));
    expect(asset?.mediaType).toBe("image/png");
    expect([...asset!.bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(parsed.toc.some((item) => item.label === "外源第一章")).toBe(true);
  });

  it("reads a PDF whose page tree and inherited resources live in an object stream", async () => {
    const parsed = await parsePdfBytes(sample("external-pages.pdf"));
    expect(parsed.format).toBe("pdf");
    expect(parsed.traits.objectStreams).toBe(true);
    expect(parsed.traits.pageTree).toBe(3);
    expect(parsed.parts.map((part) => part.id)).toEqual(["page-1", "page-2", "page-3"]);
    expect(parsed.parts[0]?.normalized).toContain("external page one");
    expect(parsed.parts[1]?.normalized).toContain("external page two");
    expect(parsed.parts[2]?.kind).toBe("image");
    expect((parsed.parts[2]?.normalized ?? "").trim()).toBe("");
  });

  it("reads a PalmDOC compressed MOBI with recindex and kindle:embed images", () => {
    const parsed = parseMobiBytes(sample("palmdoc-sample.mobi"));
    expect(parsed.format).toBe("mobi");
    expect(parsed.title).toBe("外部样本");
    expect(parsed.traits.compression).toBe(2);
    expect(parsed.parts.length).toBe(2);
    expect(parsed.parts[0]?.normalized).toContain("第一页正文");
    // Markup must be gone, and both image reference styles must resolve to their records.
    expect(parsed.parts.map((part) => part.normalized).join("\n")).not.toContain("<p>");
    expect(parsed.parts[1]?.images?.length).toBe(2);
    expect(parsed.traits.storedAssets).toBe(2);
    expect(parsed.traits.unresolvedImages).toBe(0);
    expect(parsed.assets?.every((item) => item.mediaType === "image/png")).toBe(true);
  });

  it("records the external toolchain that produced the samples", () => {
    expect(manifest.generator).toBe("scripts/build-m1b-samples.py");
    expect(manifest.toolchain).toMatch(/CPython/);
    expect(manifest.samples.map((item) => item.name).sort()).toEqual(["external-pages.pdf", "palmdoc-sample.mobi", "reading-sample.epub"]);
  });
});
