import fs from "node:fs";
import path from "node:path";
import type { BrowserWindow } from "electron";
import { buildEpubFixture, buildMobiFixture, buildPdfFixture, type MangaProductApp } from "@manga/app-core";
import { testHooks } from "../test-hooks.ts";
import { clickTestId, openFromShelf, setField, sleep, waitForTestId, waitUntil } from "./driver.ts";
import { caller, ensureRightPane, js, openSettingsPage, toRail, type FlowResult } from "./common.ts";

/**
 * Open txt, epub, pdf and mobi in the real window, then a bad file and a mode switch. Every book is opened the way a person opens it
 * now: the rail's shelf, the card, the work's page, "read". The PDF's text is selected and taken to a note from the right pane.
 */

/** What the text layer of the open PDF page was doing when a selection was made or failed (LOOP-06). */
type PdfLayerState = { epoch: number; spans: number; connected: boolean; selected: string };

/** The page's render count, read from the page itself: it goes up every time the PDF is painted again and its text layer replaced. */
const PDF_STATE = `(() => {
  const root = document.querySelector('[data-testid="reading-page-render"]');
  const epoch = Number(root?.getAttribute("data-pdf-epoch") ?? "0");
  const width = Number(root?.getAttribute("data-pdf-width") ?? "0");
  const spans = document.querySelectorAll('[data-testid="reading-pdf-text"] span').length;
  return { epoch, width, spans };
})()`;

export async function runFormatsSmoke(appService: MangaProductApp, grant: string, view: BrowserWindow, logsDir: string): Promise<FlowResult> {
  const call = caller(appService, grant);
  await call("settings.skipAi", {});
  const dir = path.join(logsDir, "formats");
  fs.mkdirSync(dir, { recursive: true });
  const scanPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const books = [
    { name: "sample.txt", format: "txt", marker: "FORMAT-TXT-MARK", bytes: Buffer.from("FORMAT-TXT-MARK. four format window.") },
    { name: "sample.epub", format: "epub", marker: "FORMAT-EPUB-MARK", bytes: Buffer.from(buildEpubFixture({ title: "format book", chapters: [{ id: "c1", title: "chapter", html: "<p>FORMAT-EPUB-MARK</p>" }] })) },
    { name: "sample.pdf", format: "pdf", marker: "FORMAT-PDF-MARK", bytes: Buffer.from(buildPdfFixture([{ text: "FORMAT-PDF-MARK" }, { scan: true, imageBytes: scanPng }])) },
    { name: "sample.mobi", format: "mobi", marker: "FORMAT-MOBI-MARK", bytes: Buffer.from(buildMobiFixture("FORMAT-MOBI-MARK")) },
  ];
  const opened: Record<string, boolean> = {};
  let pdfDebug: Record<string, unknown> = {};
  let pdfLayer = "";
  let pdfSpans = 0;
  let pdfError = "";
  let pdfReview = false;
  let loop06: Record<string, unknown> = {};
  const ids: Record<string, string> = {};
  for (const book of books) {
    const file = path.join(dir, book.name);
    fs.writeFileSync(file, book.bytes);
    const handle = appService.registerPath("file", file);
    const imported = await call("library.importDocument", { title: book.name, pathHandle: handle, format: book.format });
    if (imported.status !== "ok") return { ok: false, reason: `${book.format} import failed`, detail: imported.error };
    ids[book.format] = String((imported.value as { resourceId?: string }).resourceId ?? "");
  }
  await view.webContents.reload();
  await waitForTestId(view, "nav-reading");
  for (const book of books) {
    const resourceId = ids[book.format] ?? "";
    const clicked = await openFromShelf(view, "nav-reading", resourceId);
    const visible = await waitUntil(view, `(() => {
      const text = document.querySelector('[data-testid="reading-body"]')?.textContent ?? "";
      const image = [...document.querySelectorAll('[data-testid="reading-page"] img')].some((item) => item.complete && item.naturalWidth > 0);
      const title = document.querySelector('[data-testid="reading-title"]');
      return title && (text.includes(${JSON.stringify(book.marker)}) || (${JSON.stringify(book.format)} === "pdf" && image));
    })()`, 8000);
    if (book.format === "pdf" && visible) {
      const painted = await waitUntil(view, `(() => { const canvas = document.querySelector('[data-testid="reading-pdf-canvas"]'); return canvas && canvas.width > 0 && canvas.height > 0; })()`, 8000);
      await ensureRightPane(view);
      // LOOP-06: a selection made while the page is still being painted again is lost with the text layer it was made in. The page is
      // given the time to settle (its render count unchanged for a while) before the text is selected; nothing is retried. The count and
      // whether the chosen node is still in the document are recorded at the selection and again at the end, so a failure can be placed.
      const settled = await js<{ stable: boolean; epoch: number; changes: number; timeline: Array<{ ms: number; epoch: number; width: number }> }>(view, `new Promise((resolve) => {
        const started = Date.now();
        let last = -1;
        let since = Date.now();
        let changes = 0;
        const timeline = [];
        const tick = () => {
          const state = ${PDF_STATE};
          if (state.epoch !== last) { if (last >= 0) changes += 1; last = state.epoch; since = Date.now(); timeline.push({ ms: Date.now() - started, epoch: state.epoch, width: state.width }); }
          const hasMark = [...document.querySelectorAll('[data-testid="reading-pdf-text"] span')].some((item) => (item.textContent || "").includes("FORMAT-PDF-MARK"));
          if (state.epoch > 0 && hasMark && Date.now() - since >= 700) resolve({ stable: true, epoch: state.epoch, changes, timeline });
          else if (Date.now() - started > 10000) resolve({ stable: false, epoch: state.epoch, changes, timeline });
          else setTimeout(tick, 50);
        };
        tick();
      })`);
      const atSelect = await js<(PdfLayerState & { ok: boolean }) | { ok: false; missing: true }>(view, `(() => {
        const node = [...document.querySelectorAll('[data-testid="reading-pdf-text"] span')].find((item) => (item.textContent || "").includes("FORMAT-PDF-MARK"));
        if (!node) return { ok: false, missing: true };
        const range = document.createRange();
        range.selectNodeContents(node);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        document.dispatchEvent(new Event("selectionchange"));
        window.__smokePdfNode = node;
        const state = ${PDF_STATE};
        return { ok: true, epoch: state.epoch, spans: state.spans, connected: node.isConnected, selected: String(selection) };
      })()`);
      // The passage that was held becomes a tag in the right pane's input.
      const tagged = atSelect.ok && await waitUntil(view, `document.querySelector('[data-testid="chat-tag-selection"]')`, 4000);
      const atEnd = await js<{ epoch: number; spans: number; nodeConnected: boolean; layer: string; error: string; review: boolean }>(view, `(() => {
        const state = ${PDF_STATE};
        return {
          epoch: state.epoch,
          spans: state.spans,
          nodeConnected: Boolean(window.__smokePdfNode && window.__smokePdfNode.isConnected),
          layer: document.querySelector('[data-testid="reading-pdf-text"]')?.innerText ?? "",
          error: document.querySelector('[data-testid="reading-pdf-error"]')?.textContent ?? "",
          review: Boolean(document.querySelector('[data-testid="reading-pdf-needs-review"]')),
        };
      })()`);
      loop06 = { settled, atSelect, tagged, atEnd, repainted: atSelect.ok ? atEnd.epoch !== atSelect.epoch : null };
      let noted = false;
      let excerpt = false;
      if (tagged) {
        await clickTestId(view, "chat-mode-note");
        await setField(view, "agent-composer", "格式样本笔记");
        await sleep(100);
        noted = await clickTestId(view, "agent-send");
        excerpt = noted && await waitUntil(view, `(document.querySelector('[data-testid="chat-log"]')?.textContent ?? "").includes("FORMAT-PDF-MARK")`, 8000);
      }
      // The second page is an image page: reading it again from the shelf, then forward.
      await openFromShelf(view, "nav-reading", resourceId);
      await clickTestId(view, "reading-next");
      const image = await waitUntil(view, `(() => {
        const canvas = document.querySelector('[data-testid="reading-pdf-canvas"]');
        const position = document.querySelector('[data-testid="reading-part-position"]')?.textContent ?? "";
        const decoded = [...document.querySelectorAll('[data-testid="reading-page"] img')].some((item) => item.complete && item.naturalWidth > 0);
        return position.includes("第 2 /") && ((canvas && canvas.width > 0) || decoded);
      })()`, 8000);
      opened[book.format] = clicked && painted && excerpt && image;
      pdfDebug = { painted, selected: Boolean(tagged), noted, excerpt, image };
      pdfLayer = atEnd.layer;
      pdfSpans = atEnd.spans;
      pdfError = atEnd.error;
      pdfReview = atEnd.review;
    } else opened[book.format] = clicked && visible;
  }
  // Mode switch: each mode keeps its own draft and its own opened resources.
  const drafted = await setField(view, "agent-composer", "formats enthusiast draft");
  const enthusiast = await call("workspace.sessions", { mode: "enthusiast" }) as { status?: string; value?: Array<{ sessionId: string }> };
  const enthusiastId = enthusiast.value?.[0]?.sessionId ?? "";
  await clickTestId(view, "mode-menu");
  await waitForTestId(view, "mode-creator");
  await clickTestId(view, "mode-creator");
  const switched = await waitUntil(view, `(() => {
    const menu = document.querySelector('[data-testid="mode-menu"]')?.textContent ?? "";
    const draft = document.querySelector('[data-testid="agent-composer"]')?.value ?? "";
    const listed = document.querySelector('[data-testid="session-open-${enthusiastId}"]');
    return menu.includes("造物主") && draft !== "formats enthusiast draft" && !listed;
  })()`, 8000);
  await clickTestId(view, "mode-menu");
  await waitForTestId(view, "mode-enthusiast");
  await clickTestId(view, "mode-enthusiast");
  const returned = await waitUntil(view, `(() => {
    const menu = document.querySelector('[data-testid="mode-menu"]')?.textContent ?? "";
    const draft = document.querySelector('[data-testid="agent-composer"]')?.value ?? "";
    return menu.includes("观测者") && draft === "formats enthusiast draft";
  })()`, 8000);
  // A damaged file is reported by the import dialog, which is opened from the settings page of the library.
  const bad = path.join(dir, "broken.pdf");
  fs.writeFileSync(bad, Buffer.from("%PDF-1.4\nnot-a-page"));
  testHooks.pick = () => bad;
  await toRail(view);
  await openSettingsPage(view, "library");
  await clickTestId(view, "settings-import");
  await clickTestId(view, "import-pick-file");
  // The import dialog inspects the file first; a damaged one is reported there or when the import runs.
  await waitForTestId(view, "import-confirm");
  await sleep(500);
  await clickTestId(view, "import-confirm");
  const failureVisible = await waitUntil(view, `(() => {
    const alert = document.querySelector('[data-testid="import-error"], [role="alert"]');
    return alert && (alert.textContent || "").trim();
  })()`, 8000);
  testHooks.pick = undefined;
  const pages = books.every((book) => opened[book.format]);
  return { ok: drafted && pages && switched && returned && failureVisible, pages, modes: switched && returned, failureVisible, opened, pdfDebug, pdfLayer, pdfSpans, pdfError, pdfReview, loop06 };
}
