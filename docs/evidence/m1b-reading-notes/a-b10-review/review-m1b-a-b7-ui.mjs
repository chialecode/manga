// A review adapter: original assertions retained; PDF readiness/Canvas checks updated for the async engine.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";
import { startApp } from "../../../../tests/m1b/helpers.ts";
import { buildZip } from "../../../../packages/app-core/src/domain/formats.ts";
import { repoRoot, desktopOutput, desktopPackageDir, latestDesktopPackage } from "../../../../scripts/desktop-paths.ts";
import { m1bFingerprints } from "../../../../scripts/m1b-fingerprint.mjs";

const evidence = path.resolve(repoRoot, process.env.M1B_EVIDENCE_DIR ?? "docs/evidence/m1b-reading-notes/a-b7-review");
fs.mkdirSync(evidence, { recursive: true });
const runs = path.join(desktopOutput, "review-runs");
fs.mkdirSync(runs, { recursive: true });
const root = fs.mkdtempSync(path.join(runs, "a-b7-ui-"));
const profileRoot = path.join(root, "profile");
const seed = await startApp({ profileRoot });
async function seedCall(commandId, input) {
  const result = await seed.app.call(seed.actor, { commandId, input, idempotencyKey: crypto.randomUUID() }, seed.grant.handle);
  assert.equal(result.status, "ok", result.error?.message); return result.value;
}
const books = {};
try {
  await seedCall("settings.skipAi", {});
  const base = await seedCall("library.importDocument", { title: "合成模板", format: "txt", bytes: [...new TextEncoder().encode("可打开的合成正文")] });
  const db = seed.app.store.sqlite;
  const revision = db.prepare("SELECT * FROM resource_revisions WHERE id=?").get(base.revisionId);
  const resourceStmt = db.prepare("INSERT INTO resources(id,work_id,kind,title,aliases_json,created_at) VALUES (?,NULL,'novel',?,'[]',?)");
  const revisionStmt = db.prepare("INSERT INTO resource_revisions(id,resource_id,fingerprint,parser_version,payload_json,created_at) VALUES (?,?,?,?,?,?)");
  db.exec("BEGIN");
  for (let index = 0; index < 230; index++) {
    const id = `a-b7-ui-${String(index).padStart(3, "0")}`;
    const date = new Date(Date.UTC(2020, 0, 1) + index * 1000).toISOString();
    resourceStmt.run(id, `${index % 2 === 0 ? "命中" : "无关"}合成书 ${index}`, date);
    revisionStmt.run(`${id}-rev`, id, `${id}-fp`, revision.parser_version, revision.payload_json, date);
  }
  db.exec("COMMIT");
  for (const name of ["consecutive-text", "white-text"]) books[name] = await seedCall("library.importDocument", { title: name, format: "pdf", bytes: [...fs.readFileSync(path.join(evidence, `${name}.pdf`))] });
  const files = [
    ["mimetype", "application/epub+zip"],
    ["META-INF/container.xml", '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'],
    ["book.opf", '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">synthetic</dc:identifier><dc:title>作者样式合成书</dc:title><dc:language>zh</dc:language></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="css" href="style.css" media-type="text/css"/></manifest><spine><itemref idref="chapter"/></spine></package>'],
    ["chapter.xhtml", '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>作者样式</title><link rel="stylesheet" href="style.css"/></head><body><p>右对齐、行高 2.3 的合成正文。</p><p>第二行正文。</p></body></html>'],
    ["style.css", 'body { color: #223344; background-color: #ffffff; line-height: 2.3; text-align: right; font-family: serif; }'],
  ];
  const epub = buildZip(files.map(([name, value]) => ({ name, data: new TextEncoder().encode(value) })));
  fs.writeFileSync(path.join(evidence, "author-style.epub"), epub);
  books.author = await seedCall("library.importDocument", { title: "作者样式合成书", format: "epub", bytes: [...epub] });
} finally { seed.app.close(); }

const env = { ...process.env, MANGA_CHANNEL: "test", MANGA_PROFILE_ROOT: profileRoot, MANGA_DOCUMENTS_DIR: path.join(profileRoot, "documents"), MANGA_POINTER_FILE: path.join(profileRoot, "launcher", "pointer.json") };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: path.join(desktopPackageDir, "MANGA-win32-x64/MANGA.exe"), env });
const observations = [];
let page;
async function check(finding, name, run) {
  const detail = {};
  try { await run(detail); observations.push({ finding, name, status: "passed", detail }); }
  catch (error) { observations.push({ finding, name, status: "failed", actual: error.message, detail }); }
}
async function capture(name) {
  await page.evaluate(async () => { await document.fonts.ready; await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString("base64"));
  fs.writeFileSync(path.join(evidence, name), Buffer.from(png, "base64"));
}
async function search(query) {
  await page.getByTestId("reading-resource-filter").fill(query);
  await page.getByTestId("reading-resource-filter-run").click();
  await page.waitForFunction((query) => [...document.querySelectorAll('[data-testid^="open-"]')].length > 0 && [...document.querySelectorAll('[data-testid^="open-"]')].every((node) => node.textContent.includes(query)), query);
}
try {
  page = await app.firstWindow();
  page.setDefaultTimeout(10_000);
  await page.getByTestId("nav-reading").waitFor();
  await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.setContentSize(1600, 900); win.webContents.setZoomFactor(1); });
  await page.getByTestId("nav-reading").click();
  await check("F-08", "search continuation stays filtered and opens the oldest match", async (detail) => {
    await search("命中");
    assert.equal(await page.locator('[data-testid^="open-"]').count(), 100);
    await page.getByTestId("reading-resources-more").click();
    await page.waitForFunction(() => document.querySelector('[data-testid="open-a-b7-ui-000"]'));
    const titles = await page.locator('[data-testid^="open-"]').allTextContents();
    detail.listed = titles.length;
    detail.unrelated = titles.filter((title) => !title.includes("命中"));
    detail.totalLabel = await page.getByTestId("reading-resource-total").innerText();
    await capture("search-continuation.png");
    await page.getByTestId("open-a-b7-ui-000").click();
    await page.getByTestId("reading-body").waitFor();
    detail.oldestOpened = (await page.getByTestId("reading-title").innerText()).includes("命中合成书 0");
    detail.rowsAfterOpen = await page.locator('[data-testid^="open-"]').count();
    assert.equal(detail.oldestOpened, true);
    assert.equal(detail.unrelated.length, 0, "loading the next search page adds unrelated books");
    assert.equal(titles.length, 115);
    assert.match(detail.totalLabel, /115/);
    assert.equal(detail.rowsAfterOpen, 115, "opening a result resets the search and pagination");
  });
  await check("F-07", "visible PDF runs do not overlap after consecutive Tj", async (detail) => {
    await search("");
    await page.getByTestId(`open-${books["consecutive-text"].resourceId}`).click();
    await page.getByTestId("reading-pdf-canvas").waitFor();
    await page.waitForFunction(()=>document.querySelector('[data-testid="reading-pdf-text"]')?.innerText.replace(/\s+/g,'')==='HELLOWORLD');
    detail.layer = (await page.getByTestId("reading-pdf-text").innerText()).replace(/\s+/g, "");
    detail.ink = await page.getByTestId("reading-pdf-canvas").evaluate((canvas) => {
      const ctx = canvas.getContext("2d");
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let dark = 0;
      for (let index = 0; index < data.length; index += 16) if (data[index] < 40 && data[index + 1] < 40 && data[index + 2] < 40) dark += 1;
      return dark;
    });
    await page.getByTestId("reading-page-render").scrollIntoViewIfNeeded();
    await capture("pdf-overlap.png");
    assert.equal(detail.layer, "HELLOWORLD");
    assert.ok(detail.ink > 10, "consecutive Tj left no painted glyphs");
  });
  await check("F-07", "white PDF text retains its fill over a black box", async (detail) => {
    await search("");
    await page.getByTestId(`open-${books["white-text"].resourceId}`).click();
    await page.getByTestId("reading-pdf-canvas").waitFor();
    await page.waitForFunction(()=>document.querySelector('[data-testid="reading-pdf-text"]')?.innerText.includes('WHITE'));
    detail.paint = await page.getByTestId("reading-pdf-canvas").evaluate((canvas) => {
      const ctx = canvas.getContext("2d");
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let light = 0;
      let dark = 0;
      for (let index = 0; index < data.length; index += 16) {
        if (data[index] > 220 && data[index + 1] > 220 && data[index + 2] > 220) light += 1;
        if (data[index] < 30 && data[index + 1] < 30 && data[index + 2] < 30) dark += 1;
      }
      return { light, dark };
    });
    await page.getByTestId("reading-page-render").scrollIntoViewIfNeeded();
    await capture("pdf-white-text.png");
    assert.ok(detail.paint.light > 5 && detail.paint.dark > 5, "white glyphs disappeared into the black box");
  });
  await check("F-07", "EPUB author line height and alignment reach the visible text", async (detail) => {
    await search("作者样式合成书");
    await page.getByTestId(`open-${books.author.resourceId}`).click();
    await page.getByTestId("reading-body").waitFor();
    detail.computed = await page.getByTestId("reading-body").evaluate((node) => { const style = getComputedStyle(node); return { color: style.color, lineHeight: style.lineHeight, fontSize: style.fontSize, textAlign: style.textAlign }; });
    await page.getByTestId("reading-body").scrollIntoViewIfNeeded();
    await capture("epub-author-style.png");
    assert.equal(detail.computed.color, "rgb(34, 51, 68)");
    assert.ok(Math.abs(parseFloat(detail.computed.lineHeight) / parseFloat(detail.computed.fontSize) - 2.3) < 0.01, "stored author line-height is not applied");
    assert.equal(detail.computed.textAlign, "right");
  });
} finally { await app.close(); }
const report = { at: new Date().toISOString(), ...m1bFingerprints(repoRoot), package: JSON.parse(fs.readFileSync(latestDesktopPackage, "utf8")), scriptFingerprint: createHash("sha256").update(fs.readFileSync(fileURLToPath(import.meta.url))).digest("hex"), status: observations.every((row) => row.status === "passed") ? "passed" : "rework-required", humanChecks: "not-run", productAcceptance: "not-run", observations };
fs.writeFileSync(path.join(evidence, "a-b7-ui-review.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
if (report.status !== "passed") process.exitCode = 1;
