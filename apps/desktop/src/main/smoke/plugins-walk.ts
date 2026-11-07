import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { BrowserWindow } from "electron";
import type { MangaProductApp } from "@manga/app-core";
import { clickTestId, setField, setSelect, sleep, waitForTestId, waitUntil } from "./driver.ts";
import { caller, js, openSettingsPage, toRail, type FlowResult } from "./common.ts";

/**
 * The BitTorrent plugin that comes with the application, in the real window and the packaged build: offered but not installed, installed by a
 * person who confirms what it may do, run in a utility process of its own, used to download a torrent from a seed on the loopback address into
 * a library path and have the files imported, then stopped and started again from the page. The seed, its tracker and the torrent come from the
 * stage script (MANGA_SMOKE_BT_SPEC); the engine is told to use no public DHT, no LAN discovery and no port mapping (MANGA_SMOKE_BT_LOOPBACK).
 */

export type BtSpec = {
  /** The magnet link of the torrent; it carries a tracker address and a secret in the tracker's query, which must never reach the page or the logs. */
  magnet: string;
  /** The secret inside the magnet's tracker address. */
  secret: string;
  libraryDir: string;
  subdir: string;
  files: Array<{ path: string; sha256: string; length: number }>;
};

type Step = { id: string; ok: boolean; detail?: unknown };
const PLUGIN_ID = "manga.acquisition-bt";

export async function runPluginsSmoke(input: { appService: MangaProductApp; grant: string; view: BrowserWindow; logsDir: string }): Promise<FlowResult & { steps: Step[] }> {
  const { appService, grant, view } = input;
  const call = caller(appService, grant);
  const steps: Step[] = [];
  const record = (id: string, ok: boolean, detail?: unknown) => { steps.push({ id, ok, ...(detail !== undefined ? { detail } : {}) }); console.error(`plugins step ${id}: ${ok ? "ok" : "FAILED"} ${JSON.stringify(detail ?? null).slice(0, 600)}`); return ok; };
  const specFile = process.env.MANGA_SMOKE_BT_SPEC;
  if (!specFile || !fs.existsSync(specFile) || process.env.MANGA_SMOKE_BT_LOOPBACK !== "1") return { ok: false, notRun: true, reason: "MANGA_SMOKE_BT_SPEC and MANGA_SMOKE_BT_LOOPBACK=1 are needed", steps };
  const spec = JSON.parse(fs.readFileSync(specFile, "utf8")) as BtSpec;
  const bodyText = () => js<string>(view, `document.body.innerText`);

  await call("settings.skipAi", {});
  await toRail(view);

  // ---- 1. offered, not installed: the package is there, nothing runs until a person says so ----
  const before = await call("plugin.bundled", {}) as { status: string; value?: { bundled?: Array<{ id: string; installed?: boolean }> } };
  const offered = (before.value?.bundled ?? []).find((item) => item.id === PLUGIN_ID);
  record("offered-not-installed", before.status === "ok" && Boolean(offered) && offered?.installed !== true, { bundled: (before.value?.bundled ?? []).map((item) => ({ id: item.id, installed: item.installed })) });
  const noEngineYet = ((await call("plugin.list", {})).value as { plugins?: Array<{ id: string }> } | undefined)?.plugins?.every((plugin) => plugin.id !== PLUGIN_ID) ?? false;
  record("nothing-installed-by-itself", noEngineYet);

  // ---- 2. installed from the settings page, with the permissions confirmed one by one ----
  const onPage = await openSettingsPage(view, "plugins");
  const clickedInstall = onPage && await clickTestId(view, `plugin-bundled-${PLUGIN_ID}-install`, 8000);
  const dialog = clickedInstall && await waitForTestId(view, "plugin-install-do", "data-testid", "plugin-install-do", 10_000);
  const trust = dialog ? await js<string>(view, `document.querySelector('[data-testid="plugin-install-trust"]')?.textContent ?? ""`) : "";
  const blockedUntilConfirmed = dialog ? await js<boolean>(view, `document.querySelector('[data-testid="plugin-install-do"]')?.disabled === true`) : false;
  for (const permission of ["network", "files"]) await clickTestId(view, `plugin-confirm-${permission}`, 3000);
  await js(view, `(() => { const box = document.querySelector('[data-testid="plugin-install-enable"]'); if (box && !box.checked) box.click(); })()`);
  const readyToInstall = await waitUntil(view, `document.querySelector('[data-testid="plugin-install-do"]') && !document.querySelector('[data-testid="plugin-install-do"]').disabled`, 4000);
  record("install-dialog", Boolean(dialog) && blockedUntilConfirmed && readyToInstall, { trust, blockedUntilConfirmed, readyToInstall });
  const installed = readyToInstall && await clickTestId(view, "plugin-install-do", 3000);
  const row = installed && await waitForTestId(view, `plugin-${PLUGIN_ID}-state`, "data-testid", `plugin-${PLUGIN_ID}-state`, 30_000);
  const running = row && await waitUntil(view, `(() => { const chip = document.querySelector('[data-testid="plugin-${PLUGIN_ID}-state"]'); return chip && /运行中/.test(chip.textContent || ""); })()`, 30_000);
  const listed = (await call("plugin.list", {})).value as { plugins?: Array<{ id: string; state: string; enabled: boolean; trust: string; permissions: string[] }> } | undefined;
  const plugin = listed?.plugins?.find((item) => item.id === PLUGIN_ID);
  record("installed-and-running", Boolean(running) && plugin?.enabled === true && plugin?.state === "running" && plugin?.trust === "first-party", { state: plugin?.state, enabled: plugin?.enabled, trust: plugin?.trust, permissions: plugin?.permissions });

  // ---- 3. a library path to receive the download; the downloads page offers the engine ----
  fs.mkdirSync(spec.libraryDir, { recursive: true });
  const added = await call("library.paths.add", { pathHandle: appService.registerPath("directory", spec.libraryDir), mediaKind: "novel", autoScan: false }) as { status: string; value?: { path?: { id: string } } };
  const pathId = added.value?.path?.id ?? "";
  record("library-path", added.status === "ok" && Boolean(pathId));
  await toRail(view);
  const onDownloads = await clickTestId(view, "nav-downloads", 8000) && await waitForTestId(view, "page-downloads", "data-testid", "page-downloads", 8000);
  const engineRunning = onDownloads && await waitForTestId(view, "downloads-engine", "data-running", "yes", 20_000);
  record("downloads-page-engine-running", Boolean(engineRunning));

  // ---- 4. a magnet link in the page, the files chosen, the download run to its end and the files imported ----
  const opened = await clickTestId(view, "downloads-add", 4000);
  const typed = opened && await setField(view, "downloads-add-magnet", spec.magnet);
  const pathSet = typed && await waitUntil(view, `document.querySelector('[data-testid="downloads-add-path"]')`, 4000) && await setSelect(view, "downloads-add-path", pathId);
  await setField(view, "downloads-add-subdir", spec.subdir);
  const submitted = Boolean(pathSet) && await clickTestId(view, "downloads-add-submit", 4000);
  const cardId = submitted ? await js<string | null>(view, `new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const card = document.querySelector('[data-testid^="download-"][data-state]');
      if (card) resolve(card.getAttribute("data-testid").slice("download-".length));
      else if (Date.now() - started > 20000) resolve(null);
      else setTimeout(tick, 50);
    };
    tick();
  })`) : null;
  record("job-added-from-magnet", Boolean(cardId), { cardId });
  const choosing = cardId ? await waitUntil(view, `document.querySelector('[data-testid="download-${cardId}"]')?.getAttribute("data-state") === "choosing"`, 60_000) : false;
  record("files-offered-to-choose", choosing);
  const pickedAll = choosing && await clickTestId(view, `download-${cardId}-all`, 4000);
  const started = pickedAll && await clickTestId(view, `download-${cardId}-start`, 4000);
  const done = started && await waitUntil(view, `document.querySelector('[data-testid="download-${cardId}"]')?.getAttribute("data-state") === "done"`, 120_000);
  const finalState = cardId ? await js<string | null>(view, `document.querySelector('[data-testid="download-${cardId}"]')?.getAttribute("data-state")`) : null;
  record("download-done", Boolean(done), { finalState });

  // The files are where the library path keeps them, whole, and the library holds them as books.
  const published = spec.files.map((file) => {
    const target = path.join(spec.libraryDir, spec.subdir, ...file.path.split("/"));
    if (!fs.existsSync(target)) return { path: file.path, present: false, sha256Matches: false };
    return { path: file.path, present: true, sha256Matches: createHash("sha256").update(fs.readFileSync(target)).digest("hex") === file.sha256 };
  });
  record("files-published-whole", published.every((file) => file.present && file.sha256Matches), { published: published.length });
  // Every file the job published was imported, and the library shows what they made (the three chapter files of one folder make one work).
  const job = cardId ? (await call("acquisition.get", { jobId: cardId })).value as { job?: { state: string; counts?: Record<string, number> } } | undefined : undefined;
  const works = (await call("works.list", { limit: 200 })).value as { items?: Array<{ id: string; title: string }> } | undefined;
  const shown = (works?.items ?? []).length;
  record("files-imported-as-works", job?.job?.counts?.imported === spec.files.length && shown >= 1, { imported: job?.job?.counts?.imported, expected: spec.files.length, works: shown });
  const stagingLeft = cardId ? fs.existsSync(path.join(appService.acquisition.stagingOf(cardId), "data")) : true;
  record("no-staging-left", !stagingLeft && job?.job?.state === "done", { state: job?.job?.state, stagingLeft });

  // The tracker's address carries a secret; it is not on the page, in the job as the page sees it, nor in the operation log.
  const text = await bodyText();
  const jobJson = JSON.stringify((await call("acquisition.list", {})).value ?? {});
  const logRows = JSON.stringify(appService.store.sqlite.prepare("SELECT * FROM operation_log").all());
  const leaked = [text.includes(spec.secret), jobJson.includes(spec.secret), logRows.includes(spec.secret)];
  record("magnet-secret-never-shown-or-logged", leaked.every((item) => item === false), { page: leaked[0], job: leaked[1], log: leaked[2] });

  // ---- 5. stopped and started again from the page ----
  await openSettingsPage(view, "plugins");
  const off = await clickTestId(view, `plugin-${PLUGIN_ID}-toggle`, 4000);
  const stopped = off && await waitUntil(view, `(document.querySelector('[data-testid="plugin-${PLUGIN_ID}-toggle"]')?.textContent || "").includes("启用")`, 15_000);
  const afterOff = (await call("plugin.list", {})).value as { plugins?: Array<{ id: string; state: string; enabled: boolean }> } | undefined;
  const offPlugin = afterOff?.plugins?.find((item) => item.id === PLUGIN_ID);
  record("disabled-from-the-page", Boolean(stopped) && offPlugin?.enabled === false && offPlugin?.state !== "running", { state: offPlugin?.state, enabled: offPlugin?.enabled });
  await sleep(300);
  const on = await clickTestId(view, `plugin-${PLUGIN_ID}-toggle`, 4000);
  const again = on && await waitUntil(view, `(document.querySelector('[data-testid="plugin-${PLUGIN_ID}-toggle"]')?.textContent || "").includes("停用")`, 30_000);
  const afterOn = (await call("plugin.list", {})).value as { plugins?: Array<{ id: string; state: string; enabled: boolean }> } | undefined;
  const onPlugin = afterOn?.plugins?.find((item) => item.id === PLUGIN_ID);
  record("enabled-again", Boolean(again) && onPlugin?.enabled === true && onPlugin?.state === "running", { state: onPlugin?.state });

  const failed = steps.filter((step) => !step.ok).map((step) => step.id);
  return { ok: failed.length === 0, steps, failed };
}
