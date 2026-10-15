import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fontFamilies } from "../../packages/app-core/src/video/font-names.ts";
import { locateSubtitleFont, SUBTITLE_FONT_FAMILY, SUBTITLE_FONT_FILE } from "../../packages/app-core/src/media/subtitle-font.ts";

const repo = path.resolve(import.meta.dirname, "../..");

type NameRecord = { platform: number; id: number; text: string };

/** The bytes of a `name` table. */
function nameTable(names: NameRecord[]): Buffer {
  const strings = names.map((item) => (item.platform === 1 ? Buffer.from(item.text, "latin1") : Buffer.from(item.text, "utf16le").swap16()));
  const header = 6 + names.length * 12;
  const table = Buffer.alloc(header + strings.reduce((sum, item) => sum + item.length, 0));
  table.writeUInt16BE(names.length, 2);
  table.writeUInt16BE(header, 4);
  let offset = 0;
  names.forEach((item, index) => {
    const at = 6 + index * 12;
    table.writeUInt16BE(item.platform, at);
    table.writeUInt16BE(item.platform === 1 ? 0 : 1, at + 2);
    table.writeUInt16BE(item.platform === 1 ? 0 : 0x409, at + 4);
    table.writeUInt16BE(item.id, at + 6);
    table.writeUInt16BE(strings[index]!.length, at + 8);
    table.writeUInt16BE(offset, at + 10);
    strings[index]!.copy(table, header + offset);
    offset += strings[index]!.length;
  });
  return table;
}

/** A font that has nothing but a `name` table, placed at `base` in its file (table offsets count from the start of the file). */
function font(names: NameRecord[], tag = "\u0000\u0001\u0000\u0000", base = 0): Buffer {
  const table = nameTable(names);
  const out = Buffer.alloc(28 + table.length);
  out.write(tag, 0, "latin1");
  out.writeUInt16BE(1, 4);
  out.write("name", 12, "latin1");
  out.writeUInt32BE(base + 28, 20);
  out.writeUInt32BE(table.length, 24);
  table.copy(out, 28);
  return out;
}

describe("AT-84 font names: which family a font file answers to", () => {
  it("reads the family, full and typographic names, in Windows and Mac encodings, lower case", () => {
    const names = font([
      { platform: 3, id: 1, text: "Source Han Sans SC" },
      { platform: 3, id: 4, text: "Source Han Sans SC Regular" },
      { platform: 3, id: 16, text: "思源黑体" },
      { platform: 1, id: 1, text: "Arial" },
      { platform: 3, id: 2, text: "Regular" },
    ]);
    expect(fontFamilies(names).sort()).toEqual(["arial", "source han sans sc", "source han sans sc regular", "思源黑体"].sort());
    expect(fontFamilies(font([{ platform: 3, id: 1, text: "Open Type" }], "OTTO"))).toEqual(["open type"]);
  });

  it("reads each font of a collection", () => {
    const head = Buffer.alloc(20);
    head.write("ttcf", 0, "latin1");
    head.writeUInt32BE(0x00010000, 4);
    head.writeUInt32BE(2, 8);
    const one = font([{ platform: 3, id: 1, text: "Collection A" }], "\u0000\u0001\u0000\u0000", 20);
    const second = 20 + one.length;
    const two = font([{ platform: 3, id: 1, text: "Collection B" }], "\u0000\u0001\u0000\u0000", second);
    head.writeUInt32BE(20, 12);
    head.writeUInt32BE(second, 16);
    expect(fontFamilies(Buffer.concat([head, one, two])).sort()).toEqual(["collection a", "collection b"]);
  });

  it("gives nothing for what is not an uncompressed font, and survives damage", () => {
    expect(fontFamilies(Buffer.from("wOFF....."))).toEqual([]);
    expect(fontFamilies(Buffer.alloc(0))).toEqual([]);
    const names = font([{ platform: 3, id: 1, text: "Cut Short" }]);
    expect(() => fontFamilies(names.subarray(0, names.length - 6))).not.toThrow();
    expect(() => fontFamilies(names.subarray(0, 20))).not.toThrow();
  });

  const bundled = path.join(repo, "dist", "tools", "subtitle-font", SUBTITLE_FONT_FILE);
  it.skipIf(!fs.existsSync(bundled))("knows the bundled font by the family name the renderer looks it up by", () => {
    expect(fontFamilies(fs.readFileSync(bundled))).toContain(SUBTITLE_FONT_FAMILY.toLowerCase());
  });
});

describe("AT-84 font names: where the bundled font is looked for", () => {
  it("finds it in the explicit directory, then the packaged resources, and names the family the renderer looks for", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "manga-font-locate-"));
    try {
      const put = (dir: string) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, SUBTITLE_FONT_FILE), "font"); };
      const explicit = path.join(tmp, "explicit");
      const resources = path.join(tmp, "resources");
      put(explicit);
      put(path.join(resources, "subtitle-font"));
      expect(locateSubtitleFont({ env: { MANGA_SUBTITLE_FONT_DIR: explicit }, resourcesPath: resources, cwd: tmp })?.path).toBe(path.join(explicit, SUBTITLE_FONT_FILE));
      const packaged = locateSubtitleFont({ env: {}, resourcesPath: resources, cwd: tmp });
      expect(packaged?.path).toBe(path.join(resources, "subtitle-font", SUBTITLE_FONT_FILE));
      expect(packaged).toMatchObject({ family: SUBTITLE_FONT_FAMILY, mediaType: "font/otf" });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
