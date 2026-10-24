import { useEffect, useRef, useState } from "react";
import { NORMALIZATION_V1 } from "@manga/contracts/location";
import type { ReadingStyle } from "../reading.tsx";
import type { ReadingAsset, ReadingDocument } from "../reading.tsx";
import type { Translator } from "@manga/i18n";
import { asArray, call, messageOf, uid as id, type CommandResult } from "../lib/api.ts";
import { announceCommand } from "../lib/lists-changed.ts";
import { relinkNotice, relinkResource } from "../lib/relink.ts";
import type { AgentSelection, Bookmark, SourceCard } from "../lib/types.ts";
import { captureBus } from "../voice/capture-bus.ts";
import { quoteTags } from "../lib/quote-tags.ts";
import { novelDebugOf, readerContext } from "../lib/reader-context.ts";
import { autoAddMaterial } from "../lib/materials.ts";
import { WINDOW_CHARS } from "../reader/pages.ts";
import { pageHolds } from "../reader/page-offsets.ts";

/** A page position is saved once the reader has rested on it this long, so turning through pages is not a write per page. */
const POSITION_SAVE_MS = 600;

export type NovelDeps = {
  i18n: Translator;
  setError: (message?: string) => void;
  setNotice: (message?: string, action?: { label: string; onClick: () => void }) => void;
  /** The context the book is read in: its position, read ranges and materials are that context's (A-96). */
  contextId: string | null;
  /** The tab the reader is in: the Agent and the recorder hear it under this name. */
  tabId: string;
  /** A note is opened in its own tab. */
  openNote: (objectId: string, focusBlockId?: string) => void | Promise<void>;
  refresh: () => Promise<void>;
  /** The reader knows more about what it shows (its work, its title) than the tab was opened with. */
  onFacts?: (facts: { workId: string | null; heading: string }) => void;
};

/** What the title bar says while a book is open: the work's name, and the file's own name after it when the work has several (a folder of chapters). */
export function readerHeading(book: string, work: { title: string; many: boolean } | null): string {
  if (!work) return book;
  return work.many && book && book !== work.title ? `${work.title} ${book}` : work.title;
}

const run = (commandId: string, input: unknown): Promise<CommandResult> => window.manga.command({ commandId, idempotencyKey: id(), input });

/**
 * The novel reader's state in one tab: the open book, its slice, highlights, bookmarks, assets and the note-source round trip.
 * Every await re-checks the request counter, so an answer for a book the reader has already left never lands on screen.
 */
export function useNovel(deps: NovelDeps) {
  const { i18n, setError, setNotice, contextId, tabId, openNote, refresh } = deps;
  const viewRequest = useRef(0);
  const [reading, setReading] = useState<ReadingDocument | null>(null);
  const [hits, setHits] = useState<Array<{ text: string; fragmentId?: string; locator?: { partId: string; range: { start: number; end: number } } }>>([]);
  const [searched, setSearched] = useState(false);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [assetUrls, setAssetUrls] = useState<Record<string, string>>({});
  const [highlight, setHighlight] = useState<{ start: number; end: number } | null>(null);
  const [originalBytes, setOriginalBytes] = useState<Uint8Array | null>(null);
  const [sourceCard, setSourceCard] = useState<SourceCard | null>(null);
  const [returnTo, setReturnTo] = useState<{ objectId: string; blockId: string | null } | null>(null);
  const [agentSelection, setAgentSelection] = useState<AgentSelection | null>(null);
  /** The work the open book belongs to, when it has one: the reader's back goes to its page. */
  const [workId, setWorkId] = useState<string | null>(null);
  /** The work's own name, and whether it has more than one resource: the title bar names the work, not a chapter file. */
  const [work, setWork] = useState<{ title: string; many: boolean } | null>(null);
  const readingRef = useRef<ReadingDocument | null>(null);
  /** The range on screen (a page, or the window when scrolling): progress, bookmarks and the conversation use it (A-115). */
  const [position, setPosition] = useState<{ partId: string; start: number; end: number } | null>(null);
  const positionRef = useRef<{ partId: string; start: number; end: number } | null>(null);
  const positionTimer = useRef<number | null>(null);
  /** The save the timer waits to make: made at once when the reader goes away or the window closes, so the last page turned is not lost. */
  const positionSave = useRef<(() => void) | null>(null);
  /** The position last saved from here; before any, the one the book was opened at. */
  const savedAt = useRef<{ resourceId: string; partId: string; start: number } | null>(null);
  const extending = useRef(false);
  const assetUrlsRef = useRef<Record<string, string>>({});

  // The recorder hears where the book is: the book opening, each new slice, and a selection.
  const announced = useRef<string | null>(null);
  const shownAt = reading?.slice && position?.partId === reading.slice.partId && position.start >= reading.slice.start && position.start <= reading.slice.end
    ? position : reading?.slice ? { partId: reading.slice.partId, start: reading.slice.start, end: reading.slice.end } : null;
  const sliceKey = shownAt ? `${shownAt.partId}:${shownAt.start}:${shownAt.end}` : "";
  useEffect(() => {
    if (!reading?.slice) {
      if (!reading && announced.current) { captureBus.clear(announced.current, tabId); announced.current = null; }
      return;
    }
    const locator = {
      kind: "text" as const, partId: reading.slice.partId, representationId: reading.revisionId, normalizationVersion: NORMALIZATION_V1,
      range: { start: shownAt!.start, end: Math.max(shownAt!.end, shownAt!.start) },
    };
    const changed = announced.current !== reading.resourceId;
    announced.current = reading.resourceId;
    captureBus.emit({ reason: changed ? "resource_change" : "position", resourceId: reading.resourceId, resourceRevisionId: reading.revisionId, locator }, tabId);
  }, [reading?.resourceId, reading?.revisionId, sliceKey]);
  // The right pane's conversation reads where the book is: the part, the window and the opening lines of it.
  useEffect(() => {
    const slice = reading?.slice;
    if (!reading || !slice) return;
    const part = reading.parts.find((entry) => entry.id === slice.partId);
    readerContext.set({
      kind: "novel", resourceId: reading.resourceId, revisionId: reading.revisionId, title: reading.title, workId,
      partId: slice.partId, partTitle: part?.title ?? reading.toc.find((item) => item.partId === slice.partId)?.label ?? "",
      start: shownAt!.start, end: Math.max(shownAt!.end, shownAt!.start), excerpt: [...slice.text].slice(shownAt!.start - slice.start, shownAt!.start - slice.start + 200).join(""),
      debug: novelDebugOf(reading.progress, reading.readRanges, part),
    }, tabId);
  }, [reading?.resourceId, reading?.revisionId, sliceKey, workId, reading?.progress?.restoredFrom, reading?.progress?.restoredRange?.start, reading?.readRanges?.length]);
  useEffect(() => {
    const resourceId = reading?.resourceId;
    return () => { if (resourceId) { readerContext.clear(resourceId, tabId); quoteTags.clearFor(resourceId); } };
  }, [reading?.resourceId]);
  useEffect(() => {
    if (!agentSelection?.partId) return;
    captureBus.emit({
      reason: "selection", resourceId: agentSelection.resourceId, resourceRevisionId: agentSelection.resourceRevisionId,
      locator: {
        kind: "text", partId: agentSelection.partId, representationId: agentSelection.resourceRevisionId, normalizationVersion: NORMALIZATION_V1,
        range: { start: agentSelection.start, end: Math.max(agentSelection.end, agentSelection.start) }, quote: { exact: agentSelection.quote.slice(0, 200) },
      },
    }, tabId);
  }, [agentSelection]);

  // The tab is let go (a reader out of sight beyond the last ones used): the pictures it held are released with it.
  useEffect(() => () => {
    for (const url of Object.values(assetUrlsRef.current)) URL.revokeObjectURL(url);
    assetUrlsRef.current = {};
  }, []);

  function publishReading(next: ReadingDocument | null) {
    readingRef.current = next;
    setReading(next);
  }

  async function openResource(resourceId: string) {
    const request = ++viewRequest.current;
    const result = await run("library.read", { resourceId, contextId });
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
    const touched = await run("works.open", { resourceId });
    if (request !== viewRequest.current) return;
    const ownerWork = touched.status === "ok" ? ((touched.value as { workId?: string | null } | undefined)?.workId ?? null) : null;
    setWorkId(ownerWork);
    const named = ownerWork ? await run("works.get", { workId: ownerWork }) : null;
    if (request !== viewRequest.current) return;
    const info = named?.status === "ok" ? (named.value as { title?: string; resources?: unknown[] } | undefined) : undefined;
    setWork(info?.title ? { title: info.title, many: asArray(info.resources).length > 1 } : null);
    if (document) deps.onFacts?.({ workId: ownerWork, heading: readerHeading(document.title, info?.title ? { title: info.title, many: asArray(info.resources).length > 1 } : null) });
    void autoAddMaterial(contextId, "resource", resourceId);
    await loadBookmarks(resourceId);
    if (request !== viewRequest.current) return;
    if (document) await loadAssets(document, request);
    if (request !== viewRequest.current) return;
    if (document?.format === "pdf") await loadOriginal(document.resourceId, document.revisionId, request);
  }

  async function loadAssets(document: ReadingDocument, request: number) {
    const ids = new Set<string>();
    for (const asset of document.assets ?? []) ids.add(asset.id);
    for (const asset of document.slice?.images ?? []) ids.add(asset.id);
    const urls: Record<string, string> = {};
    for (const assetId of ids) {
      const result = await run("notes.asset", { resourceRevisionId: document.revisionId, assetId });
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
    const result = await run("library.readOriginal", { resourceId, revisionId });
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
    const result = await run("reading.bookmarks", { resourceId });
    setBookmarks(result.status === "ok" ? asArray<Bookmark>(result.value) : []);
  }

  /**
   * Open a chapter from an offset. `quiet` loads a window for the pages to place themselves in: the saved position and the mark stay, and the
   * reader reports the page it shows (`savePosition`).
   */
  async function openSlice(partId: string, start: number, options: { highlight?: { start: number; end: number } | null; revisionId?: string; quiet?: boolean } = {}) {
    const request = viewRequest.current;
    const current = readingRef.current;
    if (!current) return;
    const revisionId = options.revisionId ?? current.revisionId;
    const pdf = current.format === "pdf";
    const sliceStart = pdf ? 0 : start;
    const result = await run("library.readSlice", { resourceId: current.resourceId, revisionId, partId, start: sliceStart, limit: pdf ? 8000 : WINDOW_CHARS });
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
    if (options.quiet) { await loadAssets(next, request); return; }
    setHighlight(options.highlight ?? null);
    // A chapter/page jump is a reading position change even before the reader explicitly marks it read.
    // Save only the position; navigation alone must not expand the Agent's consumed-content scope.
    // Bookmark/search highlights are temporary lookups and retain the saved reading position.
    if (!options.highlight) {
      savedAt.current = { resourceId: next.resourceId, partId, start: next.slice!.start };
      const progress = await window.manga.command({
        commandId: "progress.set", idempotencyKey: id(), input: {
          contextId,
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
      // A book read in "最近" goes to the top of the novels' list there.
      else announceCommand("progress.set", { contextId, resourceId: next.resourceId });
    }
    if (request !== viewRequest.current) return;
    await loadAssets(next, request);
  }

  /** The next window of the chapter, appended to the text already shown: the pages before it stay where they are. */
  async function extendSlice() {
    const current = readingRef.current;
    const slice = current?.slice;
    if (!current || !slice || current.format === "pdf" || extending.current) return;
    const part = current.parts.find((entry) => entry.id === slice.partId);
    if (part && slice.end >= part.length) return;
    const request = viewRequest.current;
    extending.current = true;
    try {
      const result = await run("library.readSlice", { resourceId: current.resourceId, revisionId: current.revisionId, partId: slice.partId, start: slice.end, limit: WINDOW_CHARS });
      if (request !== viewRequest.current || readingRef.current?.slice !== slice) return;
      if (result.status === "error") { setError(result.error?.message); return; }
      const value = result.value as { text?: string; end?: number; images?: ReadingAsset[]; placements?: Array<{ assetId: string; offset: number; width?: number; height?: number }> } | undefined;
      const text = String(value?.text ?? "");
      const end = Number(value?.end ?? slice.end);
      if (!text || end <= slice.end) return;
      const known = new Set((slice.images ?? []).map((image) => image.id));
      const next: ReadingDocument = {
        ...current,
        slice: {
          ...slice,
          text: slice.text + text,
          end,
          images: [...(slice.images ?? []), ...(value?.images ?? []).filter((image) => !known.has(image.id))],
          placements: [...(slice.placements ?? []), ...(value?.placements ?? [])],
        },
      };
      publishReading(next);
      await loadAssets(next, request);
    } finally {
      extending.current = false;
    }
  }

  /** The range the reader shows; saved as the reading position once the reader rests on it. Navigation never widens what was read. */
  function savePosition(partId: string, start: number, end: number) {
    const current = readingRef.current;
    if (!current) return;
    const at = { partId, start, end: Math.max(end, start) };
    positionRef.current = at;
    setPosition(at);
    if (positionTimer.current !== null) window.clearTimeout(positionTimer.current);
    positionTimer.current = null;
    positionSave.current = null;
    // A bookmark, a search hit or a note's source is a lookup: resting on its page keeps the saved reading position, turning away from it moves on from there.
    if (highlight && highlight.start >= at.start && highlight.start <= at.end) return;
    // Still on the page of the saved position (the book was just opened, or laid out anew): it stays exactly where it is.
    const opened = current.progress?.restoredPartId && current.progress.restoredRange ? { partId: current.progress.restoredPartId, start: current.progress.restoredRange.start } : null;
    if (pageHolds(savedAt.current?.resourceId === current.resourceId ? savedAt.current : opened, at)) return;
    const save = () => {
      if (positionTimer.current !== null) window.clearTimeout(positionTimer.current);
      positionTimer.current = null;
      positionSave.current = null;
      savedAt.current = { resourceId: current.resourceId, partId, start: at.start };
      void window.manga.command({
        commandId: "progress.set", idempotencyKey: id(), input: {
          contextId, resourceId: current.resourceId, resourceRevisionId: current.revisionId, consumed: false,
          locator: { kind: "text", partId, representationId: current.revisionId, normalizationVersion: NORMALIZATION_V1, range: { start: at.start, end: at.end } },
        },
      }).then((saved) => {
        if (saved.status === "error") setError(saved.error?.message);
        else announceCommand("progress.set", { contextId, resourceId: current.resourceId });
      });
    };
    positionSave.current = save;
    positionTimer.current = window.setTimeout(save, POSITION_SAVE_MS);
  }
  // A page turned just before the reader closes (or the window does) is still saved: the waiting save is made at once, not dropped.
  useEffect(() => {
    const now = () => positionSave.current?.();
    window.addEventListener("pagehide", now);
    return () => { window.removeEventListener("pagehide", now); now(); };
  }, []);

  /** The page on screen when it is in the open slice, else the slice itself. */
  function shownRange(slice: NonNullable<ReadingDocument["slice"]>) {
    const at = positionRef.current;
    return at && at.partId === slice.partId && at.start >= slice.start && at.start <= slice.end ? at : { partId: slice.partId, start: slice.start, end: slice.end };
  }

  async function markProgress() {
    if (!reading?.slice) return;
    // What was read reaches the end of the page on screen, not the end of the loaded window (the Agent's read range, A-96).
    const shown = shownRange(reading.slice);
    const exact = reading.slice.text.slice(0, 32);
    const result = await window.manga.command({
      commandId: "progress.set",
      idempotencyKey: id(),
      input: {
        contextId,
        resourceId: reading.resourceId,
        resourceRevisionId: reading.revisionId,
        consumed: true,
        locator: {
          kind: "text",
          partId: reading.slice.partId,
          representationId: reading.revisionId,
          normalizationVersion: NORMALIZATION_V1,
          range: { start: reading.slice.start, end: Math.max(shown.end, reading.slice.start) },
          quote: { exact },
        },
      },
    });
    if (result.status === "error") { setError(result.error?.message); return; }
    // The range above is what was read, from the start of the window; the reader stays on the page on screen, so that page is the position it reopens at.
    const position = await window.manga.command({
      commandId: "progress.set",
      idempotencyKey: id(),
      input: {
        contextId,
        resourceId: reading.resourceId,
        resourceRevisionId: reading.revisionId,
        consumed: false,
        locator: { kind: "text", partId: reading.slice.partId, representationId: reading.revisionId, normalizationVersion: NORMALIZATION_V1, range: { start: shown.start, end: Math.max(shown.end, shown.start) } },
      },
    });
    if (position.status === "error") { setError(position.error?.message); return; }
    savedAt.current = { resourceId: reading.resourceId, partId: reading.slice.partId, start: shown.start };
    setNotice(i18n.t("reading.progress"));
    await openResource(reading.resourceId);
  }

  /**
   * A passage picked in the book. The reader only reads: the passage becomes a quote tag in the right pane's input (a note anchored
   * at it, or a question about it, is decided there) and is announced to the recorder as the place being talked about.
   */
  function selectText(quote: string, start: number, end: number, partId: string) {
    if (!reading || !quote.trim()) return;
    const selection: AgentSelection = { resourceId: reading.resourceId, resourceRevisionId: reading.revisionId, partId, start, end: Math.max(end, start), quote };
    setAgentSelection(selection);
    quoteTags.put({
      kind: "selection", resourceId: reading.resourceId, revisionId: reading.revisionId, partId, start: selection.start, end: selection.end, quote,
      label: i18n.t("chat.tag.selection", { count: Math.max(1, [...quote].length) }),
    });
  }

  async function openNoteSource(objectId: string, blockId?: string) {
    const request = ++viewRequest.current;
    const result = await run("notes.openSource", { objectId, blockId });
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
      const read = await run("library.read", { resourceId: value.resourceId, revisionId: value.resourceRevisionId, contextId });
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
          const sliceResult = await run("library.readSlice", { resourceId: value.resourceId, revisionId: value.resourceRevisionId, partId, start: sliceStart, limit: pdf ? 8000 : Math.max(600, range.end - range.start + 400) });
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
  }

  async function backToNote() {
    if (returnTo?.objectId) await openNote(returnTo.objectId, returnTo.blockId ?? undefined);
    setSourceCard(null);
    setReturnTo(null);
  }

  /** Re-point a stale note source at the file the user picks, using the existing resource identity. */
  async function repairNoteSource() {
    const resourceId = sourceCard?.resourceId ?? reading?.resourceId;
    if (!resourceId) { setError(i18n.t("reading.sourceRepairFailed")); return; }
    const outcome = await relinkResource(resourceId);
    if (outcome.kind === "cancelled") return;
    // A quote that has no single home in the new file stays unrepaired, and the user is told how many.
    const shown = relinkNotice(i18n.t, outcome, () => void repairNoteSource());
    if (shown.error) { setError(shown.error); return; }
    setNotice(shown.notice, shown.action);
    setError(undefined);
    // A folder that is no library path yet: nothing was changed, and the notice offers adding it.
    if (outcome.kind !== "done") return;
    await openResource(resourceId);
    if (returnTo?.objectId) {
      await openNoteSource(returnTo.objectId, returnTo.blockId ?? undefined);
    }
    await refresh();
  }

  async function addBookmark() {
    if (!reading?.slice) return;
    // The page on screen is marked: its first character, and a readable stretch after it.
    const shown = shownRange(reading.slice);
    const start = shown.start;
    const end = Math.min(reading.slice.end, start + 120);
    const from = [...reading.slice.text].slice(start - reading.slice.start).join("");
    const result = await window.manga.command({
      commandId: "reading.setBookmark",
      idempotencyKey: id(),
      input: {
        resourceId: reading.resourceId,
        resourceRevisionId: reading.revisionId,
        label: `${reading.slice.partId} · ${[...from].slice(0, 20).join("")}`,
        locator: {
          kind: "text",
          partId: reading.slice.partId,
          representationId: reading.revisionId,
          normalizationVersion: NORMALIZATION_V1,
          range: { start, end: Math.max(end, start) },
          quote: { exact: from.slice(0, 32) },
        },
      },
    });
    if (result.status === "error") { setError(result.error?.message); return; }
    await loadBookmarks(reading.resourceId);
  }

  async function removeBookmark(bookmarkId: string) {
    const result = await run("reading.removeBookmark", { bookmarkId });
    if (result.status === "error") { setError(result.error?.message); return; }
    if (reading) await loadBookmarks(reading.resourceId);
  }

  async function openBookmark(bookmark: Bookmark) {
    // Opening a bookmark restores the position but does not mark the range read.
    const partId = bookmark.locator.partId;
    if (!partId) return;
    await openSlice(partId, Math.max(0, (bookmark.locator.range?.start ?? 0) - 100), { highlight: bookmark.locator.range ?? null, revisionId: bookmark.resourceRevisionId });
  }

  /** Leave the book: release its object URLs and drop anything still in flight for it. */
  function closeReader() {
    viewRequest.current += 1;
    for (const url of Object.values(assetUrlsRef.current)) URL.revokeObjectURL(url);
    assetUrlsRef.current = {};
    setAssetUrls({});
    publishReading(null);
    positionRef.current = null;
    setPosition(null);
    setHighlight(null);
    setOriginalBytes(null);
    setSourceCard(null);
    setReturnTo(null);
    setHits([]);
    setSearched(false);
    setAgentSelection(null);
    setBookmarks([]);
    setWorkId(null);
    setWork(null);
  }

  async function search(text: string) {
    const result = await run("library.find", { text, resourceId: reading?.resourceId });
    setSearched(true);
    setHits(result.status === "ok" ? asArray(result.value) : []);
  }

  async function saveStyle(patch: Partial<ReadingStyle>) {
    try {
      await call("settings.setShell", { reading: patch });
    } catch (error) {
      setError(messageOf(error));
      return;
    }
    await refresh();
  }

  return {
    reading, hits, searched, bookmarks, assetUrls, highlight, originalBytes, sourceCard, returnTo, agentSelection, workId, work,
    setAgentSelection,
    openResource, openSlice, extendSlice, savePosition, markProgress, selectText, openNoteSource, backToNote, repairNoteSource,
    addBookmark, removeBookmark, openBookmark, closeReader, search, saveStyle,
  };
}
