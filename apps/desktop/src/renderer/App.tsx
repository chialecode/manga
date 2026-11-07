import { useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import * as Tabs from "@radix-ui/react-tabs";
import { NORMALIZATION_V1 } from "@manga/contracts/location";
import { DEFAULT_SHELL_PREFERENCE, type NoteBlock, type ShellPreference, type WorkMode } from "@manga/contracts/reading";
import { createTranslator, type Locale } from "@manga/i18n";
import { composerKeyFor, draftKeyFor, manualMaterialsApply, resolveAgentSurface } from "./agent-surface.ts";
import { Input } from "./components/ui/input.tsx";
import { Textarea } from "./components/ui/textarea.tsx";
import { ShellFrame, type ShellSession } from "./shell.tsx";
import { NoteEditor } from "./note-editor.tsx";
import { ReadingPane, type ReadingAsset, type ReadingDocument, type ReadingStyle } from "./reading.tsx";
import { AnimationDemo, AnimationDemoAgent, useAnimationDemo } from "./animation-demo.tsx";

type CommandResult = { status: "ok" | "error"; value?: Record<string, unknown>; error?: { code: string; message: string } };

declare global {
  interface Window {
    manga: {
      command(payload: unknown): Promise<CommandResult>;
      state(): Promise<{ layout: { channel: string; pointerPath: string; partitions: Record<string, string>; writable: boolean; recovery: string }; writable: boolean; vaultAvailable: boolean }>;
      chooseDirectory(): Promise<string | null>;
      chooseFile(): Promise<CommandResult | null>;
      chooseBook(): Promise<CommandResult | null>;
      choosePath(): Promise<string | null>;
      chooseAudio(): Promise<string | null>;
      stashSecret(value: string): Promise<string | null>;
      reveal(id: string): Promise<CommandResult>;
    };
  }
}

const id = () => crypto.randomUUID();

/** Command results cross the IPC boundary, so a list is only trusted after an array check. */
function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

type ConnectionForm = {
  id?: string;
  label: string;
  protocol: string;
  runtime: string;
  baseUrl: string;
  modelId: string;
  purpose: string;
  timeoutMs: string;
  secret: string;
};

type NoteSummary = {
  objectId: string;
  revision: number;
  title: string;
  tags: string[];
  preview: string;
  resourceId: string | null;
  anchorId: string | null;
  sourceStatus?: string;
  updatedAt: string;
};

type SourceCard = { status: string; title?: string; quote?: string; partTitle?: string; available?: boolean; resourceId?: string; resourceRevisionId?: string; partId?: string; reason?: string };

type Bookmark = { id: string; label: string; resourceRevisionId?: string; locator: { kind?: string; partId?: string; range?: { start: number; end: number } }; createdAt?: string };

/** One agent composer per session, so switching sessions never carries another target's draft or scope. */
type ComposerState = { draft: string; materials: string[]; noteMaterials: string[] };

type AgentSelection = { resourceId: string; resourceRevisionId: string; partId?: string; start: number; end: number; quote: string };

const emptyForm = (): ConnectionForm => ({
  label: "本地",
  protocol: "openai-chat-completions",
  runtime: "native",
  baseUrl: "http://127.0.0.1:0",
  modelId: "local-test",
  purpose: "text",
  timeoutMs: "60000",
  secret: "",
});

export function App() {
  const [locale] = useState<Locale>("zh-CN");
  const i18n = useMemo(() => createTranslator(locale), [locale]);
  const [host, setHost] = useState<Awaited<ReturnType<Window["manga"]["state"]>> | null>(null);
  const [workspace, setWorkspace] = useState<Record<string, unknown> | null>(null);
  const [page, setPage] = useState("agent");
  const animation = useAnimationDemo(page === "animation");
  const [sessionId, setSessionId] = useState<string>();
  const [run, setRun] = useState<Record<string, unknown> | null>(null);
  const [composers, setComposers] = useState<Record<string, ComposerState>>({});
  const [composing, setComposing] = useState(false);
  const [error, setError] = useState<string>();
  const [inventory, setInventory] = useState<Record<string, unknown> | null>(null);
  const [settings, setSettings] = useState<Record<string, unknown> | null>(null);
  const [migration, setMigration] = useState<{ handle: string; checkpointId: string; copies: Array<{ partition: string; bytes: number; target: string }> } | null>(null);
  const [notice, setNotice] = useState<string>();
  const [viewport, setViewport] = useState({ width: window.innerWidth || 1280, height: window.innerHeight || 840 });
  const [libraryList, setLibraryList] = useState<{ items: Array<{ id: string; title: string }>; total: number; nextCursor: string | null; query: string } | null>(null);
  const libraryRequest = useRef(0);
  const [reading, setReading] = useState<ReadingDocument | null>(null);
  const [hits, setHits] = useState<Array<{ text: string; fragmentId?: string; locator?: { partId: string; range: { start: number; end: number } } }>>([]);
  const [searched, setSearched] = useState(false);
  const [noteId, setNoteId] = useState<string>();
  const [noteDoc, setNoteDoc] = useState<{ objectId: string; revision: number; title: string; tags: string[]; blocks: NoteBlock[]; sourceStatus?: string; resourceId?: string | null } | null>(null);
  const [noteList, setNoteList] = useState<NoteSummary[]>([]);
  const [noteQuery, setNoteQuery] = useState("");
  const [noteTag, setNoteTag] = useState("");
  const [noteStatus, setNoteStatus] = useState<"idle" | "loading" | "error">("idle");
  const [noteHistory, setNoteHistory] = useState<Array<{ revision: number; createdAt: string; blockCount: number; preview: string }>>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [sessions, setSessions] = useState<ShellSession[]>([]);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [pendingMode, setPendingMode] = useState<WorkMode | null>(null);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [assetUrls, setAssetUrls] = useState<Record<string, string>>({});
  const [highlight, setHighlight] = useState<{ start: number; end: number } | null>(null);
  const [originalBytes, setOriginalBytes] = useState<Uint8Array | null>(null);
  const [sourceCard, setSourceCard] = useState<SourceCard | null>(null);
  const [returnTo, setReturnTo] = useState<{ objectId: string; blockId: string | null } | null>(null);
  const [packagePreview, setPackagePreview] = useState<{ counts: Record<string, number>; empty: boolean; conflicts: Array<{ kind: string; id: string; label: string; reason: string }>; missingAttachments: string[]; defaultStrategy: string } | null>(null);
  const [packageHandle, setPackageHandle] = useState<string>();
  const [packageStrategy, setPackageStrategy] = useState<"skip" | "replace" | "duplicate">("duplicate");
  const [packageDecisions, setPackageDecisions] = useState<Record<string, "skip" | "replace" | "duplicate">>({});
  const [agentSelection, setAgentSelection] = useState<AgentSelection | null>(null);
  const [noteEpoch, setNoteEpoch] = useState(0);
  const [renaming, setRenaming] = useState(false);
  const [focusBlock, setFocusBlock] = useState<string | null>(null);
  const noteRequest = useRef(0);
  const viewRequest = useRef(0);
  const readingRef = useRef<ReadingDocument | null>(null);
  const assetUrlsRef = useRef<Record<string, string>>({});
  const shellMode = ((workspace?.shell as ShellPreference | undefined) ?? DEFAULT_SHELL_PREFERENCE).mode;
  // A mode click updates the draft and the rail before the settings round trip returns.
  const mode = pendingMode ?? shellMode;
  const surface = resolveAgentSurface({
    page,
    sessionId,
    mode,
    sessions,
    reading: reading ? { resourceId: reading.resourceId, revisionId: reading.revisionId, title: reading.title } : null,
    note: noteDoc ? { objectId: noteDoc.objectId, revision: noteDoc.revision, title: noteDoc.title, resourceId: noteDoc.resourceId } : null,
    selection: agentSelection,
  });
  const boundSessionKey = composerKeyFor(surface, sessions, sessionId, sessionsLoaded);
  // Drafts stay with the mode and target, so a switch cannot display or send the other mode's text.
  const activeComposerKey = draftKeyFor(surface, sessions, boundSessionKey);
  const composer = composers[activeComposerKey] ?? { draft: "", materials: [], noteMaterials: [] };
  const patchComposer = (patch: Partial<ComposerState>) => setComposers((current) => {
    const key = activeComposerKey;
    const existing = current[key] ?? { draft: "", materials: [], noteMaterials: [] };
    return { ...current, [key]: { ...existing, ...patch } };
  });
  const visibleRun = run && boundSessionKey && String(run.sessionId ?? "") === boundSessionKey ? run : null;
  // The rail follows the mode the user is looking at, including the moment before the session query returns.
  const modeSessions = sessions.filter((item) => (item.mode ?? "enthusiast") === mode);

  async function refresh(nextSession?: string, modeHint?: WorkMode) {
    const state = await window.manga.state();
    setHost(state);
    const ws = await window.manga.command({ commandId: "workspace.get", idempotencyKey: id(), input: {} });
    const loadedMode = modeHint
      ?? (ws.status === "ok" ? ((ws.value?.shell as ShellPreference | undefined)?.mode) : undefined)
      ?? mode;
    if (ws.status === "ok") setWorkspace(ws.value ?? {});
    const sessionList = await window.manga.command({ commandId: "workspace.sessions", idempotencyKey: id(), input: { mode: loadedMode } });
    const rows = sessionList.status === "ok" ? asArray<ShellSession>(sessionList.value) : [];
    if (sessionList.status === "ok") {
      setSessions(rows);
      setSessionsLoaded(true);
    }
    const runs = ws.status === "ok" ? ((ws.value?.runs as Array<{ id: string; sessionId: string; status: string }> | undefined) ?? []) : [];
    // The visible session has to be one of this mode's rows. Another mode's id is not a fallback.
    const sid = [nextSession, sessionId].find((candidate) => candidate && rows.some((row) => row.sessionId === candidate)) ?? rows[0]?.sessionId;
    if (sid !== sessionId) setSessionId(sid);
    if (sid) {
      const sessionRuns = runs.filter((entry) => entry.sessionId === sid);
      const active = sessionRuns.find((entry) => ["queued", "running", "waiting_input", "interrupted"].includes(entry.status)) ?? sessionRuns[0];
      if (active) {
        const runResult = await window.manga.command({ commandId: "agent.getRun", idempotencyKey: id(), input: { runId: active.id } });
        if (runResult.status === "ok") setRun(runResult.value ?? {});
        else setRun(null);
      } else setRun(null);
    } else setRun(null);
    const inv = await window.manga.command({ commandId: "inventory.overview", idempotencyKey: id(), input: {} });
    if (inv.status === "ok") setInventory(inv.value ?? {});
    const st = await window.manga.command({ commandId: "settings.get", idempotencyKey: id(), input: {} });
    if (st.status === "ok") setSettings(st.value ?? {});
    await refreshNotes();
  }

  async function changeMode(next: WorkMode) {
    if (next === mode) return;
    setPendingMode(next);
    setRun(null);
    const result = await window.manga.command({ commandId: "settings.setShell", idempotencyKey: id(), input: { mode: next } });
    if (result.status === "error") {
      // The switch did not stick, so the previous mode's draft and run stay where they were.
      setPendingMode(null);
      setError(result.error?.message);
      return;
    }
    setError(undefined);
    await refresh(undefined, next);
    setPendingMode(null);
  }

  /** Extend the reading page's library view with the next older page from the whole library. */
  async function loadMoreResources() {
    const cursor = libraryList?.nextCursor;
    if (!cursor) return;
    const query = libraryList.query;
    const request = libraryRequest.current;
    const result = await window.manga.command({ commandId: "library.list", idempotencyKey: id(), input: { cursor, limit: 100, ...(query ? { query } : {}) } });
    if (request !== libraryRequest.current) return;
    if (result.status === "error") { setError(result.error?.message); return; }
    const value = result.value as { items: Array<{ id: string; title: string }>; total: number; nextCursor: string | null };
    setLibraryList((current) => {
      if (!current || current.query !== query || current.nextCursor !== cursor) return current;
      const known = new Set(current.items.map((item) => item.id));
      return { items: [...current.items, ...value.items.filter((item) => !known.has(item.id))], total: value.total, nextCursor: value.nextCursor, query };
    });
  }

  /** Search every title in the library; an empty query returns the unfiltered first page. */
  async function searchResources(query: string) {
    query = query.trim();
    const request = ++libraryRequest.current;
    const result = await window.manga.command({ commandId: "library.list", idempotencyKey: id(), input: { ...(query ? { query } : {}), limit: 100 } });
    if (request !== libraryRequest.current) return;
    if (result.status === "error") { setError(result.error?.message); return; }
    setLibraryList({ ...(result.value as { items: Array<{ id: string; title: string }>; total: number; nextCursor: string | null }), query });
  }

  async function refreshNotes() {    setNoteStatus("loading");
    const result = await window.manga.command({
      commandId: "notes.list",
      idempotencyKey: id(),
      input: { ...(noteQuery ? { text: noteQuery } : {}), ...(noteTag ? { tag: noteTag } : {}) },
    });
    if (result.status === "ok") {
      setNoteList(asArray<NoteSummary>(result.value));
      setNoteStatus("idle");
      return;
    }
    // A failed list must say so instead of showing an empty list as if there were no notes.
    setNoteStatus("error");
    setError(result.error?.message);
  }

  useEffect(() => {
    void refresh().catch((item) => setError(String(item)));
    // The initial load runs once; later refreshes are explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onResize = () => setViewport({ width: window.innerWidth || 1280, height: window.innerHeight || 840 });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Opening a book or saving preferences refreshes workspace too. Preserve paging/search when
  // its library snapshot is unchanged; a changed snapshot seeds a fresh, visibly unfiltered page.
  const librarySeed = JSON.stringify([workspace?.resources, workspace?.resourcePage]);
  useEffect(() => {
    libraryRequest.current += 1;
    const firstPage = (workspace?.resources as Array<{ id: string; title: string }> | undefined) ?? [];
    const page = workspace?.resourcePage as { total?: number; nextCursor?: string | null } | undefined;
    setLibraryList({ items: firstPage, total: page?.total ?? firstPage.length, nextCursor: page?.nextCursor ?? null, query: "" });
  }, [librarySeed]);

  useEffect(() => {
    const runId = String(run?.runId ?? run?.id ?? "");
    const status = String(run?.status ?? "");
    if (!runId || !["queued", "running", "waiting_input"].includes(status)) return;
    let cancelled = false;
    const tick = async () => {
      const result = await window.manga.command({ commandId: "agent.getRun", idempotencyKey: id(), input: { runId } });
      if (cancelled) return;
      if (result.status === "ok") setRun(result.value ?? {});
    };
    const timer = window.setInterval(() => { void tick(); }, 400);
    void tick();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [run?.runId, run?.id, run?.status]);

  async function ensureSession(): Promise<string | undefined> {
    const current = sessions.find((item) => item.sessionId === sessionId && (!item.mode || item.mode === mode));
    if (current) return current.sessionId;
    const created = await window.manga.command({ commandId: "agent.createSession", idempotencyKey: id(), input: { title: i18n.t("agent.session", { id: "1" }), mode } });
    if (created.status === "error") { setError(created.error?.message); return undefined; }
    const next = String(created.value?.id ?? "");
    if (!next) return undefined;
    setSessionId(next);
    return next;
  }

  function publishReading(next: ReadingDocument | null) {
    readingRef.current = next;
    setReading(next);
  }

  /** Open (or reuse) the session that belongs to the current reading target so tasks never cross targets. */
  async function ensureBoundSession(kind: "resource" | "project" | "note", targetId: string, request?: number): Promise<string | undefined> {
    const boundMode = mode;
    const result = await window.manga.command({ commandId: "session.open", idempotencyKey: id(), input: { kind, targetId, mode: boundMode } });
    if (request !== undefined && request !== viewRequest.current) return undefined;
    if (result.status === "error") { setError(result.error?.message); return undefined; }
    const opened = String((result.value as { id?: string })?.id ?? "");
    if (!opened) return undefined;
    setSessionId(opened);
    const list = await window.manga.command({ commandId: "workspace.sessions", idempotencyKey: id(), input: { mode: boundMode } });
    if (list.status === "ok") {
      setSessions(asArray<ShellSession>(list.value));
      setSessionsLoaded(true);
    }
    return opened;
  }

  async function send() {
    if (composing || !composer.draft.trim()) return;
    // Stay on the page's target. A note left open from another book, or a session the user switched away from, is not sent.
    const sid = surface.open
      ? await ensureBoundSession(surface.open.kind, surface.open.targetId)
      : surface.sessionId && (!sessionsLoaded || sessions.some((item) => item.sessionId === surface.sessionId && (!item.mode || item.mode === mode)))
        ? surface.sessionId
        : await ensureSession();
    if (!sid) return;
    const knownSessions = surface.open
      ? [...sessions, { sessionId: sid, kind: surface.open.kind, targetId: surface.open.targetId, title: surface.label ?? "", mode }]
      : sessions;
    const includeManual = manualMaterialsApply({ ...surface, mode }, knownSessions, sid);
    const readResourceIds = [...new Set([...(includeManual ? composer.materials : []), ...(surface.resourceId ? [surface.resourceId] : [])])];
    const noteObjectIds = [...new Set([...(includeManual ? composer.noteMaterials : []), ...(surface.noteObjectId ? [surface.noteObjectId] : [])])];
    const result = await window.manga.command({
      commandId: "agent.send",
      idempotencyKey: id(),
      input: {
        sessionId: sid,
        text: composer.draft,
        readResourceIds,
        noteObjectIds,
        ...(surface.selection ? { selection: { resourceId: surface.selection.resourceId, resourceRevisionId: surface.selection.resourceRevisionId, partId: surface.selection.partId, start: surface.selection.start, end: surface.selection.end } } : {}),
      },
    });
    if (result.status === "error") setError(result.error?.message);
    else {
      setRun(result.value ?? {});
      patchComposer({ draft: "" });
      setError(undefined);
    }
    await refresh(sid);
  }

  async function retry() {
    const runId = String(visibleRun?.runId ?? "");
    if (!runId) return;
    const result = await window.manga.command({ commandId: "agent.retry", idempotencyKey: id(), input: { runId } });
    if (result.status === "error") setError(result.error?.message);
    else setRun(result.value ?? {});
    await refresh();
  }

  async function stop() {
    const runId = String(visibleRun?.runId ?? "");
    if (!runId) return;
    await window.manga.command({ commandId: "agent.cancel", idempotencyKey: id(), input: { runId } });
    const latest = await window.manga.command({ commandId: "agent.getRun", idempotencyKey: id(), input: { runId } });
    if (latest.status === "ok") setRun(latest.value ?? {});
  }

  async function chooseLocation() {
    const handle = await window.manga.chooseDirectory();
    if (!handle) return;
    const proposed = await window.manga.command({ commandId: "settings.proposeLocations", idempotencyKey: id(), input: { pathHandle: handle } });
    if (proposed.status === "error") {
      setError(proposed.error?.message);
      return;
    }
    const copies = (proposed.value?.copies as Array<{ partition: string; bytes: number; target: string }> | undefined) ?? [];
    setError(undefined);
    setMigration({ handle, checkpointId: String(proposed.value?.checkpointId ?? ""), copies });
  }

  async function applyMigration() {
    if (!migration) return;
    const applied = await window.manga.command({
      commandId: "settings.applyLocations",
      idempotencyKey: id(),
      input: { checkpointId: migration.checkpointId, pathHandle: migration.handle },
    });
    if (applied.status === "error") setError(applied.error?.message);
    else {
      setError(undefined);
      setNotice(i18n.t("settings.migrationDone"));
    }
    setMigration(null);
    await refresh();
  }

  async function rollbackRecovery() {
    const result = await window.manga.command({ commandId: "settings.recoverJobs", idempotencyKey: id(), input: { action: "rollback" } });
    if (result.status === "error") setError(result.error?.message);
    await refresh();
  }

  async function saveConnection(fields: ConnectionForm) {
    const credentialHandle = fields.secret ? await window.manga.stashSecret(fields.secret) : undefined;
    const result = await window.manga.command({
      commandId: "connections.upsert",
      idempotencyKey: id(),
      input: {
        id: fields.id,
        label: fields.label,
        protocol: fields.protocol,
        runtime: fields.runtime,
        baseUrl: fields.baseUrl,
        modelId: fields.modelId,
        purpose: fields.purpose,
        timeoutMs: Number(fields.timeoutMs) || 60_000,
        credentialHandle,
      },
    });
    if (result.status === "error") {
      setError(result.error?.message);
      return;
    }
    setError(undefined);
    setNotice(i18n.t("settings.connectionSaved"));
    await refresh();
  }

  async function openResource(resourceId: string) {
    const request = ++viewRequest.current;
    const result = await window.manga.command({ commandId: "library.read", idempotencyKey: id(), input: { resourceId } });
    if (request !== viewRequest.current) return;
    if (result.status === "error") { setError(result.error?.message); return; }
    const document = (result.value ?? null) as ReadingDocument | null;
    publishReading(document);
    setHighlight(null);
    setOriginalBytes(null);
    setSourceCard(null);
    setReturnTo(null);
    // Search results belong to the book that produced them.
    setHits([]);
    setSearched(false);
    setAgentSelection(null);
    await loadBookmarks(resourceId);
    if (request !== viewRequest.current) return;
    if (document) await loadAssets(document, request);
    if (request !== viewRequest.current) return;
    if (document?.format === "pdf") await loadOriginal(document.resourceId, document.revisionId, request);
    if (request !== viewRequest.current) return;
    if (document?.resourceId) await ensureBoundSession("resource", document.resourceId, request);
  }

  async function loadAssets(document: ReadingDocument, request: number) {
    const ids = new Set<string>();
    for (const asset of document.assets ?? []) ids.add(asset.id);
    for (const asset of document.slice?.images ?? []) ids.add(asset.id);
    const urls: Record<string, string> = {};
    for (const assetId of ids) {
      const result = await window.manga.command({ commandId: "notes.asset", idempotencyKey: id(), input: { resourceRevisionId: document.revisionId, assetId } });
      if (request !== viewRequest.current) break;
      if (result.status !== "ok") continue;
      const value = result.value as { mediaType?: string; bytes?: number[] } | undefined;
      const bytes = Uint8Array.from(value?.bytes ?? []);
      if (!bytes.length) continue;
      const blob = new Blob([bytes], { type: value?.mediaType ?? "application/octet-stream" });
      urls[assetId] = URL.createObjectURL(blob);
    }
    if (request !== viewRequest.current) {
      for (const url of Object.values(urls)) URL.revokeObjectURL(url);
      return;
    }
    // Replacing the asset set releases the previous object URLs so an inactive book holds no media.
    for (const [assetId, url] of Object.entries(assetUrlsRef.current)) {
      if (!urls[assetId]) URL.revokeObjectURL(url);
    }
    assetUrlsRef.current = { ...assetUrlsRef.current, ...urls };
    setAssetUrls(assetUrlsRef.current);
  }

  async function loadOriginal(resourceId: string, revisionId: string | undefined, request: number) {
    const result = await window.manga.command({ commandId: "library.readOriginal", idempotencyKey: id(), input: { resourceId, revisionId } });
    if (request !== viewRequest.current) return;
    const current = readingRef.current;
    if (!current || current.resourceId !== resourceId || (revisionId !== undefined && current.revisionId !== revisionId)) return;
    if (result.status !== "ok") {
      setOriginalBytes(null);
      return;
    }
    const value = result.value as { available?: boolean; bytes?: Uint8Array | number[] } | undefined;
    if (!value?.available || !value.bytes) {
      setOriginalBytes(null);
      return;
    }
    setOriginalBytes(value.bytes instanceof Uint8Array ? value.bytes : Uint8Array.from(value.bytes));
  }

  async function loadBookmarks(resourceId: string) {
    const result = await window.manga.command({ commandId: "reading.bookmarks", idempotencyKey: id(), input: { resourceId } });
    setBookmarks(result.status === "ok" ? asArray<Bookmark>(result.value) : []);
  }

  async function openSlice(partId: string, start: number, options: { highlight?: { start: number; end: number } | null; revisionId?: string } = {}) {
    const request = viewRequest.current;
    const current = readingRef.current;
    if (!current) return;
    const revisionId = options.revisionId ?? current.revisionId;
    const pdf = current.format === "pdf";
    const sliceStart = pdf ? 0 : start;
    const result = await window.manga.command({ commandId: "library.readSlice", idempotencyKey: id(), input: { resourceId: current.resourceId, revisionId, partId, start: sliceStart, limit: pdf ? 8000 : 4000 } });
    if (request !== viewRequest.current || readingRef.current?.resourceId !== current.resourceId) return;
    if (result.status === "error") { setError(result.error?.message); return; }
    const value = result.value as { text?: string; start?: number; end?: number; kind?: string; textLayer?: boolean; images?: ReadingAsset[]; placements?: Array<{ assetId: string; offset: number; width?: number; height?: number }>; render?: ReadingDocument["slice"] extends null ? never : NonNullable<ReadingDocument["slice"]>["render"] } | undefined;
    const next: ReadingDocument = {
      ...current,
      slice: {
        partId,
        text: String(value?.text ?? ""),
        start: Number(value?.start ?? sliceStart),
        end: Number(value?.end ?? sliceStart),
        kind: String(value?.kind ?? "text"),
        textLayer: value?.textLayer !== false,
        images: value?.images ?? [],
        placements: value?.placements ?? [],
        ...(current.format !== "pdf" && value?.render ? { render: value.render } : {}),
      },
    };
    publishReading(next);
    setHighlight(options.highlight ?? null);
    // A chapter/page jump is a reading position change even before the reader explicitly marks it read.
    // Save only the position; navigation alone must not expand the Agent's consumed-content scope.
    // Bookmark/search highlights are temporary lookups and retain the saved reading position.
    if (!options.highlight) {
      const progress = await window.manga.command({
        commandId: "progress.set", idempotencyKey: id(), input: {
          resourceId: next.resourceId,
          resourceRevisionId: revisionId,
          consumed: false,
          locator: {
            kind: "text", partId, representationId: revisionId, normalizationVersion: NORMALIZATION_V1,
            range: { start: next.slice!.start, end: next.slice!.end },
          },
        },
      });
      if (request !== viewRequest.current) return;
      if (progress.status === "error") setError(progress.error?.message);
    }
    if (request !== viewRequest.current) return;
    await loadAssets(next, request);
  }

  async function markProgress() {
    if (!reading?.slice) return;
    const exact = reading.slice.text.slice(0, 32);
    const result = await window.manga.command({
      commandId: "progress.set",
      idempotencyKey: id(),
      input: {
        resourceId: reading.resourceId,
        resourceRevisionId: reading.revisionId,
        consumed: true,
        locator: {
          kind: "text",
          partId: reading.slice.partId,
          representationId: reading.revisionId,
          normalizationVersion: NORMALIZATION_V1,
          range: { start: reading.slice.start, end: Math.max(reading.slice.end, reading.slice.start) },
          quote: { exact },
        },
      },
    });
    if (result.status === "error") { setError(result.error?.message); return; }
    setNotice(i18n.t("reading.progress"));
    await openResource(reading.resourceId);
  }

  async function noteSelection(quote: string, start: number, end: number, partId: string) {
    if (!reading) return;
    const result = await window.manga.command({
      commandId: "notes.create",
      idempotencyKey: id(),
      input: {
        title: reading.title,
        text: quote,
        resourceId: reading.resourceId,
        resourceRevisionId: reading.revisionId,
        locator: {
          kind: "text",
          partId,
          representationId: reading.revisionId,
          normalizationVersion: NORMALIZATION_V1,
          range: { start, end: Math.max(end, start) },
          quote: { exact: quote },
        },
      },
    });
    if (result.status === "error") { setError(result.error?.message); return; }
    const objectId = String(result.value?.objectId ?? "");
    if (objectId) await openNote(objectId);
    setPage("notes");
    await refresh();
  }

  async function createStandaloneNote() {
    const title = i18n.t("notes.newTitle");
    const result = await window.manga.command({ commandId: "notes.create", idempotencyKey: id(), input: { title, text: "" } });
    if (result.status === "error") { setError(result.error?.message); return; }
    const objectId = String(result.value?.objectId ?? "");
    if (objectId) await openNote(objectId);
    await refreshNotes();
  }

  async function openNote(objectId: string, focusBlockId?: string) {
    const request = ++noteRequest.current;
    const result = await window.manga.command({ commandId: "notes.get", idempotencyKey: id(), input: { objectId } });
    if (request !== noteRequest.current) return;
    if (result.status === "error") { setError(result.error?.message); return; }
    const value = result.value as { revision?: number; title?: string; tags?: string[]; document?: { blocks?: NoteBlock[] }; sourceStatus?: string; sources?: Array<{ resourceId?: string }> } | undefined;
    setNoteId(objectId);
    setNoteDoc({
      objectId,
      revision: Number(value?.revision ?? 1),
      title: String(value?.title ?? ""),
      tags: value?.tags ?? [],
      blocks: value?.document?.blocks ?? [],
      sourceStatus: value?.sourceStatus,
      resourceId: value?.sources?.[0]?.resourceId ?? null,
    });
    setFocusBlock(focusBlockId ?? null);
    setShowHistory(false);
    setRenaming(false);
    // A bound session keeps the note's own context, so the Agent does not inherit the reading target.
    await ensureBoundSession("note", objectId);
  }

  async function openNoteSource(objectId: string, blockId?: string) {
    const request = ++viewRequest.current;
    const result = await window.manga.command({ commandId: "notes.openSource", idempotencyKey: id(), input: { objectId, blockId } });
    if (request !== viewRequest.current) return;
    if (result.status === "error") { setError(result.error?.message); return; }
    const value = result.value as {
      status?: string;
      resourceId?: string;
      resourceRevisionId?: string;
      partId?: string;
      card?: SourceCard;
      returnTo?: { objectId: string; blockId: string | null };
      codePointRange?: { start: number; end: number };
    } | undefined;
    setReturnTo(value?.returnTo ?? { objectId, blockId: blockId ?? null });
    const card = value?.card ?? { status: value?.status ?? "unresolved" };
    setHighlight(null);
    if (value?.resourceId) {
      await ensureBoundSession("resource", value.resourceId, request);
      if (request !== viewRequest.current) return;
      const read = await window.manga.command({ commandId: "library.read", idempotencyKey: id(), input: { resourceId: value.resourceId, revisionId: value.resourceRevisionId } });
      if (request !== viewRequest.current) return;
      if (read.status === "error") {
        // A source whose resource is gone must say so instead of leaving the previous book on screen.
        setError(read.error?.message);
      } else {
        const document = (read.value ?? null) as ReadingDocument | null;
        publishReading(document);
        setOriginalBytes(null);
        await loadBookmarks(value.resourceId);
        if (request !== viewRequest.current) return;
        if (document) await loadAssets(document, request);
        if (request !== viewRequest.current) return;
        if (document?.format === "pdf") await loadOriginal(document.resourceId, value.resourceRevisionId ?? document.revisionId, request);
        if (request !== viewRequest.current) return;
        const partId = value.partId ?? document?.slice?.partId;
        // readSlice and highlights use normalized code points, never UTF-16 DOM offsets.
        // An ambiguous quote must stay unresolved instead of silently choosing the first candidate.
        const range = value.status === "resolved" ? value.codePointRange : undefined;
        if (partId && range) {
          // Show the exact stored range, without widening the consumed read range.
          const pdf = document?.format === "pdf";
          const sliceStart = pdf ? 0 : Math.max(0, range.start - 200);
          const sliceResult = await window.manga.command({ commandId: "library.readSlice", idempotencyKey: id(), input: { resourceId: value.resourceId, revisionId: value.resourceRevisionId, partId, start: sliceStart, limit: pdf ? 8000 : Math.max(600, range.end - range.start + 400) } });
          if (request !== viewRequest.current) return;
          if (sliceResult.status === "ok") {
            const slice = sliceResult.value as { text?: string; start?: number; end?: number; kind?: string; textLayer?: boolean; images?: ReadingAsset[]; placements?: Array<{ assetId: string; offset: number }>; render?: NonNullable<ReadingDocument["slice"]>["render"] } | undefined;
            const next: ReadingDocument = {
              ...(document as ReadingDocument),
              slice: {
                partId,
                text: String(slice?.text ?? ""),
                start: Number(slice?.start ?? 0),
                end: Number(slice?.end ?? 0),
                kind: String(slice?.kind ?? "text"),
                textLayer: slice?.textLayer !== false,
                images: slice?.images ?? [],
                placements: slice?.placements ?? [],
                ...(document?.format !== "pdf" && slice?.render ? { render: slice.render } : {}),
              },
            };
            publishReading(next);
            await loadAssets(next, request);
            if (request !== viewRequest.current) return;
          }
          setHighlight({ start: range.start, end: range.end });
        }
      }
    }
    if (request !== viewRequest.current) return;
    // A jump that cannot be placed must not keep an unrelated card on screen.
    setSourceCard(card);
    setPage("reading");
  }

  async function backToNote() {
    if (returnTo?.objectId) await openNote(returnTo.objectId, returnTo.blockId ?? undefined);
    setSourceCard(null);
    setReturnTo(null);
    setPage("notes");
  }

  /** Re-point a stale note source at the file the user picks, using the existing resource identity. */
  async function repairNoteSource() {
    const resourceId = sourceCard?.resourceId ?? reading?.resourceId;
    if (!resourceId) { setError(i18n.t("reading.sourceRepairFailed")); return; }
    const handle = await window.manga.choosePath();
    if (!handle) return;
    const result = await window.manga.command({ commandId: "library.repairSource", idempotencyKey: id(), input: { resourceId, pathHandle: handle } });
    if (result.status === "error") { setError(result.error?.message); return; }
    // A quote that has no single home in the new file stays unrepaired, and the user is told how many.
    const kept = Number((result.value as { pointersKept?: number } | undefined)?.pointersKept ?? 0);
    setNotice(kept > 0 ? i18n.t("reading.sourceRepairKept", { count: kept }) : i18n.t("reading.sourceRepairDone"));
    setError(undefined);
    await openResource(resourceId);
    if (returnTo?.objectId) {
      await openNoteSource(returnTo.objectId, returnTo.blockId ?? undefined);
    }
    await refresh();
  }

  async function addBookmark() {
    if (!reading?.slice) return;
    const start = reading.slice.start;
    // A bookmark keeps a readable anchor, not the whole window, so the jump can always show it.
    const end = Math.min(reading.slice.end, start + 120);
    const result = await window.manga.command({
      commandId: "reading.setBookmark",
      idempotencyKey: id(),
      input: {
        resourceId: reading.resourceId,
        resourceRevisionId: reading.revisionId,
        label: `${reading.slice.partId} · ${[...reading.slice.text].slice(0, 20).join("")}`,
        locator: {
          kind: "text",
          partId: reading.slice.partId,
          representationId: reading.revisionId,
          normalizationVersion: NORMALIZATION_V1,
          range: { start, end: Math.max(end, start) },
          quote: { exact: reading.slice.text.slice(0, 32) },
        },
      },
    });
    if (result.status === "error") { setError(result.error?.message); return; }
    await loadBookmarks(reading.resourceId);
  }

  async function removeBookmark(bookmarkId: string) {
    const result = await window.manga.command({ commandId: "reading.removeBookmark", idempotencyKey: id(), input: { bookmarkId } });
    if (result.status === "error") { setError(result.error?.message); return; }
    if (reading) await loadBookmarks(reading.resourceId);
  }

  async function openBookmark(bookmark: Bookmark) {
    // Opening a bookmark restores the position but does not mark the range read.
    const partId = bookmark.locator.partId;
    if (!partId) return;
    await openSlice(partId, Math.max(0, (bookmark.locator.range?.start ?? 0) - 100), { highlight: bookmark.locator.range ?? null, revisionId: bookmark.resourceRevisionId });
  }

  async function saveStyle(patch: Partial<ReadingStyle>) {
    const result = await window.manga.command({ commandId: "settings.setShell", idempotencyKey: id(), input: { reading: patch } });
    if (result.status === "error") { setError(result.error?.message); return; }
    await refresh();
  }

  /** Write the whole library, reading state included, so the round trip can be checked from the UI. */
  async function exportPackage() {
    const handle = await window.manga.chooseDirectory();
    if (!handle) return;
    const result = await window.manga.command({ commandId: "library.exportPackage", idempotencyKey: id(), input: { pathHandle: handle } });
    if (result.status === "error") { setError(result.error?.message); return; }
    setNotice(i18n.t("settings.packageExported"));
    await refresh();
  }

  async function previewPackage() {    const handle = await window.manga.chooseDirectory();
    if (!handle) return;
    const result = await window.manga.command({ commandId: "package.preview", idempotencyKey: id(), input: { pathHandle: handle } });
    if (result.status === "error") { setError(result.error?.message); return; }
    const value = result.value as unknown as { counts: Record<string, number>; empty: boolean; conflicts: Array<{ kind: string; id: string; label: string; reason: string }>; missingAttachments: string[]; defaultStrategy: "skip" | "replace" | "duplicate" } | undefined;
    setPackageHandle(handle);
    setPackageStrategy(value?.defaultStrategy ?? "duplicate");
    setPackageDecisions({});
    setPackagePreview(value ?? null);
  }

  async function applyPackageImport() {
    if (!packageHandle) return;
    const decisions = Object.entries(packageDecisions).map(([key, action]) => {
      const separator = key.indexOf(":");
      return { kind: key.slice(0, separator), id: key.slice(separator + 1), action };
    });
    const result = await window.manga.command({
      commandId: "package.importResolved",
      idempotencyKey: id(),
      input: { pathHandle: packageHandle, strategy: packageStrategy, ...(decisions.length ? { decisions } : {}) },
    });
    if (result.status === "error") { setError(result.error?.message); return; }
    setNotice(i18n.t("settings.packageImported"));
    setPackagePreview(null);
    setPackageHandle(undefined);
    setPackageDecisions({});
    await refresh();
  }

  async function saveNote(blocks: NoteBlock[], expectedRevision: number, title: string, tags: string[]): Promise<number | void> {
    if (!noteDoc) return;
    const result = await window.manga.command({
      commandId: "notes.replace",
      idempotencyKey: id(),
      input: { objectId: noteDoc.objectId, expectedRevision, blocks, title, tags },
    });
    if (result.status === "error") throw new Error(result.error?.message ?? "save failed");
    const revision = Number(result.value?.revision ?? expectedRevision + 1);
    setNoteDoc((current) => current?.objectId === noteDoc.objectId ? { ...current, revision, blocks, title, tags } : current);
    return revision;
  }

  async function renameNote(title: string, tags: string[]) {
    if (!noteDoc) return;
    const parsedTags = tags.map((tag) => tag.trim()).filter(Boolean);
    const result = await window.manga.command({
      commandId: "notes.rename",
      idempotencyKey: id(),
      input: { objectId: noteDoc.objectId, expectedRevision: noteDoc.revision, title, tags: parsedTags },
    });
    if (result.status === "error") { setError(result.error?.message); return; }
    setNoteDoc({ ...noteDoc, revision: Number(result.value?.revision ?? noteDoc.revision + 1), title, tags: parsedTags });
    setRenaming(false);
    setNotice(i18n.t("notes.titleSaved"));
    await refreshNotes();
  }

  async function loadHistory() {
    if (!noteDoc) return;
    const result = await window.manga.command({ commandId: "notes.history", idempotencyKey: id(), input: { objectId: noteDoc.objectId } });
    if (result.status !== "ok") { setError(result.error?.message); return; }
    setNoteHistory(asArray<{ revision: number; createdAt: string; blockCount: number; preview: string }>(result.value));
    setShowHistory(true);
  }

  async function restoreRevision(revision: number) {
    if (!noteDoc) return;
    const result = await window.manga.command({ commandId: "notes.restore", idempotencyKey: id(), input: { objectId: noteDoc.objectId, expectedRevision: noteDoc.revision, revision } });
    if (result.status === "error") { setError(result.error?.message); return; }
    // The editor is rebuilt from the restored revision, otherwise its stale buffer would overwrite it.
    setNoteEpoch((current) => current + 1);
    await openNote(noteDoc.objectId);
  }

  function openSession(session: ShellSession) {
    setSessionId(session.sessionId);
    // The run panel follows the session, so a switch never shows another target's task.
    setRun(null);
    if (session.kind === "note" && session.targetId) {
      void openNote(session.targetId);
      setPage("notes");
      return;
    }
    if (session.targetId && session.kind === "resource") {
      void openResource(session.targetId);
      setPage("reading");
      return;
    }
    setPage("agent");
    void refresh(session.sessionId);
  }

  if (!host) {
    return <main className="p-6">{i18n.t("status.loading")}</main>;
  }
  if (!host.writable) {
    return (
      <main className="p-8 max-w-xl">
        <h1 className="text-xl mb-2">{i18n.t("setup.title")}</h1>
        <p className="text-[var(--color-subtle)] mb-4">{i18n.t("status.offline")}</p>
        <button className="bg-[var(--color-accent)] text-white px-3 py-2 rounded" onClick={() => void window.manga.chooseDirectory()}>{i18n.t("setup.continue")}</button>
      </main>
    );
  }

  const setupNeeded = settings?.needsSetup === true;
  const restartRequired = settings?.restartRequired === true || workspace?.restartRequired === true;
  const workspaceResources = (workspace?.resources as Array<{ id: string; title: string }> | undefined) ?? [];
  // The reading page shows the paged library view: workspace seeds the first page, library.list extends or filters it.
  const resources = libraryList?.items ?? workspaceResources;
  const resourceTotal = libraryList?.total ?? (workspace?.resourcePage as { total?: number } | undefined)?.total ?? null;
  const resourceNextCursor = libraryList ? libraryList.nextCursor : ((workspace?.resourcePage as { nextCursor?: string | null } | undefined)?.nextCursor ?? null);
  const facets = new Set((workspace?.uiFacets as string[] | undefined) ?? ["agent", "library", "settings"]);
  const workspaceSessions = ((workspace?.sessions as Array<{ id: string; title?: string; mode?: string | null }> | undefined) ?? [])
    .filter((item) => (item.mode ?? "enthusiast") === mode);
  const shell = (workspace?.shell as ShellPreference | undefined) ?? (settings?.shell as ShellPreference | undefined) ?? DEFAULT_SHELL_PREFERENCE;
  const channelLabel = host.layout.channel === "release" ? i18n.t("app.channel.release") : host.layout.channel === "test" ? i18n.t("app.channel.test") : i18n.t("app.channel.development");
  const pages = [
    facets.has("agent") ? { id: "agent", label: i18n.t("nav.agent"), testId: "nav-agent" } : null,
    facets.has("agent") ? { id: "copilot", label: i18n.t("nav.copilot"), testId: "nav-copilot" } : null,
    facets.has("library") || facets.has("inventory") ? { id: "library", label: i18n.t("nav.library"), testId: "nav-library" } : null,
    facets.has("library") ? { id: "reading", label: i18n.t("nav.reading"), testId: "nav-reading" } : null,
    facets.has("notes") ? { id: "notes", label: i18n.t("nav.notes"), testId: "nav-notes" } : null,
    { id: "animation", label: i18n.t("nav.animation"), testId: "nav-animation" },
    facets.has("settings") ? { id: "settings", label: i18n.t("nav.settings"), testId: "nav-settings" } : null,
  ].filter((item): item is { id: string; label: string; testId: string } => Boolean(item));
  const running = ["queued", "running", "waiting_input"].includes(String(visibleRun?.status ?? ""));
  const bound = {
    resourceId: surface.resourceId,
    resourceRevisionId: surface.resourceRevisionId,
    noteObjectId: surface.noteObjectId,
    noteRevision: surface.noteRevision,
    selection: surface.selection,
  };
  const surfaceRuns = ((workspace?.runs as Array<{ id: string; sessionId: string; status: string; inputText?: string }> | undefined) ?? []).filter((entry) => entry.sessionId === boundSessionKey);
  // The book's author style applies only while the reader keeps the built-in defaults; any saved
  // preference means the user's own choice wins.
  const styleIsDefault = JSON.stringify(shell.reading) === JSON.stringify(DEFAULT_SHELL_PREFERENCE.reading);
  const authorStyle = styleIsDefault ? ((reading as { authorStyle?: Record<string, unknown> } | null)?.authorStyle ?? null) : null;

  return (
    <ShellFrame
      viewport={viewport}
      preference={shell}
      page={page}
      pages={pages}
      onPage={setPage}
      hasRight={page === "reading" || page === "notes" || page === "agent" || page === "copilot" || page === "animation"}
      running={running}
      title={page === "animation" ? `${i18n.t("demo.title")} · ${i18n.t("demo.badge")}` : reading?.title || i18n.t("app.title")}
      channel={channelLabel}
      modeLabel={mode === "creator" ? i18n.t("mode.creator") : i18n.t("mode.enthusiast")}
      modeHints={{ enthusiast: i18n.t("mode.enthusiastHint"), creator: i18n.t("mode.creatorHint") }}
      labels={{ showLeft: i18n.t("shell.showLeft"), showRight: i18n.t("shell.showRight"), hideLeft: i18n.t("shell.hideLeft"), hideRight: i18n.t("shell.hideRight"), stop: i18n.t("shell.stop"), modeMenu: i18n.t("mode.menu") }}
      onMode={(next: WorkMode) => { void changeMode(next); }}
      onHide={(side) => { void window.manga.command({ commandId: "settings.setShell", idempotencyKey: id(), input: side === "left" ? { left: { visible: false, width: shell.layouts[mode].left.width } } : { right: { visible: false, width: shell.layouts[mode].right.width } } }).then(() => refresh()); }}
      onShow={(side) => { void window.manga.command({ commandId: "settings.setShell", idempotencyKey: id(), input: { [side]: { visible: true, width: shell.layouts[mode][side].width } } }).then(() => refresh()); }}
      onStop={() => void stop()}
      sessions={modeSessions}
      currentSession={boundSessionKey || undefined}
      sessionLabels={{ heading: i18n.t("agent.sessions"), empty: i18n.t("agent.sessionsNone"), active: i18n.t("session.active"), kinds: { resource: i18n.t("session.kindResource"), note: i18n.t("session.kindNote") } }}
      onSession={openSession}
      right={page === "animation" ? <AnimationDemoAgent state={animation} /> : <AgentPane i18n={i18n} run={visibleRun} bound={bound} sessionRuns={surfaceRuns} draft={composer.draft} setDraft={(value) => patchComposer({ draft: value })} composing={composing} setComposing={setComposing} resources={resources} materials={composer.materials} setMaterials={(value) => patchComposer({ materials: value })} notes={noteList} noteMaterials={composer.noteMaterials} setNoteMaterials={(value) => patchComposer({ noteMaterials: value })} onSend={() => void send()} onStop={() => void stop()} onRetry={() => void retry()} bindLabel={surface.label} />}
    >
      {error ? <div role="alert" className="px-4 py-2 text-[var(--color-danger)]">{error}</div> : null}
      {notice ? <div role="status" className="px-4 py-2 text-[var(--color-subtle)]">{notice}</div> : null}
      {restartRequired ? <div role="status" className="px-4 py-2 text-[var(--color-danger)]">{i18n.t("settings.restartRequired")}</div> : null}
      {setupNeeded ? (
        <div role="status" className="px-4 py-2 bg-[var(--color-accent-soft)]">
          {i18n.t("setup.needed")}
          <button className="ml-3 border px-2 py-1 rounded" onClick={() => void window.manga.command({ commandId: "settings.skipAi", idempotencyKey: id(), input: {} }).then(() => refresh())}>{i18n.t("setup.skipAi")}</button>
        </div>
      ) : null}
      <Tabs.Root value={page} onValueChange={setPage} className="min-h-0">
        <div className="workspace-page min-w-0 overflow-auto p-4">
          <Tabs.Content value="animation"><AnimationDemo state={animation} /></Tabs.Content>
          <Tabs.Content value="agent" className="h-full flex flex-col gap-3" data-testid="page-agent">
            <p className="text-sm text-[var(--color-subtle)]">{bindLabelText(i18n, surface.label)}</p>
            <SessionList i18n={i18n} sessions={workspaceSessions} runs={(workspace?.runs as Array<{ id: string; sessionId: string; status: string; inputText?: string }> | undefined) ?? []} current={sessionId} onSelect={(value) => { setSessionId(value); setRun(null); void refresh(value); }} />
            <AgentPane i18n={i18n} run={visibleRun} bound={bound} sessionRuns={surfaceRuns} draft={composer.draft} setDraft={(value) => patchComposer({ draft: value })} composing={composing} setComposing={setComposing} resources={resources} materials={composer.materials} setMaterials={(value) => patchComposer({ materials: value })} notes={noteList} noteMaterials={composer.noteMaterials} setNoteMaterials={(value) => patchComposer({ noteMaterials: value })} onSend={() => void send()} onStop={() => void stop()} onRetry={() => void retry()} bindLabel={surface.label} />
          </Tabs.Content>
          <Tabs.Content value="copilot" data-testid="page-copilot">
            <p className="text-sm text-[var(--color-subtle)] mb-3">{bindLabelText(i18n, surface.label)}</p>
            <AgentPane i18n={i18n} run={visibleRun} bound={bound} sessionRuns={surfaceRuns} draft={composer.draft} setDraft={(value) => patchComposer({ draft: value })} composing={composing} setComposing={setComposing} resources={resources} materials={composer.materials} setMaterials={(value) => patchComposer({ materials: value })} notes={noteList} noteMaterials={composer.noteMaterials} setNoteMaterials={(value) => patchComposer({ noteMaterials: value })} onSend={() => void send()} onStop={() => void stop()} onRetry={() => void retry()} bindLabel={surface.label} />
          </Tabs.Content>
          <Tabs.Content value="library" data-testid="page-library">
            <LibraryPane
              i18n={i18n}
              inventory={inventory}
              onImport={() => void window.manga.chooseFile().then(() => refresh())}
              onScan={() => void window.manga.command({ commandId: "inventory.scan", idempotencyKey: id(), input: {} }).then((item) => setInventory(item.value ?? null))}
              onCancel={() => void window.manga.command({ commandId: "inventory.cancelScan", idempotencyKey: id(), input: { scanId: "current" } })}
              onTranscribe={() => void window.manga.chooseAudio().then(async (handle) => {
                if (!handle) return;
                const result = await window.manga.command({ commandId: "library.transcribeAudio", idempotencyKey: id(), input: { pathHandle: handle } });
                if (result.status === "error") setError(result.error?.message);
                else setNotice(String(result.value?.text ?? ""));
              })}
              onReveal={(itemId) => void window.manga.reveal(itemId).then((result) => { if (result.status === "error") setError(result.error?.message); })}
              onRepair={(itemId) => void window.manga.command({ commandId: "inventory.repair", idempotencyKey: id(), input: { id: itemId } }).then((result) => { if (result.status === "error") setError(result.error?.message); else void refresh(); })}
              packagePreview={packagePreview}
              packageStrategy={packageStrategy}
              packageDecisions={packageDecisions}
              onPackageDecision={(kind, rowId, action) => setPackageDecisions((current) => {
                const next = { ...current };
                if (action) next[`${kind}:${rowId}`] = action;
                else delete next[`${kind}:${rowId}`];
                return next;
              })}
              onPackageStrategy={setPackageStrategy}
              onPackagePreview={() => void previewPackage()}
              onPackageExport={() => void exportPackage()}
              onPackageApply={() => void applyPackageImport()}
              onPackageCancel={() => { setPackagePreview(null); setPackageHandle(undefined); setPackageDecisions({}); }}
            />
          </Tabs.Content>
          <Tabs.Content value="settings">
            <SettingsPane
              i18n={i18n}
              host={host}
              settings={settings}
              migration={migration}
              onApplyMigration={() => void applyMigration()}
              onCancelMigration={() => setMigration(null)}
              onRollbackRecovery={() => void rollbackRecovery()}
              onRecoverJobs={() => void window.manga.command({ commandId: "settings.recoverJobs", idempotencyKey: id(), input: { action: "recover" } }).then((result) => { if (result.status === "error") setError(result.error?.message); void refresh(); })}
              onPointerLocation={() => void window.manga.chooseDirectory().then(async (handle) => {
                if (!handle) return;
                const result = await window.manga.command({ commandId: "settings.setLayout", idempotencyKey: id(), input: { pointerPathHandle: handle } });
                if (result.status === "error") setError(result.error?.message);
                await refresh();
              })}
              formatDate={i18n.formatDate}
              formatNumber={i18n.formatNumber}
              onSkip={() => void window.manga.command({ commandId: "settings.skipAi", idempotencyKey: id(), input: {} }).then(() => refresh())}
              onChooseLocation={() => void chooseLocation()}
              onIndexedRoot={() => void window.manga.chooseDirectory().then(async (handle) => {
                if (!handle) return;
                const result = await window.manga.command({ commandId: "library.indexExternal", idempotencyKey: id(), input: { pathHandle: handle } });
                if (result.status === "error") setError(result.error?.message);
                await refresh();
              })}
              onRuntime={async (runtime) => {
                const result = await window.manga.command({ commandId: "settings.setRuntime", idempotencyKey: id(), input: { runtime } });
                if (result.status === "error") setError(result.error?.message);
                await refresh();
              }}
              onSaveConnection={saveConnection}
              onDeleteConnection={async (connectionId) => {
                const result = await window.manga.command({ commandId: "connections.delete", idempotencyKey: id(), input: { connectionId } });
                if (result.status === "error") setError(result.error?.message);
                await refresh();
              }}
              onTestConnection={async (connectionId, capability) => {
                const result = await window.manga.command({ commandId: "connections.test", idempotencyKey: id(), input: { connectionId, capability } });
                if (result.status === "error") setError(result.error?.message);
                else setNotice(i18n.t("settings.testConnection"));
                await refresh();
              }}
            />
          </Tabs.Content>
          <Tabs.Content value="reading">
            <ReadingPane
              resources={resources}
              document={reading ? { ...reading, authorStyle } : reading}
              style={{ ...shell.reading }}
              hits={hits}
              bookmarks={bookmarks}
              assets={assetUrls}
              originalBytes={originalBytes}
              highlight={highlight}
              sourceCard={sourceCard}
              resourceTotal={resourceTotal}
              resourceNextCursor={resourceNextCursor}
              onMoreResources={() => void loadMoreResources()}
              resourceQuery={libraryList?.query ?? ""}
              onSearchResources={(query) => void searchResources(query)}
              onBackToNote={() => void backToNote()}
              onRepair={() => void repairNoteSource()}
              labelsExtra={{ backToNote: i18n.t("reading.sourceBack"), sourceResolved: i18n.t("reading.sourceResolved"), sourceNeedsReview: i18n.t("reading.sourceNeedsReview"), sourceMissing: i18n.t("reading.sourceMissing"), sourceRepair: i18n.t("reading.sourceRepair"), sourceCard: i18n.t("reading.sourceCard") }}
              labels={{
                importBook: i18n.t("library.importBook"),
                empty: i18n.t("status.empty"),
                search: i18n.t("reading.search"),
                progress: i18n.t("reading.progress"),
                note: i18n.t("reading.note"),
                missing: i18n.t("reading.missing"),
                scan: i18n.t("reading.scan"),
                more: i18n.t("reading.more"),
                image: i18n.t("reading.image"),
                imageFailed: i18n.t("reading.imageFailed"),
                restored: i18n.t("reading.restored"),
                restoredStart: i18n.t("reading.restoredStart"),
                restoredOffset: i18n.t("reading.restoredOffset"),
                rangeRead: i18n.t("reading.rangeRead"),
                rangeNone: i18n.t("reading.rangeNone"),
                style: i18n.t("reading.style"),
                fontSize: i18n.t("reading.fontSize"),
                fontFamily: i18n.t("reading.fontFamily"),
                fontSans: i18n.t("reading.fontSans"),
                fontSerif: i18n.t("reading.fontSerif"),
                fontMono: i18n.t("reading.fontMono"),
                lineHeight: i18n.t("reading.lineHeight"),
                margin: i18n.t("reading.margin"),
                measure: i18n.t("reading.measure"),
                themeWhite: i18n.t("reading.themeWhite"),
                themeGreen: i18n.t("reading.themeGreen"),
                themePaper: i18n.t("reading.themePaper"),
                themeNight: i18n.t("reading.themeNight"),
                bookmark: i18n.t("reading.bookmark"),
                bookmarkAdd: i18n.t("reading.bookmarkAdd"),
                bookmarkNone: i18n.t("reading.bookmarkNone"),
                bookmarkRemove: i18n.t("reading.bookmarkRemove"),
                prev: i18n.t("reading.prev"),
                next: i18n.t("reading.next"),
                part: i18n.t("reading.part"),
                hits: i18n.t("reading.hits"),
                hitNone: i18n.t("reading.hitNone"),
                jump: i18n.t("reading.jump"),
                toc: i18n.t("reading.toc"),
                source: i18n.t("reading.source"),
                sourceOpen: i18n.t("reading.sourceOpen"),
                quote: i18n.t("reading.quote"),
                images: i18n.t("reading.images"),
                selectForAgent: i18n.t("reading.selectForAgent"),
                partSource: i18n.t("reading.partSource"),
                resourceTotal: i18n.t("reading.resourceTotal"),
                resourceLoadMore: i18n.t("reading.resourceLoadMore"),
                resourceSearch: i18n.t("reading.resourceSearch"),
                resourceSearchAction: i18n.t("reading.resourceSearchAction"),
                viewPage: i18n.t("reading.viewPage"),
                viewText: i18n.t("reading.viewText"),
              }}
              onImportBook={() => void window.manga.chooseBook().then((result) => { if (result?.status === "error") setError(result.error?.message); else void refresh(); })}
              onOpen={(resourceId) => void openResource(resourceId)}
              onSearch={(text) => void window.manga.command({ commandId: "library.find", idempotencyKey: id(), input: { text, resourceId: reading?.resourceId } }).then((result) => {
                setSearched(true);
                setHits((result.value as Array<{ text: string; fragmentId?: string; revisionId?: string; locator?: { partId: string; range: { start: number; end: number } } }> | undefined) ?? []);
              })}
              onJump={(partId, start, end) => {
                // A hit is pinned to the revision it was found in, which may not be the open one.
                const hit = hits.find((entry) => entry.locator?.partId === partId && entry.locator.range.start === start) as { revisionId?: string } | undefined;
                void openSlice(partId, Math.max(0, start - 200), { highlight: { start, end: Math.max(end, start) }, revisionId: hit?.revisionId });
              }}
              searched={searched}
              onProgress={() => void markProgress()}
              onNote={(quote, start, end, partId) => void noteSelection(quote, start, end, partId)}
              onSelectForAgent={(quote, start, end, partId) => {
                if (!reading) return;
                setAgentSelection({ resourceId: reading.resourceId, resourceRevisionId: reading.revisionId, partId, start, end, quote });
                setNotice(i18n.t("reading.selected", { quote: quote.slice(0, 40) }));
              }}
              onMore={(partId, start) => void openSlice(partId, start)}
              onPart={(partId, start) => void openSlice(partId, start)}
              onStyle={(patch) => void saveStyle(patch)}
              onBookmark={() => void addBookmark()}
              onRemoveBookmark={(bookmarkId) => void removeBookmark(bookmarkId)}
              onOpenBookmark={(bookmark) => void openBookmark(bookmark as Bookmark)}
            />
          </Tabs.Content>
          <Tabs.Content value="notes">
            <section data-testid="notes-page">
              <div className="flex gap-2 mb-2 flex-wrap items-end">
                <button type="button" className="bg-[var(--color-accent)] text-white px-3 py-1 rounded" data-testid="note-new" onClick={() => void createStandaloneNote()}>{i18n.t("notes.new")}</button>
                <form className="text-sm flex items-end gap-1" onSubmit={(event) => { event.preventDefault(); void refreshNotes(); }}>
                  <label>{i18n.t("notes.search")}<Input className="ml-1 w-44" data-testid="note-search" value={noteQuery} onChange={(event) => setNoteQuery(event.target.value)} /></label>
                  <button type="submit" className="border px-2 py-1 rounded" data-testid="note-search-run">{i18n.t("notes.searchAction")}</button>
                </form>
                <form className="text-sm flex items-end gap-1" onSubmit={(event) => { event.preventDefault(); void refreshNotes(); }}>
                  <label>{i18n.t("notes.filterTag")}<Input className="ml-1 w-44" data-testid="note-tag-filter" value={noteTag} onChange={(event) => setNoteTag(event.target.value)} /></label>
                  <button type="submit" className="border px-2 py-1 rounded" data-testid="note-tag-run">{i18n.t("notes.filterAction")}</button>
                </form>
              </div>
              {noteStatus === "loading" ? <p role="status" data-testid="notes-loading">{i18n.t("notes.loading")}</p> : null}
              {noteStatus === "error" ? <p role="alert" data-testid="notes-error">{i18n.t("notes.error")}</p> : null}
              {noteStatus === "idle" && noteList.length === 0 ? (
                <p data-testid="notes-empty">{noteQuery || noteTag ? i18n.t("notes.emptyResult") : i18n.t("notes.emptyHint")}</p>
              ) : null}
              {noteList.length ? (
                <ul className="flex flex-col gap-1 mb-3 text-sm" data-testid="notes-list">
                  {noteList.map((note) => (
                    <li key={note.objectId} className="flex gap-2 items-center">
                      <button type="button" className="border px-2 py-1 rounded" data-testid={`note-${note.objectId}`} onClick={() => void openNote(note.objectId)}>
                        {note.title || i18n.t("notes.open")}
                        {note.tags.length ? ` · ${note.tags.join(",")}` : ""}
                        {note.resourceId ? ` · ${i18n.t("reading.source")}` : ""}
                        {note.sourceStatus && note.sourceStatus !== "linked" && note.sourceStatus !== "none" ? ` · ${i18n.t("notes.sourceStale")}` : ""}
                      </button>
                      {note.resourceId ? <button type="button" className="border px-2 py-1 rounded" data-testid={`note-source-${note.objectId}`} onClick={() => void openNoteSource(note.objectId)}>{i18n.t("reading.sourceOpen")}</button> : null}
                    </li>
                  ))}
                </ul>
              ) : null}
              {noteDoc ? (
                <section data-testid="note-panel">
                  <div className="flex gap-2 items-center mb-2 text-sm flex-wrap">
                    <h2 className="font-medium" data-testid="note-title">{noteDoc.title}</h2>
                    <button type="button" className="border px-2 py-0.5 rounded" data-testid="note-rename" onClick={() => setRenaming((current) => !current)}>{i18n.t("notes.rename")}</button>
                    <button type="button" className="border px-2 py-0.5 rounded" data-testid="note-history" onClick={() => void loadHistory()}>{i18n.t("notes.history")}</button>
                    {noteDoc.tags.length ? <span data-testid="note-tags">{noteDoc.tags.join(",")}</span> : null}
                  </div>
                  {renaming ? (
                    <form
                      className="flex gap-2 items-end mb-2 text-sm flex-wrap"
                      data-testid="note-rename-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        const data = new FormData(event.currentTarget);
                        void renameNote(String(data.get("title") ?? ""), String(data.get("tags") ?? "").split(","));
                      }}
                    >
                      <label>{i18n.t("notes.title")}<Input name="title" className="ml-1 w-44" data-testid="note-title-input" defaultValue={noteDoc.title} /></label>
                      <label>{i18n.t("notes.tags")}<Input name="tags" className="ml-1 w-44" data-testid="note-tags-input" defaultValue={noteDoc.tags.join(",")} placeholder={i18n.t("notes.tagsHint")} /></label>
                      <button type="submit" className="border px-2 py-1 rounded" data-testid="note-rename-save">{i18n.t("notes.saveTitle")}</button>
                      <button type="button" className="border px-2 py-1 rounded" data-testid="note-rename-cancel" onClick={() => setRenaming(false)}>{i18n.t("notes.cancelEdit")}</button>
                    </form>
                  ) : null}
                  {noteDoc.sourceStatus && noteDoc.sourceStatus !== "linked" && noteDoc.sourceStatus !== "none" ? (
                    <p role="status" className="text-sm mb-2" data-testid="note-stale-banner">
                      {i18n.t("notes.sourceStale")}
                      <button type="button" className="border px-2 py-0.5 rounded ml-2" data-testid="note-stale-repair" onClick={() => void openNoteSource(noteDoc.objectId)}>{i18n.t("reading.sourceOpen")}</button>
                    </p>
                  ) : null}
                  {showHistory ? (
                    <ul className="text-sm mb-2" data-testid="note-history-list">
                      {noteHistory.map((entry) => (
                        <li key={entry.revision} className="flex gap-2 items-center">
                          <span>r{entry.revision} · {entry.blockCount} · {entry.preview.slice(0, 40)}</span>
                          <button type="button" className="border px-2 py-0.5 rounded" data-testid={`note-restore-${entry.revision}`} onClick={() => void restoreRevision(entry.revision)}>{i18n.t("notes.restore")}</button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <NoteEditor
                    key={`${noteDoc.objectId}:${noteEpoch}`}
                    objectId={noteDoc.objectId}
                    document={{ schemaVersion: 2, blocks: noteDoc.blocks }}
                    revision={noteDoc.revision}
                    title={noteDoc.title}
                    tags={noteDoc.tags}
                    focusBlockId={focusBlock ?? undefined}
                    sourceStale={Boolean(noteDoc.sourceStatus && noteDoc.sourceStatus !== "linked" && noteDoc.sourceStatus !== "none")}
                    onOpenSource={(blockId) => void openNoteSource(noteDoc.objectId, blockId)}
                    saveLabel={i18n.t("notes.save")}
                    savingLabel={i18n.t("notes.saving")}
                    savedLabel={i18n.t("notes.saved")}
                    failedLabel={i18n.t("notes.failed")}
                    splitLabel={i18n.t("notes.split")}
                    sourceLabel={i18n.t("notes.source")}
                    labels={{
                      blockInsert: i18n.t("notes.blockInsert"),
                      blockRemove: i18n.t("notes.blockRemove"),
                      blockMoveUp: i18n.t("notes.blockMoveUp"),
                      blockMoveDown: i18n.t("notes.blockMoveDown"),
                      blockCopy: i18n.t("notes.blockCopy"),
                      blockMerge: i18n.t("notes.merge"),
                      blockType: i18n.t("notes.blockType"),
                      typeParagraph: i18n.t("notes.typeParagraph"),
                      typeHeading: i18n.t("notes.typeHeading"),
                      typeList: i18n.t("notes.typeList"),
                      typeQuote: i18n.t("notes.typeQuote"),
                      typeCode: i18n.t("notes.typeCode"),
                      typePlain: i18n.t("notes.typePlain"),
                      draftRestored: i18n.t("notes.draftRestored"),
                      draftDiscard: i18n.t("notes.draftDiscard"),
                      conflict: i18n.t("notes.conflict"),
                      sourceStale: i18n.t("notes.sourceStale"),
                      repairSource: i18n.t("notes.repairSource"),
                      undo: i18n.t("notes.undo"),
                      redo: i18n.t("notes.redo"),
                      undoHint: i18n.t("notes.undoHint"),
                      sourceEdit: i18n.t("notes.sourceEdit"),
                      openSource: i18n.t("reading.sourceOpen"),
                    }}
                    onSourceStale={() => void openNoteSource(noteDoc.objectId)}
                    onSave={(blocks, expectedRevision) => saveNote(blocks, expectedRevision, noteDoc.title, noteDoc.tags)}
                  />
                </section>
              ) : <p>{i18n.t("status.empty")}</p>}
            </section>
          </Tabs.Content>
        </div>
      </Tabs.Root>
    </ShellFrame>
  );
}

function bindLabelText(i18n: ReturnType<typeof createTranslator>, title?: string): string {
  if (!title) return i18n.t("agent.shared");
  return `${i18n.t("agent.sessionBound", { title })}`;
}

function SessionList(props: { i18n: ReturnType<typeof createTranslator>; sessions: Array<{ id: string; title?: string }>; runs: Array<{ id: string; sessionId: string; status: string; inputText?: string }>; current?: string; onSelect: (id: string) => void }) {
  if (!props.sessions.length) return null;
  return (
    <section>
      <h2 className="text-sm mb-1">{props.i18n.t("agent.history")}</h2>
      <ul className="flex flex-wrap gap-2 text-sm">
        {props.sessions.map((session) => {
          const count = props.runs.filter((run) => run.sessionId === session.id).length;
          return (
            <li key={session.id}>
              <button data-testid={`session-${session.id}`} className={`border px-2 py-1 rounded ${props.current === session.id ? "bg-[var(--color-accent-soft)]" : ""}`} onClick={() => props.onSelect(session.id)}>{session.title ?? session.id} · {count}</button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function AgentPane(props: {
  i18n: ReturnType<typeof createTranslator>;
  run: Record<string, unknown> | null;
  bound: { resourceId?: string; resourceRevisionId?: string; noteObjectId?: string; noteRevision?: number; selection: AgentSelection | null };
  sessionRuns: Array<{ id: string; sessionId: string; status: string; inputText?: string }>;
  draft: string;
  setDraft: (value: string) => void;
  composing: boolean;
  setComposing: (value: boolean) => void;
  resources: Array<{ id: string; title: string }>;
  materials: string[];
  setMaterials: (value: string[]) => void;
  notes: NoteSummary[];
  noteMaterials: string[];
  setNoteMaterials: (value: string[]) => void;
  onSend: () => void;
  onStop: () => void;
  onRetry: () => void;
  bindLabel?: string;
}) {
  const toggle = (resourceId: string, checked: boolean) => {
    props.setMaterials(checked ? [...new Set([...props.materials, resourceId])] : props.materials.filter((item) => item !== resourceId));
  };
  const toggleNote = (objectId: string, checked: boolean) => {
    props.setNoteMaterials(checked ? [...new Set([...props.noteMaterials, objectId])] : props.noteMaterials.filter((item) => item !== objectId));
  };
  const status = String(props.run?.status ?? (props.run ? "succeeded" : ""));
  const snapshot = props.run?.snapshot as { materials?: Array<{ resourceId: string; revisionId: string; title: string }>; selection?: { quote?: string; blocked?: string }; notes?: Array<{ objectId: string; revision: number; title: string }> } | undefined;
  const frozenMaterials = (props.run?.materials as Array<{ resourceId: string; revisionId: string; title: string }> | undefined) ?? [];
  const frozenNotes = (props.run?.noteMaterials as Array<{ objectId: string; revision: number; title: string; truncated?: boolean; chars?: number }> | undefined) ?? [];
  const frozenContext = typeof props.run?.contextText === "string" ? props.run.contextText : "";
  const boundTitle = props.resources.find((resource) => resource.id === props.bound.resourceId)?.title;
  const boundNoteTitle = props.notes.find((note) => note.objectId === props.bound.noteObjectId)?.title;
  const hasBound = Boolean(props.bound.resourceId || props.bound.noteObjectId || props.bound.selection);
  return (
    <div className="agent-pane">
      {props.bindLabel ? <p className="text-sm" data-testid="agent-bound">{props.i18n.t("agent.sessionBound", { title: props.bindLabel })}</p> : null}
      <section className="agent-context text-sm" data-testid="agent-bound-context">
        <h2 className="font-medium mb-1">{props.i18n.t("agent.bound")}</h2>
        {!hasBound ? <p className="text-[var(--color-subtle)]" data-testid="agent-bound-none">{props.i18n.t("agent.boundNone")}</p> : (
          <ul>
            {props.bound.resourceId ? (
              <li data-testid="agent-bound-resource">{props.i18n.t("agent.boundResource", { title: boundTitle ?? props.bound.resourceId, revision: props.bound.resourceRevisionId ?? "-" })}</li>
            ) : null}
            {props.bound.noteObjectId ? (
              <li data-testid="agent-bound-note">{props.i18n.t("agent.boundNote", { title: boundNoteTitle ?? (props.bindLabel ?? props.bound.noteObjectId), revision: String(props.bound.noteRevision ?? "-") })}</li>
            ) : null}
            {props.bound.selection ? (
              <li data-testid="agent-bound-selection">{props.i18n.t("agent.boundSelection", { quote: props.bound.selection.quote.slice(0, 60) })}</li>
            ) : null}
            <li className="text-[var(--color-subtle)]" data-testid="agent-bound-auto">{props.i18n.t("agent.boundAuto")}</li>
          </ul>
        )}
      </section>
      <fieldset className="agent-materials border border-[var(--color-border)] rounded p-3 bg-[var(--color-surface)]">
        <legend className="text-sm px-1">{props.i18n.t("agent.materials")}</legend>
        {props.resources.length === 0 ? <p className="text-sm text-[var(--color-subtle)]">{props.i18n.t("agent.materialsNone")}</p> : (
          <ul className="grid gap-1 max-h-32 overflow-auto text-sm">
            {props.resources.map((resource) => (
              <li key={resource.id}>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={props.materials.includes(resource.id)} onChange={(event) => toggle(resource.id, event.target.checked)} data-testid={`material-${resource.id}`} />
                  <span>{resource.title}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
        {props.notes.length ? (
          <>
            <h3 className="text-sm mt-2">{props.i18n.t("notes.list")}</h3>
            <ul className="grid gap-1 max-h-32 overflow-auto text-sm">
              {props.notes.map((note) => (
                <li key={note.objectId}>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={props.noteMaterials.includes(note.objectId)} onChange={(event) => toggleNote(note.objectId, event.target.checked)} data-testid={`note-material-${note.objectId}`} />
                    <span>{note.title}</span>
                  </label>
                </li>
              ))}
            </ul>
          </>
        ) : null}
        <p className="text-xs text-[var(--color-subtle)] mt-1">{props.i18n.t("agent.scope")}：{props.i18n.t("agent.scopeCount", { count: props.materials.length + props.noteMaterials.length + (props.bound.resourceId ? 1 : 0) + (props.bound.noteObjectId ? 1 : 0) })}</p>
      </fieldset>
      {frozenMaterials.length || frozenNotes.length || snapshot?.selection ? (
        <section className="border border-[var(--color-border)] rounded p-3 bg-[var(--color-surface)] text-sm" data-testid="agent-snapshot">
          <h2 className="font-medium mb-1">{props.i18n.t("agent.snapshot")}</h2>
          <ul>
            {frozenMaterials.map((material) => (
              <li key={material.resourceId} data-testid={`snapshot-material-${material.resourceId}`}>{props.i18n.t("agent.snapshotMaterials", { title: material.title, revision: material.revisionId })}</li>
            ))}
            {frozenNotes.map((note) => (
              <li key={note.objectId} data-testid={`snapshot-note-${note.objectId}`}>{props.i18n.t("agent.snapshotNoteBody", { title: note.title, revision: String(note.revision), chars: String(note.chars ?? 0) })}</li>
            ))}
            {snapshot?.selection?.quote ? <li data-testid="snapshot-selection">{props.i18n.t("agent.snapshotSelection", { quote: snapshot.selection.quote })}</li> : null}
            {snapshot?.selection?.blocked ? <li data-testid="snapshot-selection-blocked">{String(snapshot.selection.blocked)}</li> : null}
          </ul>
          {frozenContext ? (
            <>
              <h3 className="font-medium mt-2">{props.i18n.t("agent.contextFrozen")}</h3>
              <pre className="text-xs whitespace-pre-wrap max-h-40 overflow-auto" data-testid="agent-context-text">{frozenContext}</pre>
            </>
          ) : null}
        </section>
      ) : null}
      <section className="agent-thread min-h-40" data-testid="agent-thread">
        <h2 className="font-medium mb-2">{props.i18n.t("agent.tools")}</h2>
        {props.sessionRuns.length ? (
          <ol className="text-sm space-y-2 mb-3">
            {props.sessionRuns.slice().reverse().map((entry) => (
              <li key={entry.id} data-testid={`run-${entry.id}`}>
                <div className="text-[var(--color-subtle)]">{props.i18n.t("agent.status", { status: entry.status })}</div>
                <p>{props.i18n.t("agent.userTurn")}: {entry.inputText || String(props.run?.inputText ?? "")}</p>
              </li>
            ))}
          </ol>
        ) : null}
        {props.run ? <p className="text-xs text-[var(--color-subtle)] mb-1">{props.i18n.t("agent.status", { status })}</p> : null}
        {props.run?.inputText ? <p className="text-sm mb-2" data-testid="agent-input">{String(props.run.inputText)}</p> : null}
        {props.run ? <Markdown remarkPlugins={[remarkGfm]}>{String(props.run.text || props.run.liveText || props.i18n.t("agent.empty"))}</Markdown> : <p>{props.i18n.t("agent.empty")}</p>}
        {props.run ? <details className="agent-diagnostics"><summary>{props.i18n.t("agent.diagnostics")}</summary><p>{props.i18n.t("agent.grant", { handle: String(props.run.grantHandle ?? "-") })}</p>
          {Array.isArray(props.run?.tools) ? <pre className="text-xs mt-2 whitespace-pre-wrap">{JSON.stringify(props.run?.tools, null, 2)}</pre> : null}
          {Array.isArray(props.run?.messages) ? <pre className="text-xs mt-2 whitespace-pre-wrap" data-testid="agent-messages">{JSON.stringify(props.run?.messages, null, 2)}</pre> : null}
        </details> : null}
      </section>
      <div className="agent-compose"><label className="block">
        <span className="text-sm">{props.i18n.t("agent.composer")}</span>
        <Textarea
          data-testid="agent-composer"
          placeholder={props.i18n.t("agent.placeholder")}
          className="w-full mt-1 min-h-24 border border-[var(--color-border)] rounded p-2 shadow-none"
          value={props.draft}
          onChange={(event) => props.setDraft(event.target.value)}
          onCompositionStart={() => props.setComposing(true)}
          onCompositionEnd={() => props.setComposing(false)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !props.composing) {
              event.preventDefault();
              props.onSend();
            }
          }}
        />
      </label>
      <div className="compose-actions flex gap-2">
        <button className="bg-[var(--color-accent)] text-white px-3 py-1 rounded" data-testid="agent-send" onClick={props.onSend}>{props.i18n.t("agent.send")}</button>
        <button className="border border-[var(--color-border)] px-3 py-1 rounded" data-testid="agent-stop" onClick={props.onStop}>{props.i18n.t("agent.stop")}</button>
        <button className="border border-[var(--color-border)] px-3 py-1 rounded" data-testid="agent-retry" onClick={props.onRetry}>{props.i18n.t("agent.retry")}</button>
      </div>
      </div>
    </div>
  );
}

function LibraryPane(props: {
  i18n: ReturnType<typeof createTranslator>;
  inventory: Record<string, unknown> | null;
  onImport: () => void;
  onScan: () => void;
  onCancel: () => void;
  onTranscribe: () => void;
  onReveal: (id: string) => void;
  onRepair: (id: string) => void;
  packagePreview: { counts: Record<string, number>; empty: boolean; conflicts: Array<{ kind: string; id: string; label: string; reason: string }>; missingAttachments: string[] } | null;
  packageStrategy: "skip" | "replace" | "duplicate";
  packageDecisions: Record<string, "skip" | "replace" | "duplicate">;
  onPackageDecision: (kind: string, id: string, action: "skip" | "replace" | "duplicate" | null) => void;
  onPackageStrategy: (strategy: "skip" | "replace" | "duplicate") => void;
  onPackagePreview: () => void;
  onPackageExport: () => void;
  onPackageApply: () => void;
  onPackageCancel: () => void;
}) {
  const items = (props.inventory?.items as Array<Record<string, unknown>> | undefined) ?? [];
  const totals = props.inventory?.totals as Record<string, { count?: number; bytes?: number }> | undefined;
  return (
    <section>
      <div className="flex gap-2 mb-3 flex-wrap">
        <button className="bg-[var(--color-accent)] text-white px-3 py-1 rounded" onClick={props.onImport}>{props.i18n.t("library.import")}</button>
        <button className="border px-3 py-1 rounded" onClick={props.onScan}>{props.i18n.t("library.scan")}</button>
        <button className="border px-3 py-1 rounded" onClick={props.onCancel}>{props.i18n.t("library.cancelScan")}</button>
        <button className="border px-3 py-1 rounded" onClick={props.onTranscribe}>{props.i18n.t("library.transcribe")}</button>
        <button className="border px-3 py-1 rounded" data-testid="package-export" onClick={props.onPackageExport}>{props.i18n.t("settings.packageExport")}</button>
        <button className="border px-3 py-1 rounded" data-testid="package-preview" onClick={props.onPackagePreview}>{props.i18n.t("settings.packagePreview")}</button>
      </div>
      {props.packagePreview ? (
        <section className="border border-[var(--color-border)] rounded p-3 mb-3 text-sm" data-testid="package-preview-panel" data-empty={props.packagePreview.empty ? "true" : "false"}>
          <h2 className="font-medium">{props.i18n.t("settings.packagePreview")}</h2>
          <p data-testid="package-summary">{props.i18n.t("settings.packageSummary", { works: props.packagePreview.counts.works ?? 0, objects: props.packagePreview.counts.objects ?? 0, attachments: props.packagePreview.counts.attachments ?? 0 })}</p>
          <p>{props.packagePreview.empty ? props.i18n.t("settings.packageEmpty") : props.i18n.t("settings.packageConflicts", { count: props.packagePreview.conflicts.length })}</p>
          {props.packagePreview.conflicts.length ? (
            <ul className="max-h-40 overflow-auto" data-testid="package-conflicts">
              {props.packagePreview.conflicts.map((conflict) => (
                <li key={`${conflict.kind}-${conflict.id}`} className="flex gap-2 items-center">
                  <span>{conflict.kind} · {conflict.label} · {conflict.reason}</span>
                  <select
                    className="border rounded"
                    data-testid={`package-decision-${conflict.kind}-${conflict.id}`}
                    value={props.packageDecisions[`${conflict.kind}:${conflict.id}`] ?? ""}
                    onChange={(event) => props.onPackageDecision(conflict.kind, conflict.id, (event.target.value || null) as "skip" | "replace" | "duplicate" | null)}
                  >
                    <option value="">{props.i18n.t("package.rowDefault")}</option>
                    <option value="skip">{props.i18n.t("settings.strategySkip")}</option>
                    <option value="replace">{props.i18n.t("settings.strategyReplace")}</option>
                    <option value="duplicate">{props.i18n.t("settings.strategyDuplicate")}</option>
                  </select>
                </li>
              ))}
            </ul>
          ) : null}
          {props.packagePreview.missingAttachments.length ? <p data-testid="package-missing">{props.i18n.t("settings.packageMissing", { count: props.packagePreview.missingAttachments.length })}</p> : null}
          <label className="block mt-2">{props.i18n.t("settings.packageStrategy")}
            <select className="border rounded px-2 py-1 ml-1" data-testid="package-strategy" value={props.packageStrategy} onChange={(event) => props.onPackageStrategy(event.target.value as "skip" | "replace" | "duplicate")}>
              <option value="skip">{props.i18n.t("settings.strategySkip")}</option>
              <option value="replace">{props.i18n.t("settings.strategyReplace")}</option>
              <option value="duplicate">{props.i18n.t("settings.strategyDuplicate")}</option>
            </select>
          </label>
          <div className="flex gap-2 mt-2">
            <button className="bg-[var(--color-accent)] text-white px-3 py-1 rounded" data-testid="package-apply" onClick={props.onPackageApply}>{props.i18n.t("settings.packageApply")}</button>
            <button className="border px-3 py-1 rounded" data-testid="package-cancel" onClick={props.onPackageCancel}>{props.i18n.t("settings.migrationCancel")}</button>
          </div>
        </section>
      ) : null}
      {totals ? <p className="text-sm text-[var(--color-subtle)] mb-2">{props.i18n.t("library.count", { count: Number(totals.resource?.count ?? 0) })} · {props.i18n.t("library.bytes", { value: Number(totals.resource?.bytes ?? 0) })}</p> : null}
      {totals && Number(totals.resource?.count ?? 0) > items.filter((item) => item.kind === "resource").length ? (
        <p className="text-sm text-[var(--color-subtle)] mb-2" data-testid="library-window">{props.i18n.t("library.recentWindow", { listed: items.filter((item) => item.kind === "resource").length, count: Number(totals.resource?.count ?? 0) })}</p>
      ) : null}
      {items.length === 0 ? <p>{props.i18n.t("status.empty")}</p> : (
        <ul className="space-y-2">
          {items.map((item) => (
            <li key={String(item.id)} className="border border-[var(--color-border)] rounded p-2 bg-[var(--color-surface)]">
              <div>{String(item.title)}</div>
              <div className="text-sm text-[var(--color-subtle)]">{String(item.kind)} · {item.hosted ? props.i18n.t("library.hosted") : props.i18n.t("library.indexed")} · {item.available === false ? props.i18n.t("library.unavailable") : props.i18n.t("library.available")} · {props.i18n.t("library.bytes", { value: Number(item.bytes ?? 0) })}</div>
              {item.revealable ? <button className="text-sm mt-1 border px-2 py-0.5 rounded" onClick={() => props.onReveal(String(item.id))}>{props.i18n.t("library.reveal")}</button> : null}
              {item.available === false ? <button className="text-sm mt-1 ml-2 border px-2 py-0.5 rounded" onClick={() => props.onRepair(String(item.id))}>{props.i18n.t("library.repair")}</button> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RecoveryJobs(props: { i18n: ReturnType<typeof createTranslator>; jobs: Array<{ id: string; kind: string; stage: string; status: string }>; onRollback: () => void; onRecover: () => void }) {
  return (
    <section className="space-y-1">
      <h3 className="font-medium">{props.i18n.t("settings.recoveryJobs")}</h3>
      {props.jobs.length === 0 ? <p className="text-sm text-[var(--color-subtle)]">{props.i18n.t("settings.recoveryNone")}</p> : (
        <>
          <ul className="text-sm">
            {props.jobs.map((job) => <li key={job.id}>{job.kind} · {job.stage} · {job.status}</li>)}
          </ul>
          <div className="flex gap-2">
            <button className="border px-3 py-1 rounded" onClick={props.onRecover}>{props.i18n.t("settings.recoveryResume")}</button>
            <button className="border px-3 py-1 rounded" onClick={props.onRollback}>{props.i18n.t("settings.recoveryRollback")}</button>
          </div>
        </>
      )}
    </section>
  );
}

function SettingsPane(props: {
  i18n: ReturnType<typeof createTranslator>;
  host: Awaited<ReturnType<Window["manga"]["state"]>>;
  settings: Record<string, unknown> | null;
  migration: { checkpointId: string; copies: Array<{ partition: string; bytes: number; target: string }> } | null;
  onApplyMigration: () => void;
  onCancelMigration: () => void;
  onRollbackRecovery: () => void;
  onRecoverJobs: () => void;
  onPointerLocation: () => void;
  formatDate: (value: string | Date) => string;
  formatNumber: (value: number) => string;
  onSkip: () => void;
  onChooseLocation: () => void;
  onIndexedRoot: () => void;
  onRuntime: (runtime: string) => Promise<void>;
  onSaveConnection: (fields: ConnectionForm) => Promise<void>;
  onDeleteConnection: (id: string) => Promise<void>;
  onTestConnection: (id: string, capability: string) => Promise<void>;
}) {
  const [form, setForm] = useState<ConnectionForm>(emptyForm);
  const connections = (props.settings?.connections as Array<Record<string, unknown>> | undefined) ?? [];
  const runtime = String(props.settings?.aiRuntime ?? "native");
  return (
    <section className="space-y-4 max-w-2xl">
      <h2 className="font-medium">{props.i18n.t("setup.title")}</h2>
      <p>{props.i18n.t("setup.aiOptional")}</p>
      <dl className="grid grid-cols-2 gap-2 text-sm">
        <dt>{props.i18n.t("setup.channel")}</dt><dd>{props.host.layout.channel}</dd>
        <dt>{props.i18n.t("setup.pointer")}</dt><dd>{props.host.layout.pointerPath}</dd>
        {Object.entries(props.host.layout.partitions).map(([name, value]) => (
          <span key={name} className="contents"><dt>{props.i18n.t("settings.partition", { name })}</dt><dd>{value}</dd></span>
        ))}
      </dl>
      <label className="block text-sm">
        {props.i18n.t("settings.runtime")}
        <select className="border w-full p-2 rounded mt-1" aria-label={props.i18n.t("settings.runtime")} value={runtime} onChange={(event) => void props.onRuntime(event.target.value)}>
          <option value="native">{props.i18n.t("settings.runtimeNative")}</option>
          <option value="pi">{props.i18n.t("settings.runtimePi")}</option>
        </select>
      </label>
      <div className="flex gap-2 flex-wrap">
        <button className="border px-3 py-1 rounded" onClick={props.onSkip}>{props.i18n.t("setup.skipAi")}</button>
        <button className="border px-3 py-1 rounded" onClick={props.onChooseLocation}>{props.i18n.t("settings.chooseDirectory")}</button>
        <button className="border px-3 py-1 rounded" onClick={props.onPointerLocation}>{props.i18n.t("settings.choosePointer")}</button>
        <button className="border px-3 py-1 rounded" onClick={props.onIndexedRoot}>{props.i18n.t("settings.chooseIndexed")}</button>
      </div>
      {props.migration ? (
        <section role="region" aria-label={props.i18n.t("settings.migrationPlan")} className="border border-[var(--color-border)] rounded p-3 bg-[var(--color-surface)] space-y-2">
          <h3 className="font-medium">{props.i18n.t("settings.migrationPlan")}</h3>
          <p className="text-sm">{props.i18n.t("settings.migrationSummary", { count: props.migration.copies.length, bytes: props.formatNumber(props.migration.copies.reduce((sum, copy) => sum + copy.bytes, 0)) })}</p>
          <ul className="text-sm text-[var(--color-subtle)]">
            {props.migration.copies.map((copy) => <li key={copy.partition}>{copy.partition} · {copy.target} · {props.i18n.t("library.bytes", { value: copy.bytes })}</li>)}
          </ul>
          <div className="flex gap-2">
            <button className="bg-[var(--color-accent)] text-white px-3 py-1 rounded" onClick={props.onApplyMigration}>{props.i18n.t("settings.migrationApply")}</button>
            <button className="border px-3 py-1 rounded" onClick={props.onCancelMigration}>{props.i18n.t("settings.migrationCancel")}</button>
          </div>
        </section>
      ) : null}
      <RecoveryJobs i18n={props.i18n} jobs={(props.settings?.recoveryJobs as Array<{ id: string; kind: string; stage: string; status: string }> | undefined) ?? []} onRollback={props.onRollbackRecovery} onRecover={props.onRecoverJobs} />
      <section className="space-y-2">
        <h3>{props.i18n.t("settings.connections")}</h3>
        <ul className="space-y-2 text-sm">
          {connections.map((connection) => (
            <li key={String(connection.id)} className="border rounded p-2">
              <div>{String(connection.label)} · {String(connection.purpose)} · {String(connection.protocol)} · {String(connection.runtime ?? "native")}</div>
              <div className="text-[var(--color-subtle)]">{String(connection.baseUrl)} · {String(connection.modelId)}</div>
              <div className="flex gap-1 flex-wrap mt-1">
                <button className="border px-2 py-0.5 rounded" onClick={() => setForm({
                  id: String(connection.id),
                  label: String(connection.label),
                  protocol: String(connection.protocol),
                  runtime: String(connection.runtime ?? "native"),
                  baseUrl: String(connection.baseUrl),
                  modelId: String(connection.modelId),
                  purpose: String(connection.purpose),
                  timeoutMs: String(connection.timeoutMs ?? 60_000),
                  secret: "",
                })}>{props.i18n.t("settings.editConnection")}</button>
                <button className="border px-2 py-0.5 rounded" onClick={() => void props.onTestConnection(String(connection.id), connection.purpose === "transcription" ? "transcription" : connection.purpose === "embedding" ? "embedding" : "text")}>{props.i18n.t("settings.testConnection")}</button>
                {connection.purpose === "text" ? (
                  <>
                    <button className="border px-2 py-0.5 rounded" onClick={() => void props.onTestConnection(String(connection.id), "tools")}>{props.i18n.t("settings.testTools")}</button>
                    <button className="border px-2 py-0.5 rounded" onClick={() => void props.onTestConnection(String(connection.id), "streaming")}>{props.i18n.t("settings.testStreaming")}</button>
                  </>
                ) : null}
                <button className="border px-2 py-0.5 rounded" onClick={() => void props.onDeleteConnection(String(connection.id))}>{props.i18n.t("settings.deleteConnection")}</button>
              </div>
            </li>
          ))}
        </ul>
      </section>
      <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); void props.onSaveConnection(form).then(() => setForm(emptyForm())); }}>
        <input className="border w-full p-2 rounded" aria-label={props.i18n.t("settings.baseUrl")} value={form.baseUrl} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} />
        <input className="border w-full p-2 rounded" aria-label={props.i18n.t("settings.modelId")} value={form.modelId} onChange={(event) => setForm({ ...form, modelId: event.target.value })} />
        <input className="border w-full p-2 rounded" type="password" aria-label={props.i18n.t("settings.apiKey")} value={form.secret} onChange={(event) => setForm({ ...form, secret: event.target.value })} />
        <select className="border w-full p-2 rounded" aria-label={props.i18n.t("settings.protocol")} value={form.protocol} onChange={(event) => setForm({ ...form, protocol: event.target.value })}>
          <option value="openai-chat-completions">openai-chat-completions</option>
          <option value="openai-responses">openai-responses</option>
        </select>
        <select className="border w-full p-2 rounded" aria-label={props.i18n.t("settings.purposeText")} value={form.purpose} onChange={(event) => setForm({ ...form, purpose: event.target.value })}>
          <option value="text">{props.i18n.t("settings.purposeText")}</option>
          <option value="transcription">{props.i18n.t("settings.purposeTranscription")}</option>
          <option value="embedding">{props.i18n.t("settings.purposeEmbedding")}</option>
        </select>
        <select className="border w-full p-2 rounded" aria-label={props.i18n.t("settings.runtime")} value={form.runtime} onChange={(event) => setForm({ ...form, runtime: event.target.value })}>
          <option value="native">{props.i18n.t("settings.runtimeNative")}</option>
          <option value="pi">{props.i18n.t("settings.runtimePi")}</option>
        </select>
        <input className="border w-full p-2 rounded" aria-label={props.i18n.t("settings.timeout")} value={form.timeoutMs} onChange={(event) => setForm({ ...form, timeoutMs: event.target.value })} />
        <button className="bg-[var(--color-accent)] text-white px-3 py-1 rounded" type="submit">{props.i18n.t("settings.saveConnection")}</button>
      </form>
      <p className="text-sm text-[var(--color-subtle)]">{props.formatDate(new Date())} · {props.formatNumber(1250)}</p>
    </section>
  );
}
