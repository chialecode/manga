import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { MangaProductApp, TestVault, buildZip } from "../packages/app-core/src/index.ts";
import { NORMALIZATION_V1 } from "../packages/contracts/src/index.ts";
import { requiredScale } from "./m1b-report.mjs";

const TXT_MARKER = "十兆窗口末尾标记";
const EPUB_MARKER = "三十兆窗口末章标记";

function epubBytes(chapters) {
  const enc = new TextEncoder();
  const container = `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;
  const items = chapters.map((_, index) => `<item id="c${index + 1}" href="c${index + 1}.xhtml" media-type="application/xhtml+xml"/>`).join("");
  const spine = chapters.map((_, index) => `<itemref idref="c${index + 1}"/>`).join("");
  const opf = `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>规模大书</dc:title></metadata><manifest>${items}</manifest><spine>${spine}</spine></package>`;
  return buildZip([
    { name: "mimetype", data: enc.encode("application/epub+zip"), method: 0 },
    { name: "META-INF/container.xml", data: enc.encode(container) },
    { name: "OEBPS/content.opf", data: enc.encode(opf) },
    ...chapters.map((text, index) => ({ name: `OEBPS/c${index + 1}.xhtml`, data: enc.encode(`<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><h1>第${index + 1}章</h1><p>${text}</p></body></html>`) })),
  ]);
}

async function call(app, actor, grant, commandId, input) {
  const result = await app.call(actor, { commandId, idempotencyKey: crypto.randomUUID(), input }, grant.handle);
  if (result.status !== "ok") throw new Error(`${commandId}: ${result.error?.message ?? "failed"}`);
  return result.value;
}

/** Seed one window Profile to the 6.2 baseline and store the tail of both large books as the reading position. */
async function seedScaleProfile(dir) {
  const env = { profileRoot: path.join(dir, "root"), documentsDir: path.join(dir, "documents"), pointerPath: path.join(dir, "launcher", "pointer.json") };
  const app = new MangaProductApp({ ...env, channel: "test", hostId: "m1b-bench-scale-seed", vault: new TestVault("m1b-bench-scale"), useParseWorker: true });
  await app.start();
  const actor = { kind: "user", id: "bench-scale" };
  const grant = app.issueOwnerGrant(actor);
  await call(app, actor, grant, "settings.skipAi", {});
  // Metadata rows are older than the large books so the resource list shows the books first.
  const old = new Date(Date.now() - 86_400_000).toISOString();
  const sqlite = app.store.sqlite;
  sqlite.exec("BEGIN");
  const insertResource = sqlite.prepare("INSERT INTO resources(id, work_id, kind, title, aliases_json, created_at) VALUES (?,?,?,?,?,?)");
  const insertRevision = sqlite.prepare("INSERT INTO resource_revisions(id, resource_id, fingerprint, parser_version, payload_json, created_at) VALUES (?,?,?,?,?,?)");
  for (let i = 0; i < requiredScale.metadataCount; i += 1) {
    insertResource.run(`res_s${i}`, null, "novel", `规模条目 ${i}`, JSON.stringify([`s${i}`]), old);
    insertRevision.run(`rev_s${i}`, `res_s${i}`, `fps${i}`, "bench-parser", JSON.stringify({ normalized: `规模检索块 ${i} 日本語` }), old);
  }
  for (let i = 0; i < requiredScale.searchBlocks; i += 1) {
    for (const mutation of app.store.indexFragment({ id: `frag_s${i}`, resourceId: `res_s${i % requiredScale.metadataCount}`, resourceRevisionId: `rev_s${i % requiredScale.metadataCount}`, partId: "body", start: 0, end: 8, kind: "body", text: `规模检索块 ${i} 日本語 中文` })) {
      sqlite.prepare(mutation.sql).run(...(mutation.params ?? []));
    }
  }
  sqlite.exec("COMMIT");

  const txtFile = path.join(dir, "large.txt");
  const filler = Buffer.alloc(10 * 1024 * 1024, "阅读正文。");
  fs.writeFileSync(txtFile, Buffer.concat([filler.subarray(0, filler.length - (filler.length % Buffer.byteLength("阅读正文。"))), Buffer.from(TXT_MARKER)]));
  const chapter = "章节正文。".repeat(700_000);
  const epubFile = path.join(dir, "large.epub");
  fs.writeFileSync(epubFile, epubBytes([chapter, chapter, `${chapter}${EPUB_MARKER}`]));
  const txt = await call(app, actor, grant, "library.importDocument", { title: "规模十兆文本", pathHandle: app.registerPath("file", txtFile), format: "txt" });
  const epub = await call(app, actor, grant, "library.importDocument", { title: "规模三十兆书", pathHandle: app.registerPath("file", epubFile), format: "epub" });
  for (const [book, marker] of [[txt, TXT_MARKER], [epub, EPUB_MARKER]]) {
    const read = await call(app, actor, grant, "library.read", { resourceId: book.resourceId });
    const last = read.parts[read.parts.length - 1];
    const range = { start: last.length - [...marker].length, end: last.length };
    await call(app, actor, grant, "progress.set", {
      resourceId: book.resourceId,
      resourceRevisionId: book.revisionId,
      consumed: false,
      locator: { kind: "text", partId: last.id, representationId: book.revisionId, normalizationVersion: NORMALIZATION_V1, range, quote: { exact: marker } },
    });
  }
  const note = await call(app, actor, grant, "notes.create", { title: "规模笔记", text: "规模保存起点" });
  app.close();
  const parseFile = path.join(dir, "background.txt");
  const sizes = {
    txtBytes: fs.statSync(txtFile).size,
    epubBytes: fs.statSync(epubFile).size,
    backgroundBytes: 0,
  };
  return { env, parseFile, sizes, spec: { txt: { resourceId: txt.resourceId, marker: TXT_MARKER }, epub: { resourceId: epub.resourceId, marker: EPUB_MARKER }, noteId: note.objectId, parseFile, scale: { ...requiredScale } } };
}

/**
 * Launch the real window three times on one seeded Profile. Every launch is a new process (cold start)
 * and parses a distinct 10 MiB book in the background while the window is being used.
 */
export async function runScaleWindowBench({ launch }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manga-m1b-bench-scale-"));
  const seedStarted = Date.now();
  const seeded = await seedScaleProfile(dir);
  const seedMs = Date.now() - seedStarted;
  const runs = [];
  for (let i = 0; i < 3; i += 1) {
    const parseFile = path.join(dir, `background-${i}.txt`);
    const unit = Buffer.from(`后台解析${i}。`);
    const background = Buffer.alloc(10 * 1024 * 1024, unit);
    fs.writeFileSync(parseFile, background.subarray(0, background.length - (background.length % unit.length)));
    seeded.sizes.backgroundBytes = fs.statSync(parseFile).size;
    const specFile = path.join(dir, `spec-${i}.json`);
    fs.writeFileSync(specFile, JSON.stringify({ ...seeded.spec, parseFile }));
    const env = {
      ...process.env,
      MANGA_CHANNEL: "test",
      MANGA_PROFILE_ROOT: seeded.env.profileRoot,
      MANGA_DOCUMENTS_DIR: seeded.env.documentsDir,
      MANGA_POINTER_FILE: seeded.env.pointerPath,
      M1A_SMOKE_PHASE: "bench-scale",
      M1B_BENCH_SCALE_SPEC: specFile,
    };
    delete env.ELECTRON_RUN_AS_NODE;
    env.M1A_LAUNCHED_AT = String(Date.now());
    const child = launch(env, dir);
    const file = path.join(seeded.env.profileRoot, "logs", "bench-scale-window.json");
    const measured = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined;
    if (!child || child.status !== 0 || !measured) {
      return { ok: false, reason: `scale window run ${i} failed (exit ${child?.status}, ${child?.error?.message ?? "no spawn error"})`, profile: seeded.env.profileRoot, stdout: child?.stdout?.slice(-2000), stderr: child?.stderr?.slice(-2000), measured };
    }
    fs.rmSync(file);
    runs.push(measured);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  const merge = (key) => runs.flatMap((run) => run[key] ?? []);
  return {
    ok: runs.every((run) => run.ok === true),
    failures: runs.flatMap((run) => run.failures ?? []),
    scale: seeded.spec.scale,
    sizes: seeded.sizes,
    seedMs,
    waits: runs[0]?.waits,
    raw: {
      coldStartToLibraryMs: runs.map((run) => run.coldStartToLibraryMs),
      uiFeedbackMs: merge("uiFeedbackMs"),
      largeTxtTailMs: merge("largeTxtTailMs"),
      largeEpubTailMs: merge("largeEpubTailMs"),
      saveReceiptMs: merge("saveReceiptMs"),
      duringParseUiMs: merge("duringParseUiMs"),
      duringParseSaveMs: merge("duringParseSaveMs"),
      backgroundParseMs: runs.map((run) => run.backgroundParseMs),
      samplesWhileParsing: runs.map((run) => run.samplesWhileParsing),
      mainLoopMaxGapMs: runs.map((run) => run.mainLoopMaxGapMs),
      mainLoopGapsOver50Ms: runs.map((run) => run.mainLoopGapsOver50Ms),
    },
  };
}

export function spawnWindow(executable, args) {
  return (env, cwd) => spawnSync(executable, args, { cwd, env, encoding: "utf8", timeout: 300_000, windowsHide: true });
}
