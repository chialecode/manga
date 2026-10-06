import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import { MangaProductApp, type resolveLaunchLayout } from "@manga/app-core";
import { createId } from "@manga/contracts";
import { productWindow } from "../window-options.ts";
import { clickTestId, viewport } from "./driver.ts";
import { actor, capturePage, openSettingsPage, toRail } from "./common.ts";
import { runAgentSmoke } from "./agent.ts";
import { measurePaneBench, measureScaleWindowBench, measureWindowBench, type ScaleSpec } from "./bench-window.ts";
import { runClosureSmoke } from "./closure.ts";
import { runFormatsSmoke } from "./formats.ts";
import { runMediaSmoke } from "./media.ts";
import { runReworkSmoke } from "./rework.ts";
import { runVoiceSmoke } from "./voice.ts";

/**
 * Packaged-window smoke and benchmark harness. Loaded only when the app starts with --manga-smoke
 * (see ../index.ts); a normal start never imports this module. Each phase lives in its own module; this file starts the window,
 * dispatches the phase named by MANGA_SMOKE_PHASE, writes its report and takes the screenshots that belong to it.
 */
type Layout = ReturnType<typeof resolveLaunchLayout>;

export async function runSmoke(input: { appService: MangaProductApp | undefined; ownerGrant: string | undefined; window: BrowserWindow; layout: Layout }): Promise<void> {
  const layout = input.layout;
  let appService = input.appService;
  const ownerGrant = input.ownerGrant;
  const window = input.window;
  try {
    await window.webContents.executeJavaScript(`new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        const text = document.body ? document.body.innerText : "";
        if (text && !text.includes("正在加载") && text.length > 8) resolve(true);
        else if (Date.now() - started > 8000) resolve(false);
        else setTimeout(tick, 50);
      };
      tick();
    })`);
  } catch {
    // screenshot may still be taken
  }
  const phaseName = process.env.MANGA_SMOKE_PHASE ?? "initial";
  const evidenceDir = process.env.MANGA_SMOKE_EVIDENCE_DIR;
  let markerRestored: boolean | undefined;
  const reportExtras: Record<string, unknown> = {};
  const merge = (flow: Record<string, unknown> & { ok: boolean }) => {
    markerRestored = flow.ok;
    Object.assign(reportExtras, flow);
  };
  if (appService && ownerGrant) {
    if (phaseName === "initial") {
      await appService.call(actor, { commandId: "notes.create", idempotencyKey: "smoke-marker", input: { title: "smoke-marker", text: "written before restart" } }, ownerGrant);
    } else if (phaseName === "restart") {
      const ws = await appService.call(actor, { commandId: "workspace.get", idempotencyKey: createId("smoke"), input: {} }, ownerGrant);
      const notes = (ws.status === "ok" ? (ws.value as { notes?: Array<{ title: string }> }).notes : undefined) ?? [];
      markerRestored = notes.some((note) => note.title === "smoke-marker");
    } else if (phaseName === "agent" || phaseName === "agent-restart") {
      merge(await runAgentSmoke(appService, ownerGrant, window, phaseName));
    } else if (phaseName === "reading") {
      const opened = await toRail(window) && await clickTestId(window, "nav-reading");
      await window.setContentSize(productWindow.width, productWindow.height);
      await new Promise((resolve) => setTimeout(resolve, 400));
      const wide = await viewport(window);
      await window.setContentSize(720, 540);
      await new Promise((resolve) => setTimeout(resolve, 400));
      const narrow = await viewport(window);
      await window.setContentSize(productWindow.width, productWindow.height);
      reportExtras.readingNav = opened;
      reportExtras.viewports = { wide, narrow };
      markerRestored = opened;
    } else if (phaseName === "closure" || phaseName === "closure-restart") {
      merge(await runClosureSmoke(appService, ownerGrant, window, phaseName));
    } else if (phaseName === "media") {
      merge(await runMediaSmoke({ appService, grant: ownerGrant, view: window, evidenceDir }));
    } else if (phaseName === "voice") {
      merge(await runVoiceSmoke({ appService, grant: ownerGrant, view: window, evidenceDir }));
    } else if (phaseName === "formats") {
      merge(await runFormatsSmoke(appService, ownerGrant, window, layout.partitions.logs));
    } else if (phaseName === "rework") {
      merge(await runReworkSmoke({ appService, grant: ownerGrant, view: window, evidenceDir, logsDir: layout.partitions.logs }));
    } else if (phaseName === "bench-scale") {
      const spec = JSON.parse(fs.readFileSync(String(process.env.MANGA_SMOKE_SCALE_SPEC), "utf8")) as ScaleSpec;
      const measured = await measureScaleWindowBench(appService, ownerGrant, window, spec);
      reportExtras.scaleOk = measured.ok;
      markerRestored = measured.ok === true;
      fs.mkdirSync(layout.partitions.logs, { recursive: true });
      fs.writeFileSync(path.join(layout.partitions.logs, "bench-scale-window.json"), `${JSON.stringify(measured, null, 2)}\n`);
    } else if (phaseName === "bench-pane") {
      const spec = JSON.parse(fs.readFileSync(String(process.env.MANGA_SMOKE_PANE_SPEC), "utf8")) as { resourceId: string; notes: number };
      await toRail(window);
      const measured = await measurePaneBench(window, spec.resourceId, spec.notes);
      reportExtras.paneOk = measured.ok;
      markerRestored = measured.ok === true;
      fs.mkdirSync(layout.partitions.logs, { recursive: true });
      fs.writeFileSync(path.join(layout.partitions.logs, "bench-pane-window.json"), `${JSON.stringify(measured, null, 2)}\n`);
    } else if (phaseName === "bench") {
      const launchedAt = Number(process.env.MANGA_SMOKE_LAUNCHED_AT ?? Date.now());
      reportExtras.readyMs = Date.now() - launchedAt;
      const measured = await measureWindowBench(window);
      Object.assign(reportExtras, measured);
      markerRestored = measured.ok === true;
      fs.mkdirSync(layout.partitions.logs, { recursive: true });
      fs.writeFileSync(path.join(layout.partitions.logs, "bench-window.json"), `${JSON.stringify({
        readyMs: reportExtras.readyMs,
        interactionMs: measured.interactionMs,
        contentAvailableMs: measured.contentAvailableMs,
        saveReceiptMs: measured.saveReceiptMs,
        importToReadableMs: measured.importToReadableMs,
        waitedForContent: measured.waitedForContent === true,
        process: "electron",
        ok: measured.ok === true,
      }, null, 2)}\n`);
    }
  }
  const facets = appService ? [...appService.uiFacets] : [];
  const report = {
    writable: layout.writable,
    channel: layout.channel,
    uiFacets: facets,
    markerRestored,
    ...reportExtras,
    status: layout.writable && facets.length > 0 && markerRestored !== false && reportExtras.ok !== false ? "passed" : "failed",
  };
  fs.mkdirSync(layout.partitions.logs, { recursive: true });
  fs.writeFileSync(path.join(layout.partitions.logs, `smoke-${phaseName}.json`), `${JSON.stringify(report, null, 2)}\n`);
  if (evidenceDir) {
    await capturePage(window, evidenceDir, `ui-smoke-${phaseName}.png`);
    // The pages that belong to the phase, reached through the rail the way a person reaches them.
    if (phaseName === "initial" && await toRail(window) && await clickTestId(window, "nav-library")) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      await capturePage(window, evidenceDir, "ui-smoke-initial-library.png");
    }
    if ((phaseName === "agent" || phaseName === "agent-restart") && await toRail(window) && await clickTestId(window, "nav-agent")) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      await capturePage(window, evidenceDir, `ui-smoke-${phaseName}-agent.png`);
    }
    if (phaseName === "closure" || phaseName === "closure-restart") {
      if (await toRail(window) && await clickTestId(window, "nav-reading")) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        await capturePage(window, evidenceDir, `ui-smoke-${phaseName}-reading.png`);
      }
      if (await openSettingsPage(window, "records")) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        await capturePage(window, evidenceDir, `ui-smoke-${phaseName}-records.png`);
      }
    }
  }
  appService?.close();
  appService = undefined;
  app.exit(report.status === "passed" ? 0 : 1);
}
