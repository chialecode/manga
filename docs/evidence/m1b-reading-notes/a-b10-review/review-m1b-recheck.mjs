// A review adapter: original assertions retained; PDF readiness/Canvas checks updated for the async engine.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { repoRoot, desktopOutput, desktopPackageDir } from "../../../../scripts/desktop-paths.ts";
import { m1bFingerprints } from "../../../../scripts/m1b-fingerprint.mjs";

const evidence = path.resolve(repoRoot, process.env.M1B_EVIDENCE_DIR ?? "docs/evidence/m1b-reading-notes/a-recheck");
const runs = path.join(desktopOutput, "review-runs");
fs.mkdirSync(runs, { recursive: true });
fs.mkdirSync(evidence, { recursive: true });
const profile = fs.mkdtempSync(path.join(runs, "a-recheck-"));
const env = { ...process.env, MANGA_CHANNEL: "test", MANGA_PROFILE_ROOT: path.join(profile, "profile"), MANGA_POINTER_FILE: path.join(profile, "pointer.json"), MANGA_DOCUMENTS_DIR: path.join(profile, "documents") };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: path.join(desktopPackageDir, "MANGA-win32-x64/MANGA.exe"), env, timeout: 30_000 });
const observations = [];
async function check(finding, name, run) {
  try { observations.push({ finding, name, status: "passed", detail: await run() }); }
  catch (error) { observations.push({ finding, name, status: "failed", actual: error.message }); }
}
try {
  const page = await app.firstWindow();
  await page.getByTestId("nav-reading").waitFor();
  const call = (commandId, input) => page.evaluate(async ({ commandId, input }) => {
    const result = await window.manga.command({ commandId, input, idempotencyKey: crypto.randomUUID() });
    if (result.status !== "ok") throw new Error(result.error?.code ?? "command failed");
    return result.value;
  }, { commandId, input });
  await call("settings.skipAi", {});
  const book = await call("library.importDocument", { title: "模式合成书", format: "txt", bytes: [...new TextEncoder().encode("模式合成书。正文用于独立会话验证。")] });
  // Reload so the product discovers the synthetic book through its usual query path.
  await page.reload();
  await page.getByTestId("nav-reading").click();
  await page.getByTestId(`open-${book.resourceId}`).click();
  await page.getByTestId("reading-body").waitFor();
  await check("F-10", "font choice renders and survives a window reload", async () => {
    await page.getByTestId("reading-font-family").selectOption("serif");
    await page.waitForFunction(() => document.querySelector('[data-testid="reading-body"]')?.style.fontFamily.includes("SimSun"));
    await page.reload();
    await page.getByTestId("nav-reading").click();
    await page.getByTestId(`open-${book.resourceId}`).click();
    assert.equal(await page.getByTestId("reading-font-family").inputValue(), "serif");
  });
  await check("F-10", "long session titles stay inside the sidebar", async () => {
    const geometry = await page.getByTestId("shell-left").evaluate((sidebar) => ({ width: sidebar.clientWidth, content: sidebar.scrollWidth }));
    assert.ok(geometry.content <= geometry.width, `session rail overflows: ${JSON.stringify(geometry)}`);
    return geometry;
  });
  await page.getByTestId("agent-composer").first().fill("enthusiast draft only");
  const original = await call("workspace.sessions", { mode: "enthusiast" });
  await page.getByTestId("mode-menu").click();
  await page.getByTestId("mode-creator").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="mode-menu"]')?.textContent?.includes("造物主"));
  // Wait for the mode-switch refresh to complete, not merely for the menu click to return.
  await page.waitForFunction(() => document.querySelector('[data-testid="notes-list"]') || !document.querySelector('[data-testid="mode-menu-list"]'));
  await check("F-05", "a mode switch does not display another mode's composer draft", async () => {
    const draft = await page.getByTestId("agent-composer").first().inputValue();
    await page.screenshot({ path: path.join(evidence, "a-mode-session.png") });
    assert.notEqual(draft, "enthusiast draft only", "creator mode displays the enthusiast session's draft");
  });
  await check("F-05", "the session rail uses the current mode after switching", async () => {
    const present = await page.getByTestId(`session-open-${original[0].sessionId}`).count();
    assert.equal(present, 0, "creator rail still lists the enthusiast session");
  });
  const scan = await call("library.importDocument", { title: "标准扫描页", format: "pdf", bytes: [...fs.readFileSync(path.join(evidence, "standard-scan.pdf"))] });
  await page.reload();
  await page.getByTestId("nav-reading").click();
  await page.getByTestId(`open-${scan.resourceId}`).click();
  await page.getByTestId("reading-title").waitFor();
  await check("F-07", "standard scan is visible in the packaged reader", async () => {
    await page.waitForFunction(()=>document.querySelector('[data-testid="reading-scan"]'));
    await page.getByTestId('reading-pdf-canvas').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(evidence, 'a-standard-scan-reader.png') });
    const canvas = await page.getByTestId('reading-pdf-canvas').evaluate(canvas=>{
      const data=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
      let dark=0;for(let i=0;i<data.length;i+=4)if(data[i]<100&&data[i+1]<100&&data[i+2]<100)dark++;
      return {width:canvas.width,height:canvas.height,dark};
    });
    assert.ok(canvas.width>0&&canvas.height>0&&canvas.dark>20, 'no painted scan in the actual reader');
    assert.equal(await page.getByTestId('reading-pdf-text').innerText(),'');
    return canvas;
  });
} finally { await app.close(); }
const report = { at: new Date().toISOString(), ...m1bFingerprints(repoRoot), status: observations.some((row) => row.status === "failed") ? "rework-required" : "passed", humanChecks: "not-run", productAcceptance: "not-run", observations };
fs.writeFileSync(path.join(evidence, "a-additional-ui-review.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
if (report.status !== "passed") process.exitCode = 1;
