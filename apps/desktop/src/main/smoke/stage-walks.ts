import crypto from "node:crypto";
import fs from "node:fs";
import type { BrowserWindow } from "electron";
import type { MangaProductApp } from "@manga/app-core";
import { startMockProvider } from "@manga/model-protocol";
import { waitUntil } from "./driver.ts";
import { caller, capturePage, js, leaveSettings, openSettingsPage, toRail } from "./common.ts";
import { openTrace, waitRun } from "./loop-media.ts";

/**
 * Two observations of the dependency and Agent loop stage that start from a Profile made before the application ran (计划第 7 节):
 * - `credentials-async`: the Profile an Electron 44 build saved its three credentials into, opened by this build (AT-141, 计划 4.1);
 * - `migrate-v13`: a synthetic v12 library whose Agent runs carry their pictures inline, moved to v13 on the first start (AT-145, 计划 4.4).
 * Each has a restart phase. What the stand-in services saw and what is in the database file are checked by the harness, outside the application.
 */
export type StageObservation = { name: string; status: "passed" | "failed"; detail: unknown };
type Input = { appService: MangaProductApp; grant: string; view: BrowserWindow; evidenceDir: string | undefined; phase: string };

/** The synthetic credentials of the legacy Profile (tests/helpers/legacy-credentials.ts); none is real. */
const LEGACY = { connectionId: "conn_legacy_e44", modelKey: "legacy-e44-synthetic-model-key", dandanSecret: "legacy-secret-for-the-local-fake-server", bangumiToken: "legacy-e44-synthetic-bangumi-token" };
const RENEWED = { connectionId: "conn_after_e45", modelKey: "saved-by-e45-synthetic-model-key" };

function noPlainText(appService: MangaProductApp, secrets: string[]): { rows: number; plain: number } {
  const rows = appService.store.sqlite.prepare("SELECT ciphertext FROM credentials").all() as Array<{ ciphertext: Buffer }>;
  let plain = 0;
  for (const row of rows) for (const secret of secrets) if (Buffer.from(row.ciphertext).includes(Buffer.from(secret))) plain += 1;
  return { rows: rows.length, plain };
}

async function shownTested(view: BrowserWindow, ids: string[], evidenceDir: string | undefined, shot: string | null): Promise<boolean | Record<string, string | null>> {
  // The connections were saved and tested from the main process, not from this page: the page reads them again, as after a start.
  await view.webContents.reload();
  await toRail(view);
  if (!(await openSettingsPage(view, "models"))) return false;
  let all = true;
  for (const id of ids) all = (await waitUntil(view, `document.querySelector('[data-testid="connection-test-${id}"]')?.dataset.state === "ok"`, 6000)) && all;
  const states = all ? null : Object.fromEntries(await Promise.all(ids.map(async (id) => [id, await js<string | null>(view, `document.querySelector('[data-testid="connection-test-${id}"]')?.dataset.state ?? null`)])));
  if (shot) await capturePage(view, evidenceDir, shot);
  await leaveSettings(view);
  return all || (states as Record<string, string | null>);
}

export async function runCredentialsSmoke(input: Input): Promise<{ ok: boolean; observations: StageObservation[] }> {
  const { appService, view, evidenceDir, phase } = input;
  const call = caller(appService, input.grant);
  const problems: string[] = [];
  const detail: Record<string, unknown> = { phase };
  const test = async (connectionId: string) => {
    // What the models page's “测试连接” asks for a text connection; its result stays with the connection and the page shows it.
    const result = await call("connections.probe", { connectionId });
    return result.status === "ok" && (result.value as { ok?: boolean }).ok === true;
  };
  if (phase === "credentials-async") {
    // The first decryption of a ciphertext the Electron 44 build wrote, through the platform's asynchronous interface (recorded, 计划第 7 节).
    const row = appService.store.sqlite.prepare("SELECT c.ciphertext AS ciphertext FROM provider_connections p JOIN credentials c ON c.ref = p.credential_ref WHERE p.id = ?").get(LEGACY.connectionId) as { ciphertext: Buffer } | undefined;
    if (row) {
      const started = performance.now();
      const opened = await appService.vault.decrypt(Buffer.from(row.ciphertext)).then((result) => result.plain === LEGACY.modelKey, () => false);
      detail.firstDecrypt = { ms: Math.round((performance.now() - started) * 10) / 10, opened };
    } else problems.push("the legacy model key's ciphertext is missing");
    // The legacy connection pointed at an address nothing answers; it is moved to the stand-in model, keeping its saved key.
    const listed = await call("connections.list", {});
    const legacy = (listed.status === "ok" ? (listed.value as Array<Record<string, unknown>>) : []).find((row) => row.id === LEGACY.connectionId);
    if (!legacy) problems.push("the legacy connection is missing");
    const moved = await call("connections.upsert", { id: LEGACY.connectionId, label: String(legacy?.label ?? "legacy"), protocol: "openai-chat-completions", baseUrl: process.env.MANGA_SMOKE_MODEL_ORIGIN ?? "", modelId: String(legacy?.modelId ?? "demo"), purpose: "text" });
    if (moved.status !== "ok") problems.push(`the legacy connection could not be pointed at the stand-in: ${JSON.stringify(moved.error ?? null)}`);
    detail.legacyModel = await test(LEGACY.connectionId);
    if (!detail.legacyModel) problems.push("the model key saved by the Electron 44 build did not open");
    const settings = await call("danmaku.getSettings", {});
    detail.danmakuCredentials = settings.status === "ok" ? (settings.value as { credentials: string }).credentials : null;
    if (detail.danmakuCredentials !== "custom") problems.push("the DanDanPlay credentials saved by the Electron 44 build were not found");
    const searched = await call("danmaku.search", { query: "样例" });
    detail.danmakuSearch = searched.status;
    if (searched.status !== "ok") problems.push(`the signed DanDanPlay search failed: ${JSON.stringify(searched.error ?? null).slice(0, 200)}`);
    const metadata = await call("metadata.search", { query: "Synthetic", providerIds: ["bangumi"] });
    detail.bangumiSearch = metadata.status;
    // A key saved by this build, for the restart.
    const saved = await call("connections.upsert", { id: RENEWED.connectionId, label: "e45", protocol: "openai-chat-completions", baseUrl: process.env.MANGA_SMOKE_MODEL_ORIGIN_RENEWED ?? "", modelId: "demo", purpose: "text", credentialHandle: appService.stashSecret(RENEWED.modelKey) });
    if (saved.status !== "ok") problems.push("a new model key could not be saved");
    detail.renewedModel = await test(RENEWED.connectionId);
    if (!detail.renewedModel) problems.push("the model key saved by this build did not open");
    detail.window = await shownTested(view, [LEGACY.connectionId, RENEWED.connectionId], evidenceDir, "ui-credentials-legacy.png");
  } else {
    // The stand-in models listen on new ports at each start: both connections are pointed at them again, without a key (the saved one stays).
    for (const [id, origin] of [[LEGACY.connectionId, process.env.MANGA_SMOKE_MODEL_ORIGIN], [RENEWED.connectionId, process.env.MANGA_SMOKE_MODEL_ORIGIN_RENEWED]] as const) {
      const moved = await call("connections.upsert", { id, label: id, protocol: "openai-chat-completions", baseUrl: origin ?? "", modelId: "demo", purpose: "text" });
      if (moved.status !== "ok") problems.push(`${id} could not be pointed at the stand-in after the restart`);
    }
    detail.legacyModel = await test(LEGACY.connectionId);
    detail.renewedModel = await test(RENEWED.connectionId);
    if (!detail.legacyModel || !detail.renewedModel) problems.push(`after the restart a model key did not open (legacy ${detail.legacyModel}, new ${detail.renewedModel})`);
    const searched = await call("danmaku.search", { query: "样例" });
    detail.danmakuSearch = searched.status;
    if (searched.status !== "ok") problems.push("after the restart the DanDanPlay credentials did not open");
    detail.window = await shownTested(view, [LEGACY.connectionId, RENEWED.connectionId], evidenceDir, null);
  }
  if (detail.window !== true) problems.push("the models page did not show both connections as tested");
  const stored = noPlainText(appService, [LEGACY.modelKey, LEGACY.dandanSecret, LEGACY.bangumiToken, RENEWED.modelKey]);
  detail.stored = stored;
  if (stored.plain > 0) problems.push("a credential is stored as plain text");
  const name = phase === "credentials-async" ? "credentials-async" : "credentials-async-restart";
  return { ok: problems.length === 0, observations: [{ name, status: problems.length === 0 ? "passed" : "failed", detail: { ...detail, problems } }] };
}

export async function runMigrateSmoke(input: Input): Promise<{ ok: boolean; observations: StageObservation[] }> {
  const { appService, view, evidenceDir, phase } = input;
  const call = caller(appService, input.grant);
  const problems: string[] = [];
  const store = appService.store;
  const detail: Record<string, unknown> = { phase, schemaVersion: store.getMeta("schemaVersion"), migration: store.migration ?? null };
  if (detail.schemaVersion !== "14") problems.push(`the library is at version ${String(detail.schemaVersion)}`);
  if (phase === "migrate-v13") {
    if (store.migration?.from !== 12 || !store.migration.agentMedia) problems.push("the first start did not move the pictures of v12");
  } else if (store.migration) problems.push("the second start migrated again");
  const count = (sql: string) => (store.sqlite.prepare(sql).get() as { n: number }).n;
  detail.agentMedia = count("SELECT COUNT(*) AS n FROM agent_media");
  detail.agentRunMedia = count("SELECT COUNT(*) AS n FROM agent_run_media");
  detail.inline = count(`SELECT COUNT(*) AS n FROM agent_runs WHERE snapshot_json LIKE '%"base64"%'`);
  if (detail.inline !== 0) problems.push("a run still holds its picture inline");
  // Every picture the runs refer to, by the hash of the bytes kept, is the same multiset as before the move (the harness wrote what it seeded).
  const spec = process.env.MANGA_SMOKE_V12_SPEC ? JSON.parse(fs.readFileSync(process.env.MANGA_SMOKE_V12_SPEC, "utf8")) as { hashes: string[]; shared: string } : null;
  const kept = new Map((store.sqlite.prepare("SELECT hash, bytes FROM agent_media").all() as Array<{ hash: string; bytes: Buffer }>).map((row) => [row.hash, crypto.createHash("sha256").update(Buffer.from(row.bytes)).digest("hex")]));
  const referred = (store.sqlite.prepare("SELECT hash FROM agent_run_media").all() as Array<{ hash: string }>).map((row) => kept.get(row.hash) ?? "missing").sort();
  detail.hashesEqual = Boolean(spec) && JSON.stringify(referred) === JSON.stringify(spec!.hashes);
  if (!detail.hashesEqual) problems.push(`the pictures after the move are not those before it (${referred.length} referred, ${spec?.hashes.length ?? "no"} seeded)`);
  // The pictures of a moved run, in its record in the window.
  const run = await call("agent.getRun", { runId: "run-v12-0003" });
  const images = run.status === "ok" ? ((run.value as { media?: { images?: unknown[] } }).media?.images ?? []) : [];
  detail.runImages = images.length;
  if (images.length !== 1) problems.push("the moved run does not list its picture");
  detail.window = await openTrace(view, "ses-v12", "run-v12-0003") && await waitUntil(view, `document.querySelector('[data-testid="trace-stills"] [data-testid^="trace-image"]')`, 6000);
  if (detail.window !== true) problems.push("the record of a moved run did not show its picture");
  else if (phase === "migrate-v13") await capturePage(view, evidenceDir, "ui-migrated-still.png");
  if (phase === "migrate-v13") {
    // A retry of an old run sends the very bytes it froze before the move (the harness names their hash).
    const seen: string[] = [];
    const server = await startMockProvider({ onRequest: (request) => { seen.push(JSON.stringify(request.body)); } });
    try {
      for (const row of ((await call("connections.list", {})).value as Array<{ id: string }> | undefined) ?? []) await call("connections.delete", { connectionId: row.id });
      const made = await call("connections.upsert", { label: "v13", protocol: "openai-chat-completions", baseUrl: server.url, modelId: "m", purpose: "text", credentialHandle: appService.stashSecret("smoke-v13-key") });
      const connectionId = made.status === "ok" ? (made.value as { id: string }).id : "";
      await call("connections.setProfile", { connectionId, profile: { inputTypes: ["text", "image"] } });
      // A person retries a run that failed: the seeded run (one with the shared picture) is made one, under a grant that exists (the seed's is a
      // placeholder). Its pictures, as the move left them, are not touched.
      // The seed has no budget, and a retry keeps the run's own deadline: it gets the ones of a run that failed a moment ago.
      const budget = { maxSteps: 8, maxDurationMs: 600_000, contextWindow: 32_768, contextTokens: 28_000, maxOutputTokens: 2_048 };
      appService.store.sqlite.prepare("UPDATE agent_runs SET status = 'failed', grant_handle = ?, budget_json = ?, deadline_at = ? WHERE id = 'run-v12-0003'").run(input.grant, JSON.stringify(budget), new Date(Date.now() + 600_000).toISOString());
      appService.store.sqlite.prepare("UPDATE agent_sessions SET grant_handle = ? WHERE id = 'ses-v12'").run(input.grant);
      const retried = await call("agent.retry", { runId: "run-v12-0003" });
      const status = retried.status === "ok" ? await waitRun(call, "run-v12-0003") : `refused: ${JSON.stringify(retried.error ?? null).slice(0, 200)}`;
      const sent = new Set<string>();
      for (const body of seen) for (const match of body.matchAll(/data:image\/[a-z]+;base64,([A-Za-z0-9+/=]+)/g)) sent.add(crypto.createHash("sha256").update(Buffer.from(match[1]!, "base64")).digest("hex"));
      detail.retry = { status, sentHashes: sent.size };
      if (status !== "succeeded" || !spec || sent.size !== 1 || !sent.has(spec.shared)) problems.push(`a retry of an old run did not send the bytes it froze (${status}, ${sent.size} pictures)`);
    } finally {
      await server.close();
    }
  }
  const name = phase === "migrate-v13" ? "migrate-v13" : "migrate-v13-restart";
  return { ok: problems.length === 0, observations: [{ name, status: problems.length === 0 ? "passed" : "failed", detail: { ...detail, problems } }] };
}

/**
 * Where a packaged build keeps things (AT-148, AT-149, 计划 4.9), started by the harness with temporary LOCALAPPDATA, Documents and Downloads:
 * - `locations-seed` is an installation of the version before the split: its root under `<文档>\manga\<channel>` named by MANGA_PROFILE_ROOT, where it
 *   leaves a work with a content folder, a screenshot and a note file (the harness adds a download override to its pointer);
 * - `locations` reports where this start put each partition and whether what the person made still opens, and shows the three groups in settings.
 * The harness checks the folders themselves.
 */
export async function runLocationsSmoke(input: Input & { samples: string | undefined }): Promise<{ ok: boolean; observations: StageObservation[]; locations: Record<string, unknown> }> {
  const { appService, view, evidenceDir, phase } = input;
  const call = caller(appService, input.grant);
  const problems: string[] = [];
  const locations: Record<string, unknown> = { channel: appService.layout.channel, partitions: appService.layout.partitions, overrides: appService.layout.overrides ?? {}, upgrade: appService.layout.upgrade ?? null };
  if (phase === "locations-seed") {
    const manifest = input.samples ? JSON.parse(fs.readFileSync(`${input.samples}/manifest.json`, "utf8")) as { samples: Array<{ id: string; path: string; status: string }> } : null;
    const entry = manifest?.samples.find((item) => item.id === "cbz-basic" && item.status === "generated");
    const libraryDir = process.env.MANGA_SMOKE_LIBRARY_DIR;
    if (!entry || !libraryDir) problems.push("the synthetic comic or the library folder is missing");
    else {
      fs.mkdirSync(libraryDir, { recursive: true });
      const file = `${libraryDir}/旧的漫画.cbz`;
      fs.copyFileSync(`${input.samples}/${entry.path}`, file);
      // A file is imported only from a library path: the folder is added first, without a scan (the import below is the one being checked).
      const added = await call("library.paths.add", { pathHandle: appService.registerPath("directory", libraryDir), mediaKind: "comic", autoScan: false });
      if (added.status !== "ok") problems.push(`the library folder was not added: ${JSON.stringify(added.error ?? null).slice(0, 200)}`);
      const imported = await call("library.importDocument", { title: "旧的漫画", kind: "comic", pathHandle: appService.registerPath("file", file) });
      if (imported.status !== "ok") problems.push(`the comic was not imported: ${JSON.stringify(imported.error ?? null).slice(0, 200)}`);
      const resourceId = imported.status === "ok" ? (imported.value as { resourceId: string }).resourceId : "";
      const png = await view.webContents.capturePage({ x: 0, y: 0, width: 64, height: 48 });
      const shot = await call("screenshot.save", { resourceId, data: png.toPNG().toString("base64"), comic: { pageId: "p001.png", pageLabel: "第 1 页", pageIndex: 0 } });
      if (shot.status !== "ok") problems.push(`the screenshot was not saved: ${JSON.stringify(shot.error ?? null).slice(0, 200)}`);
      else locations.screenshot = appService.screenshots.pathOf((shot.value as { screenshot: { id: string } }).screenshot.id);
      const note = await call("notes.create", { title: "旧的笔记", text: "升级以后还要能打开。", resourceId });
      if (note.status !== "ok") problems.push("the note was not made");
      appService.noteFiles.flush();
      const row = appService.store.sqlite.prepare("SELECT id FROM work_files WHERE kind = 'note'").get() as { id: string } | undefined;
      locations.noteFile = row ? appService.workFolders.pathOf(row.id) : null;
    }
  } else {
    // What the old version made opens from where it is (the harness compares the places with the ones the seed reported).
    const row = appService.store.sqlite.prepare("SELECT id FROM work_files WHERE kind = 'note'").get() as { id: string } | undefined;
    // A file that is not where this start looks for it is reported as missing (the harness compares the places), not a stop of the walk.
    const where = (find: () => string | null): string | null => { try { return find(); } catch { return null; } };
    locations.noteFile = row ? where(() => appService.workFolders.pathOf(row.id)) : null;
    const shots = appService.screenshots.list({}).items;
    locations.screenshot = shots[0] ? where(() => appService.screenshots.pathOf(shots[0]!.id)) : null;
    locations.noteOpens = typeof locations.noteFile === "string" && fs.existsSync(locations.noteFile) && fs.readFileSync(locations.noteFile, "utf8").includes("升级以后还要能打开");
    const settings = await call("settings.get", {});
    locations.legacyLocation = settings.status === "ok" ? (settings.value as { legacyLocation?: unknown }).legacyLocation ?? null : null;
    await toRail(view);
    if (await openSettingsPage(view, "general")) {
      locations.groups = await waitUntil(view, `["app", "files", "downloads"].every((g) => document.querySelector('[data-testid="location-group-' + g + '"]'))`, 4000);
      if (process.env.MANGA_SMOKE_LOCATIONS_SHOT === "1") {
        await view.webContents.executeJavaScript(`document.querySelector('[data-testid="location-group-app"]')?.scrollIntoView({ block: "start" }); true`);
        const pageAt = () => js<string | null>(view, `document.querySelector('[data-testid="page-settings"]')?.getAttribute("data-settings-page") ?? null`);
        const shotPages = [await pageAt()];
        await capturePage(view, evidenceDir, "ui-settings-locations.png");
        shotPages.push(await pageAt());
        locations.shotPages = shotPages;
        if (shotPages.some((page) => page !== "general")) problems.push(`the screenshot of the locations was not of the general page (${shotPages.join(" → ")})`);
      }
      await leaveSettings(view);
    }
    if (locations.groups !== true) problems.push("the settings did not show the three groups of locations");
  }
  return { ok: problems.length === 0, observations: [{ name: phase, status: problems.length === 0 ? "passed" : "failed", detail: { problems } }], locations };
}
