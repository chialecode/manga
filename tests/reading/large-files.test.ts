import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildZip } from "@manga/app-core";
import { startApp } from "../helpers/app.ts";

const enabled = process.env.MANGA_LARGE_FILES === "1";

describe.skipIf(!enabled)("large reading files", () => {
  it("reads the tail of a 10 MiB txt through a path handle", async () => {
    const { app, actor, grant, profileRoot } = await startApp();
    const marker = "十兆末尾甲乙";
    const bytes = Buffer.alloc(10 * 1024 * 1024, 0x41);
    const file = path.join(profileRoot, "large.txt");
    fs.writeFileSync(file, Buffer.concat([bytes.subarray(0, bytes.length - Buffer.byteLength(marker)), Buffer.from(marker)]));
    const handle = app.registerPath("file", file);
    const imported = await app.call(actor, { commandId: "library.importDocument", idempotencyKey: "large-txt", input: { title: "大文本", pathHandle: handle, format: "txt" } }, grant.handle);
    expect(imported.status).toBe("ok");
    const read = await app.call(actor, { commandId: "library.read", idempotencyKey: "large-read", input: { resourceId: imported.value?.resourceId } }, grant.handle);
    const length = Number((read.value as { parts: Array<{ length: number }> }).parts[0]?.length);
    const slice = await app.call(actor, {
      commandId: "library.readSlice",
      idempotencyKey: "large-slice",
      input: { resourceId: imported.value?.resourceId, partId: "body", start: Math.max(0, length - marker.length), limit: 8000 },
    }, grant.handle);
    expect(String((slice.value as { text?: string }).text)).toContain(marker);
    const found = await app.call(actor, { commandId: "library.find", idempotencyKey: "large-find", input: { text: marker, resourceId: String(imported.value?.resourceId) } }, grant.handle);
    expect((found.value as unknown[]).length).toBeGreaterThan(0);
    app.close();
  }, 180_000);

  it("reads the last chapter of a 30 MiB epub", async () => {
    const { app, actor, grant, profileRoot } = await startApp();
    const marker = "三十兆末章乙";
    const chapter = `${"章".repeat(10 * 1024 * 1024)}${marker}`;
    const html = `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>${chapter}</p></body></html>`;
    const container = `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;
    const opf = `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>大书</dc:title></metadata><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`;
    const file = path.join(profileRoot, "large.epub");
    fs.writeFileSync(file, buildZip([
      { name: "mimetype", data: new TextEncoder().encode("application/epub+zip"), method: 0 },
      { name: "META-INF/container.xml", data: new TextEncoder().encode(container) },
      { name: "OEBPS/content.opf", data: new TextEncoder().encode(opf) },
      { name: "OEBPS/c1.xhtml", data: new TextEncoder().encode(html) },
    ]));
    expect(fs.statSync(file).size).toBeGreaterThan(30 * 1024 * 1024);
    const handle = app.registerPath("file", file);
    const imported = await app.call(actor, { commandId: "library.importDocument", idempotencyKey: "large-epub", input: { title: "大书", pathHandle: handle, format: "epub" } }, grant.handle);
    expect(imported.status).toBe("ok");
    const read = await app.call(actor, { commandId: "library.read", idempotencyKey: "epub-read", input: { resourceId: imported.value?.resourceId } }, grant.handle);
    const part = (read.value as { parts: Array<{ id: string; length: number }> }).parts[0];
    const slice = await app.call(actor, {
      commandId: "library.readSlice",
      idempotencyKey: "epub-slice",
      input: { resourceId: imported.value?.resourceId, partId: part?.id, start: Math.max(0, Number(part?.length) - marker.length - 2), limit: 8000 },
    }, grant.handle);
    expect(String((slice.value as { text?: string }).text)).toContain(marker);
    app.close();
  }, 180_000);
});
