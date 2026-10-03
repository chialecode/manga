// Agent A: independent lifecycle and genuinely different stored-representation counterexamples.
// Only synthetic profiles are modified. Production modules and the packaged program remain unmodified.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { startApp } from '../../../../tests/m1b/helpers.ts';
import { parsePdfDocument } from '../../../../packages/app-core/src/domain/pdfjs-document.ts';
import { m1bFingerprints } from '../../../../scripts/m1b-fingerprint.mjs';
import { desktopPackageDir } from '../../../../scripts/desktop-paths.ts';

const dir = path.dirname(fileURLToPath(import.meta.url));
const observations = [];
async function check(name, work) {
  const detail = {};
  try { await work(detail); observations.push({ finding: 'F-07', name, status: 'passed', detail }); }
  catch (e) { observations.push({ finding: 'F-07', name, status: 'failed', actual: e.message, detail }); }
  console.log(JSON.stringify(observations.at(-1)));
}
async function call(ctx, commandId, input) {
  const result = await ctx.app.call(ctx.actor, { commandId, input, idempotencyKey: crypto.randomUUID() }, ctx.grant.handle);
  assert.equal(result.status, 'ok', result.error?.message);
  return result.value;
}
const bytes = name => [...fs.readFileSync(path.join(dir, `${name}.pdf`))];
const seed = await startApp();
const books = {}, notes = {}, before = {};
try {
  await call(seed, 'settings.skipAi', {});
  for (const name of ['single', 'repeated', 'multiline', 'paged']) books[name] = await call(seed, 'library.importDocument', { title: name, format: 'pdf', bytes: bytes(name) });
  notes.standalone = await call(seed, 'notes.create', { title: 'Independent note target', text: 'Synthetic note context' });
  for (const [name, source, stored, quote] of [
    ['oldUnique', 'multiline', 'FIRST LINE SECOND LINE THIRD LINE', 'SECOND LINE'],
    ['oldAmbiguous', 'repeated', 'OLD REPEAT REPEAT', 'REPEAT'],
  ]) {
    const book = books[name] = await call(seed, 'library.importDocument', { title: name, format: 'pdf', bytes: bytes(source) });
    const db = seed.app.store.sqlite;
    const payload = JSON.parse(db.prepare('SELECT payload_json FROM resource_revisions WHERE id=?').get(book.revisionId).payload_json);
    payload.parts[0].normalized = stored;
    delete payload.parts[0].textRuns;
    payload.parserId = 'pdf-structure-v3';
    payload.traits = { pages: 1, engine: 'builtin-pdf', representation: 'legacy-synthetic-stored-text' };
    db.prepare('UPDATE resource_revisions SET payload_json=? WHERE id=?').run(JSON.stringify(payload), book.revisionId);
    const start = stored.lastIndexOf(quote);
    notes[name] = await call(seed, 'notes.create', { title: name, text: quote, resourceId: book.resourceId, resourceRevisionId: book.revisionId,
      locator: { kind: 'text', partId: 'page-1', representationId: book.revisionId, normalizationVersion: 'nfc-lf-codepoint-v1', range: { start, end: start + quote.length }, quote: { exact: quote } } });
    before[name] = { resourceId: book.resourceId, revisionId: book.revisionId,
      revision: db.prepare('SELECT * FROM resource_revisions WHERE id=?').get(book.revisionId),
      anchors: db.prepare('SELECT * FROM anchors WHERE resource_revision_id=?').all(book.revisionId),
      note: db.prepare('SELECT * FROM content_objects WHERE id=?').get(notes[name].objectId),
      history: db.prepare('SELECT * FROM object_revisions WHERE object_id=? ORDER BY revision').all(notes[name].objectId) };
  }
} finally { seed.app.close(); }

const env = { ...process.env, MANGA_CHANNEL: 'test', MANGA_PROFILE_ROOT: seed.profileRoot, MANGA_DOCUMENTS_DIR: path.join(seed.profileRoot, 'documents'), MANGA_POINTER_FILE: path.join(seed.profileRoot, 'launcher/pointer.json') };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: path.join(desktopPackageDir, 'MANGA-win32-x64/MANGA.exe'), env });
const page = await app.firstWindow();
page.setDefaultTimeout(12000);
const session = async () => {
  const button = page.locator('[data-testid^="session-open-"][data-current="true"]');
  return { id: await button.getAttribute('data-testid'), title: await button.textContent() };
};
async function openBook(name, expected) {
  await page.getByTestId('nav-reading').click();
  await page.getByTestId(`open-${books[name].resourceId}`).click();
  await page.waitForFunction(text => document.querySelector('[data-testid="reading-pdf-text"]')?.textContent.includes(text), expected);
}
try {
  await page.getByTestId('nav-reading').waitFor();
  await openBook('repeated', 'REPEAT');
  await check('late original after leaving reading cannot rebind the selected note session', async detail => {
    await app.evaluate(({ ipcMain }, id) => {
      const original = ipcMain._invokeHandlers.get('manga:command');
      globalThis.supplementHandler = original;
      ipcMain.removeHandler('manga:command');
      ipcMain.handle('manga:command', async (event, payload) => {
        if (payload.commandId === 'library.readOriginal' && payload.input.resourceId === id) {
          const value = await original(event, payload);
          globalThis.originalPending = true;
          await new Promise(resolve => { globalThis.releaseOriginal = resolve; });
          return value;
        }
        return original(event, payload);
      });
    }, books.single.resourceId);
    try {
      await page.getByTestId(`open-${books.single.resourceId}`).click();
      await page.waitForTimeout(150);
      assert.equal(await app.evaluate(() => globalThis.originalPending), true);
      await page.getByTestId('nav-notes').click();
      await page.getByTestId(`note-${notes.standalone.objectId}`).click();
      await page.waitForFunction(() => document.querySelector('[data-testid^="session-open-"][data-current="true"]')?.textContent.includes('Independent note target'));
      detail.before = await session();
      await app.evaluate(() => globalThis.releaseOriginal());
      await page.waitForTimeout(500);
      detail.after = await session();
      detail.noteTitle = await page.getByTestId('note-title').textContent();
      assert.equal(detail.after.id, detail.before.id, 'late PDF original rebound the selected note session');
    } finally {
      await app.evaluate(({ ipcMain }) => { globalThis.releaseOriginal?.(); ipcMain.removeHandler('manga:command'); ipcMain.handle('manga:command', globalThis.supplementHandler); });
    }
  });
  await check('late getTextContent cannot replace the current page text layer after task destruction', async detail => {
    await openBook('repeated', 'REPEAT');
    const chunk = fs.readdirSync('apps/desktop/.vite/renderer/main_window/assets').find(name => /^pdf-.*\.js$/.test(name));
    await page.evaluate(async ({ chunk, data }) => {
      const pdfjs = await import(new URL(`./assets/${chunk}`, location.href).href);
      const probe = pdfjs.getDocument({ data: new Uint8Array(data), isEvalSupported: false });
      const doc = await probe.promise;
      const pdfPage = await doc.getPage(1);
      const proto = Object.getPrototypeOf(pdfPage);
      globalThis.textPrototype = proto;
      globalThis.originalGetText = proto.getTextContent;
      globalThis.workerDestroyed = 0;
      globalThis.workerPrototype = pdfjs.PDFWorker.prototype;
      globalThis.originalDestroy = pdfjs.PDFWorker.prototype.destroy;
      pdfjs.PDFWorker.prototype.destroy = function (...args) { globalThis.workerDestroyed++; return globalThis.originalDestroy.apply(this, args); };
      await probe.destroy();
      proto.getTextContent = async function (...args) {
        const result = await globalThis.originalGetText.apply(this, args);
        if (!globalThis.textPending && result.items.some(item => item.str === 'FIRST LINE')) {
          globalThis.textPending = true;
          await new Promise(resolve => { globalThis.releaseText = resolve; });
        }
        return result;
      };
    }, { chunk, data: bytes('single') });
    try {
      await page.getByTestId(`open-${books.paged.resourceId}`).click();
      await page.waitForFunction(() => globalThis.textPending);
      detail.destroyBeforeSwitch = await page.evaluate(() => globalThis.workerDestroyed);
      await page.getByTestId('reading-next').click();
      await page.waitForFunction(() => document.querySelector('[data-testid="reading-pdf-text"]')?.textContent === 'PAGE TWO');
      detail.destroyAfterSwitch = await page.evaluate(() => globalThis.workerDestroyed);
      detail.before = await page.getByTestId('reading-pdf-text').textContent();
      await page.evaluate(() => globalThis.releaseText());
      await page.waitForTimeout(500);
      detail.after = await page.getByTestId('reading-pdf-text').textContent();
      detail.currentTitle = await page.getByTestId('reading-title').textContent().catch(() => null);
      assert.ok(detail.destroyAfterSwitch > detail.destroyBeforeSwitch, 'switch did not destroy the old worker');
      assert.equal(detail.after, detail.before, 'a destroyed generation replaced the new text layer');
    } finally {
      await page.evaluate(() => { globalThis.releaseText?.(); globalThis.textPrototype.getTextContent = globalThis.originalGetText; globalThis.workerPrototype.destroy = globalThis.originalDestroy; });
    }
  });
  for (const name of ['oldUnique', 'oldAmbiguous']) await check(`different stored representation ${name} preserves quote placement without rewriting revision`, async detail => {
    await page.getByTestId('nav-notes').click();
    await page.getByTestId(`note-source-${notes[name].objectId}`).click();
    await page.waitForFunction(text => document.querySelector('[data-testid="reading-pdf-text"]')?.textContent.includes(text), name === 'oldUnique' ? 'SECOND LINE' : 'REPEAT');
    detail.cardStatus = await page.getByTestId('reading-source-card').getAttribute('data-source-status');
    if (name === 'oldUnique') await page.locator('.textLayer .reading-quote-hit').waitFor();
    else await page.getByTestId('reading-pdf-needs-review').waitFor();
    detail.highlights = await page.locator('.textLayer .reading-quote-hit').allTextContents();
    detail.needsReview = await page.getByTestId('reading-pdf-needs-review').count();
    assert.deepEqual(detail.highlights, name === 'oldUnique' ? ['SECOND LINE'] : []);
    if (name === 'oldAmbiguous') assert.equal(detail.needsReview, 1);
    await page.getByTestId('reading-source-back').click();
    await page.getByTestId('note-title').waitFor();
  });
} finally { await app.close(); }

await check('old representations anchors notes and histories survive reopening unchanged', async detail => {
  const ctx = await startApp({ profileRoot: seed.profileRoot });
  try {
    const db = ctx.app.store.sqlite;
    detail.unchanged = [];
    for (const name of ['oldUnique', 'oldAmbiguous']) {
      const saved = before[name];
      assert.deepEqual(db.prepare('SELECT * FROM resource_revisions WHERE id=?').get(saved.revisionId), saved.revision);
      assert.deepEqual(db.prepare('SELECT * FROM anchors WHERE resource_revision_id=?').all(saved.revisionId), saved.anchors);
      assert.deepEqual(db.prepare('SELECT * FROM content_objects WHERE id=?').get(notes[name].objectId), saved.note);
      assert.deepEqual(db.prepare('SELECT * FROM object_revisions WHERE object_id=? ORDER BY revision').all(notes[name].objectId), saved.history);
      detail.unchanged.push(name);
    }
  } finally { ctx.app.close(); }
});
await check('in-flight PDF parse observes cancellation after entry', async detail => {
  // Hold a real page response; timer-only cancellation can miss a fast parse entirely.
  await parsePdfDocument(new Uint8Array(bytes('single')));
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const probe = pdfjs.getDocument({ data: new Uint8Array(bytes('single')) });
  const probePage = await (await probe.promise).getPage(1);
  const proto = Object.getPrototypeOf(probePage);
  const original = proto.getTextContent;
  const entered = Promise.withResolvers();
  const released = Promise.withResolvers();
  proto.getTextContent = async function (...args) {
    const result = await original.apply(this, args);
    entered.resolve();
    await released.promise;
    return result;
  };
  const controller = new AbortController();
  const pending = parsePdfDocument(new Uint8Array(bytes('multiline')), { signal: controller.signal });
  const outcome = pending.then(() => 'published', error => error.code ?? error.message);
  await entered.promise;
  detail.enteredBeforeCancel = true;
  controller.abort();
  let timer;
  try {
    detail.result = await Promise.race([
      outcome,
      new Promise(resolve => { timer = setTimeout(() => resolve('pending-after-3000ms'), 3000); }),
    ]);
  } finally { clearTimeout(timer); released.resolve(); proto.getTextContent = original; await probe.destroy(); }
  assert.equal(detail.result, 'CANCELLED');
});
await check('disable cancels an in-flight PDF import and re-enable starts a fresh worker', async detail => {
  const ctx = await startApp({ useParseWorker: true });
  const released = Promise.withResolvers();
  try {
    const worker = ctx.app.parseWorker;
    assert.ok(worker);
    const original = worker.parse.bind(worker);
    const entered = Promise.withResolvers();
    worker.parse = async request => {
      const result = await original(request);
      entered.resolve();
      // Cooperate with the runtime's cancellation barrier. A deliberately uncooperative
      // invocation correctly prevents disabling and would test a different contract.
      const onAbort = () => released.resolve();
      request.signal?.addEventListener('abort', onAbort, { once: true });
      if (request.signal?.aborted) onAbort();
      try { await released.promise; } finally { request.signal?.removeEventListener('abort', onAbort); }
      return result;
    };
    const oldPid = worker.pid();
    const beforeGeneration = ctx.app.parseGeneration;
    const pending = ctx.app.call(ctx.actor, { commandId: 'library.importDocument', input: { title: 'old generation', format: 'pdf', bytes: bytes('single') }, idempotencyKey: crypto.randomUUID() }, ctx.grant.handle);
    await entered.promise;
    await ctx.app.runtime.applyProfile({ profileId: 'm1a', revision: 2, enabledFeatures: ['settings'], disabledFeatures: ['library', 'notes', 'inventory', 'agent'], preferredProviders: {} });
    await ctx.app.runtime.applyProfile({ profileId: 'm1a', revision: 3, enabledFeatures: ['library', 'notes', 'settings', 'inventory', 'agent'], disabledFeatures: [], preferredProviders: {} });
    detail.generationAdvanced = ctx.app.parseGeneration > beforeGeneration;
    detail.newWorker = ctx.app.parseWorker?.pid() !== oldPid;
    for (let i = 0; i < 100; i++) {
      try { process.kill(oldPid, 0); } catch { detail.oldWorkerExited = true; break; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    released.resolve();
    const result = await pending;
    detail.lateResult = { status: result.status, code: result.error?.code };
    detail.resourcesBeforeFreshImport = ctx.app.store.sqlite.prepare('SELECT count(*) AS n FROM resources').get().n;
    assert.equal(detail.generationAdvanced, true);
    assert.equal(detail.newWorker, true);
    assert.equal(detail.oldWorkerExited, true);
    assert.equal(result.status, 'error');
    assert.equal(result.error?.code, 'CANCELLED');
    assert.equal(detail.resourcesBeforeFreshImport, 0);
    const fresh = await call(ctx, 'library.importDocument', { title: 'current generation', format: 'pdf', bytes: bytes('single') });
    assert.ok(fresh.resourceId);
    detail.freshImport = true;
  } finally { released.resolve(); ctx.app.close(); }
});
const report = { at: new Date().toISOString(), ...m1bFingerprints(process.cwd()), scriptFingerprint: createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex'), status: observations.every(row => row.status === 'passed') ? 'passed' : 'rework-required', productAcceptance: 'not-run', formalH: 'not-run', observations };
fs.writeFileSync(path.join(dir, 'a-supplemental-review.json'), JSON.stringify(report, null, 2) + '\n');
if (report.status !== 'passed') process.exitCode = 1;
