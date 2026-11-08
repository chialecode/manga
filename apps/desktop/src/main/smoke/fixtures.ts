import zlib from "node:zlib";
import type { MangaProductApp } from "@manga/app-core";
import type { caller } from "./common.ts";

/**
 * Synthetic material that both a window walk and the bench make: kept apart from the walks so the bench depends on this file only, and a change to a
 * walk leaves the bench result current (scripts/stage/gate.json, fingerprint groups smoke, smokeBench, smokeWalk).
 */

export type Call = ReturnType<typeof caller>;
export const value = async <T>(call: Call, commandId: string, input: Record<string, unknown>): Promise<T> => {
  const result = await call(commandId, input);
  if (result.status !== "ok") throw new Error(`${commandId}: ${JSON.stringify(result.error ?? null).slice(0, 300)}`);
  return result.value as T;
};

/** A conversation of `total` messages on a book: notes spread through it and the rest questions and answers of every length (synthetic, LOOP-07). */
export async function seedLongSession(appService: MangaProductApp, call: Call, total: number): Promise<{ resourceId: string; sessionId: string; noteIds: string[]; runIds: string[] }> {
  const imported = await value<{ resourceId: string }>(call, "library.importDocument", { title: total === 5000 ? "长对话的书" : `长对话的书（${total}）`, format: "txt", bytes: [...new TextEncoder().encode("长对话用的合成正文。".repeat(200))] });
  const sessionId = (await value<{ id: string }>(call, "session.open", { kind: "resource", targetId: imported.resourceId, contextId: null })).id;
  const notes = Math.max(1, Math.round(total / 50));
  const noteIds: string[] = [];
  for (let index = 0; index < notes; index += 1) noteIds.push((await value<{ objectId: string }>(call, "notes.create", { title: `第${index}条笔记`, text: `合成笔记 ${index}：${"想法".repeat(5 + (index % 9) * 6)}`, resourceId: imported.resourceId })).objectId);
  const sqlite = appService.store.sqlite;
  const base = Date.UTC(2026, 0, 1);
  const runs = Math.ceil((total - notes) / 2);
  const step = Math.floor(((total - notes) / 2 + notes) / notes);
  const at = (index: number) => new Date(base + index * 1000).toISOString();
  const runIds: string[] = [];
  const insert = sqlite.prepare("INSERT INTO agent_runs(id, session_id, status, grant_handle, budget_json, input_text, live_text, created_at, updated_at) VALUES (?, ?, 'succeeded', 'smoke', '{}', ?, ?, ?, ?)");
  const move = sqlite.prepare("UPDATE content_objects SET created_at = ? WHERE id = ?");
  sqlite.transaction(() => {
    let slot = 0;
    let noteAt = 0;
    for (let index = 0; index < runs; index += 1) {
      if (noteAt < noteIds.length && index % step === 0) { move.run(at(slot), noteIds[noteAt]!); noteAt += 1; slot += 1; }
      const id = total === 5000 ? `run_long_${String(index).padStart(5, "0")}` : `run_long${total}_${String(index).padStart(5, "0")}`;
      runIds.push(id);
      insert.run(id, sessionId, `第${index}个问题${"？".repeat(index % 4)}`, `第${index}个回答。${"这一段回答有长有短。".repeat(1 + (index % 13) * 3)}`, at(slot), at(slot));
      slot += 1;
    }
    for (; noteAt < noteIds.length; noteAt += 1, slot += 1) move.run(at(slot), noteIds[noteAt]!);
  })();
  return { resourceId: imported.resourceId, sessionId, noteIds, runIds };
}

/** A zip that stores its entries, which is all an EPUB's reader needs of one. */
function storedZip(entries: Array<[string, string]>): Buffer {
  const heads: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const body = Buffer.from(text);
    const file = Buffer.from(name);
    const crc = zlib.crc32(body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(body.length, 22); local.writeUInt16LE(file.length, 26);
    heads.push(local, file, body);
    const row = Buffer.alloc(46);
    row.writeUInt32LE(0x02014b50, 0); row.writeUInt16LE(20, 4); row.writeUInt16LE(20, 6); row.writeUInt32LE(crc, 16); row.writeUInt32LE(body.length, 20); row.writeUInt32LE(body.length, 24); row.writeUInt16LE(file.length, 28); row.writeUInt32LE(offset, 42);
    central.push(row, file);
    offset += local.length + file.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...heads, directory, end]);
}

/** An EPUB of some chapters, each about so many characters long. */
export function longChaptersEpub(count: number, characters: number): Buffer {
  const chapters = Array.from({ length: count }, (_, index) => index + 1);
  const paragraph = (n: number) => `<p>第${n}章的合成正文，用来把一章排成好几页，每一段都差不多长，读起来没有别的意思。</p>`.repeat(Math.ceil(characters / 36));
  return storedZip([
    ["mimetype", "application/epub+zip"],
    ["META-INF/container.xml", `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`],
    ["OEBPS/content.opf", `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">long-chapters-${count}-${characters}</dc:identifier><dc:title>分页 EPUB</dc:title><dc:language>zh-CN</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${chapters.map((n) => `<item id="c${n}" href="c${n}.xhtml" media-type="application/xhtml+xml"/>`).join("")}</manifest><spine>${chapters.map((n) => `<itemref idref="c${n}"/>`).join("")}</spine></package>`],
    ["OEBPS/nav.xhtml", `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><ol>${chapters.map((n) => `<li><a href="c${n}.xhtml">第${n}章</a></li>`).join("")}</ol></nav></body></html>`],
    ...chapters.map((n): [string, string] => [`OEBPS/c${n}.xhtml`, `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>第${n}章</title></head><body><h1>第${n}章</h1>${paragraph(n)}</body></html>`]),
  ]);
}
