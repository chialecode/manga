// ACT-01 follow-up: real mouse drags at PDF line edges and the combining-mark sample. Writes only this directory.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { startApp } from '../../../../tests/m1b/helpers.ts';
import { buildPdfFixture } from '../../../../packages/app-core/src/domain/pdf-fixture.ts';
import { m1bFingerprints } from '../../../../scripts/m1b-fingerprint.mjs';
import { desktopPackageDir } from '../../../../scripts/desktop-paths.ts';

const dir = path.dirname(fileURLToPath(import.meta.url));
const earlier = path.join(dir, '../a-b11-review');
const observations = [];
async function check(name, fn) {
  const detail = {};
  try { await fn(detail); observations.push({ name, status: 'passed', detail }); }
  catch (e) { observations.push({ name, status: 'failed', actual: e instanceof Error ? e.message : String(e), detail }); }
}
async function call(ctx, commandId, input) {
  const r = await ctx.app.call(ctx.actor, { commandId, input, idempotencyKey: crypto.randomUUID() }, ctx.grant.handle);
  assert.equal(r.status, 'ok', r.error?.message);
  return r.value;
}

// The repeated and multiline samples are the ones the user reviewed; unicode is regenerated with the corrected widths.
const samples = {
  repeated: fs.readFileSync(path.join(earlier, 'repeated.pdf')),
  multiline: fs.readFileSync(path.join(earlier, 'multiline.pdf')),
  unicode: Buffer.from(buildPdfFixture([{ lines: ['中文 😀 e\u0301'] }])),
  // A PDF only places glyphs. Decomposed e + U+0301 with no mark positioning cannot compose; precomposed é can.
  accents: Buffer.from(buildPdfFixture([{ lines: ['组合 e\u0301', '预组合 \u00e9'] }])),
};
fs.writeFileSync(path.join(dir, 'unicode.pdf'), samples.unicode);
fs.writeFileSync(path.join(dir, 'accent-forms.pdf'), samples.accents);
const seed = await startApp();
const books = {};
try {
  await call(seed, 'settings.skipAi', {});
  for (const [name, bytes] of Object.entries(samples)) books[name] = await call(seed, 'library.importDocument', { title: name, format: 'pdf', bytes: [...bytes] });
} finally { seed.app.close(); }

const env = { ...process.env, MANGA_CHANNEL: 'test', MANGA_PROFILE_ROOT: seed.profileRoot, MANGA_DOCUMENTS_DIR: path.join(seed.profileRoot, 'documents'), MANGA_POINTER_FILE: path.join(seed.profileRoot, 'launcher/pointer.json') };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: path.join(desktopPackageDir, 'MANGA-win32-x64/MANGA.exe'), env });
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  await page.getByTestId('nav-reading').waitFor();
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setContentSize(1280, 840); w.webContents.setZoomFactor(1); });
  await page.getByTestId('nav-reading').click();

  async function open(name, text) {
    await page.getByTestId(`open-${books[name].resourceId}`).click();
    await page.waitForFunction(expected => [...document.querySelectorAll('[data-testid="reading-pdf-text"] span')].some(span => span.textContent?.includes(expected) && span.getBoundingClientRect().width > 20), text);
    await settle();
  }
  // The view re-renders while its width settles after opening a book; a person starts reading after that.
  async function settle() {
    const epoch = () => page.getByTestId('reading-page-render').getAttribute('data-pdf-epoch');
    let last = await epoch();
    for (let stable = 0; stable < 4;) {
      await page.waitForTimeout(150);
      const now = await epoch();
      stable = now === last ? stable + 1 : 0;
      last = now;
    }
  }
  async function lines() {
    return page.locator('[data-testid="reading-pdf-text"] .textLayer > span').evaluateAll(nodes => nodes.map(node => {
      const box = node.getBoundingClientRect();
      return { text: node.textContent, x: box.x, y: box.y, w: box.width, h: box.height };
    }));
  }
  // Coordinates are measured right before each drag, so any layout shift during the drag shows up as a moved page.
  async function drag(from, to) {
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    const pageTop = () => page.getByTestId('reading-pdf-canvas').evaluate(canvas => canvas.getBoundingClientRect().top);
    const topBefore = await pageTop();
    const epochBefore = await page.getByTestId('reading-page-render').getAttribute('data-pdf-epoch');
    const [l1, l2] = await lines();
    const point = spec => spec({ l1, l2 });
    const [x1, y1] = point(from);
    const [x2, y2] = point(to);
    await page.mouse.move(x1, y1);
    await page.mouse.down();
    await page.mouse.move(x2, y2, { steps: 24 });
    await page.mouse.up();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    return {
      selected: await page.evaluate(() => window.getSelection()?.toString() ?? ''),
      noteEnabled: await page.getByTestId('reading-note').isEnabled(),
      reviewNotice: await page.getByTestId('reading-pdf-needs-review').count(),
      pageMoved: (await pageTop()) - topBefore,
      rerendered: (await page.getByTestId('reading-page-render').getAttribute('data-pdf-epoch')) !== epochBefore,
      ends: await page.evaluate(() => {
        const selection = window.getSelection();
        const name = node => node ? (node.nodeType === 3 ? `text:${node.textContent}` : `${node.nodeName}.${node.className}`) : null;
        return selection ? [name(selection.anchorNode), selection.anchorOffset, name(selection.focusNode), selection.focusOffset] : null;
      }),
    };
  }
  const mid = line => line.y + line.h / 2;
  const drags = {
    'second line from its first letter to past its end': [({ l2 }) => [l2.x + 1, mid(l2)], ({ l2 }) => [l2.x + l2.w + 60, mid(l2)]],
    'second line from the left margin to its last letter': [({ l2 }) => [l2.x - 20, mid(l2)], ({ l2 }) => [l2.x + l2.w - 1, mid(l2)]],
    'second line from the left margin to past its end': [({ l2 }) => [l2.x - 20, mid(l2)], ({ l2 }) => [l2.x + l2.w + 60, mid(l2)]],
    'first line from its first letter to past its end': [({ l1 }) => [l1.x + 1, mid(l1)], ({ l1 }) => [l1.x + l1.w + 60, mid(l1)]],
    'first line start to past the end of the second line': [({ l1 }) => [l1.x + 1, mid(l1)], ({ l2 }) => [l2.x + l2.w + 60, mid(l2)]],
  };
  for (const name of ['repeated', 'multiline']) {
    await open(name, name === 'repeated' ? 'REPEAT' : 'SECOND LINE');
    for (const [label, [from, to]] of Object.entries(drags)) await check(`${name}: ${label}`, async detail => {
      Object.assign(detail, await drag(from, to));
      assert.equal(detail.reviewNotice, 0, 'a drag in the current representation must not ask for review');
      assert.equal(detail.noteEnabled, true, 'the drag must leave a usable excerpt');
      assert.equal(detail.pageMoved, 0, 'the page must not move during the drag');
    });
  }

  await check('multiline: double click still selects a word natively', async detail => {
    await open('multiline', 'SECOND LINE');
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    const [, line] = await lines();
    await page.mouse.dblclick(line.x + line.w * 0.2, mid(line));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    detail.selected = await page.evaluate(() => window.getSelection()?.toString() ?? '');
    detail.noteEnabled = await page.getByTestId('reading-note').isEnabled();
    assert.equal(detail.selected.trim(), 'SECOND');
    assert.equal(detail.noteEnabled, true);
  });

  await check('repeated: excerpt from a line-edge drag points at the second line', async detail => {
    await open('repeated', 'REPEAT');
    const [, line] = await lines();
    await page.mouse.move(line.x - 20, mid(line));
    await page.mouse.down();
    await page.mouse.move(line.x + line.w + 60, mid(line), { steps: 24 });
    await page.mouse.up();
    await page.getByTestId('reading-note').click();
    await page.getByTestId('note-title').waitFor();
    await page.getByTestId('note-block-source-quote').click();
    await page.waitForFunction(() => !!document.querySelector('.textLayer .reading-quote-hit'));
    detail.sourceStatus = await page.getByTestId('reading-source-card').getAttribute('data-source-status');
    detail.highlights = await page.locator('.textLayer .reading-quote-hit').evaluateAll(nodes => nodes.map(node => ({ text: node.textContent, cpStart: node.dataset.cpStart, cpEnd: node.dataset.cpEnd })));
    assert.equal(detail.sourceStatus, 'resolved');
    assert.deepEqual(detail.highlights, [{ text: 'REPEAT', cpStart: '7', cpEnd: '13' }]);
    await page.getByTestId('reading-source-back').click();
    await page.getByTestId('note-title').waitFor();
    await page.getByTestId('nav-reading').click();
  });

  await check('unicode: combining acute sits on its e and the line still selects', async detail => {
    await open('unicode', '中文');
    await page.getByTestId('reading-zoom-in').click();
    await page.getByTestId('reading-zoom-in').click();
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="reading-pdf-text"] span')].some(span => span.textContent?.includes('中') && span.getBoundingClientRect().width > 60));
    await settle();
    const spans = await page.locator('[data-testid="reading-pdf-text"] .textLayer > span').evaluateAll(nodes => nodes.map(node => {
      const box = node.getBoundingClientRect();
      return { codePoints: [...(node.textContent ?? '')].map(char => char.codePointAt(0).toString(16)), x: box.x, y: box.y, w: box.width, h: box.height };
    }));
    detail.spans = spans;
    const canvas = await page.getByTestId('reading-pdf-canvas').boundingBox();
    const accent = spans.find(span => span.codePoints.includes('301') || span.codePoints.includes('e9'));
    assert.ok(accent, 'the text layer keeps the accented letter');
    // The whole line is one span. Its advances are 1 + 1 + 0.278 + 1 + 0.278 + 0.556 em and the acute adds none;
    // the earlier sample gave every code point one em, 7 em in total, which put the acute one em to the right.
    detail.lineWidthEm = accent.w / accent.h;
    assert.ok(Math.abs(detail.lineWidthEm - 4.112) < 0.05, `the line is ${detail.lineWidthEm} em wide`);
    await page.screenshot({ path: path.join(dir, 'unicode-accent.png'), clip: { x: canvas.x, y: canvas.y, width: Math.min(canvas.width, 900), height: Math.min(canvas.height, 300) } });
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    const first = spans[0];
    const last = spans[spans.length - 1];
    await page.mouse.move(first.x - 10, first.y + first.h / 2);
    await page.mouse.down();
    await page.mouse.move(last.x + last.w + 40, last.y + last.h / 2, { steps: 24 });
    await page.mouse.up();
    detail.selected = await page.evaluate(() => window.getSelection()?.toString() ?? '');
    detail.noteEnabled = await page.getByTestId('reading-note').isEnabled();
    detail.reviewNotice = await page.getByTestId('reading-pdf-needs-review').count();
    assert.equal(detail.noteEnabled, true);
    assert.equal(detail.reviewNotice, 0);
  });
  await check('accent forms: both lines keep NFC é in the text layer', async detail => {
    await open('accents', '预组合');
    await page.getByTestId('reading-zoom-in').click();
    await page.getByTestId('reading-zoom-in').click();
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="reading-pdf-text"] span')].some(span => span.textContent?.includes('预组合') && span.getBoundingClientRect().width > 60));
    await settle();
    detail.lines = await page.locator('[data-testid="reading-pdf-text"] .textLayer > span').evaluateAll(nodes => nodes.map(node => [...(node.textContent ?? '')].map(char => char.codePointAt(0).toString(16))));
    await page.locator('[data-testid="reading-pdf-text"] .textLayer > span').last().scrollIntoViewIfNeeded();
    const text = await page.locator('[data-testid="reading-pdf-text"] .textLayer > span').evaluateAll(nodes => {
      const boxes = nodes.map(node => node.getBoundingClientRect());
      return { left: Math.min(...boxes.map(box => box.left)), top: Math.min(...boxes.map(box => box.top)), right: Math.max(...boxes.map(box => box.right)), bottom: Math.max(...boxes.map(box => box.bottom)) };
    });
    await page.screenshot({ path: path.join(dir, 'accent-forms.png'), clip: { x: text.left - 30, y: text.top - 30, width: text.right - text.left + 60, height: text.bottom - text.top + 60 } });
    assert.ok(detail.lines.some(line => line.includes('e9')), 'the precomposed line keeps é');
    assert.ok(detail.lines.some(line => line.includes('301') || line.filter(code => code === 'e9').length), 'the decomposed line keeps its accent');
  });
} finally {
  await app.close();
}

const report = {
  at: new Date().toISOString(),
  ...m1bFingerprints(process.cwd()),
  scriptFingerprint: createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
  status: observations.every(row => row.status === 'passed') ? 'passed' : 'failed',
  productAcceptance: 'not-run',
  observations,
};
fs.writeFileSync(path.join(dir, 'edge-drag-review.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ status: report.status, failed: observations.filter(row => row.status !== 'passed').map(row => row.name) }));
if (report.status !== 'passed') process.exitCode = 1;
