import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { NORMALIZATION_V1 } from "@manga/contracts/location";
import type { ReadingStyle } from "../reading.tsx";
import type { ReadingAsset, ReadingDocument } from "../reading.tsx";
import type { Translator } from "@manga/i18n";
import { asArray, call, messageOf, uid as id, type CommandResult } from "../lib/api.ts";
import type { AgentSelection, Bookmark, SourceCard } from "../lib/types.ts";
import { captureBus } from "../voice/capture-bus.ts";
import { quoteTags } from "../lib/quote-tags.ts";
import { readerContext } from "../lib/reader-context.ts";

export type NovelDeps = {
  i18n: Translator;
  setError: (message?: string) => void;
  setNotice: (message?: string) => void;
  setPage: (page: string) => void;
  /** Shared with the Agent pane so a stale answer for a book that is no longer open is dropped by both. */
  viewRequest: MutableRefObject<number>;
  ensureBoundSession: (kind: "resource" | "project" | "note", targetId: string, request?: number) => Promise<string | undefined>;
  openNote: (objectId: string, focusBlockId?: string) => Promise<void>;
  refresh: () => Promise<void>;
};

const run = (commandId: string, input: unknown): Promise<CommandResult> => window.manga.command({ commandId, idempotencyKey: id(), input });

/**
 * The novel reader's state: the open book, its slice, highlights, bookmarks, assets and the note-source round trip.
 * Every await re-checks `viewRequest`, so an answer for a book the reader has already left never lands on screen.
 */
export function useNovel(deps: NovelDeps) {
  const { i18n, setError, setNotice, setPage, viewRequest, ensureBoundSession, openNote, refresh } = deps;
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
  const [visible, setVisible] = useState(false);
  /** The work the open book belongs to, when it has one: the reader's back goes to its page. */
  const [workId, setWorkId] = useState<string | null>(null);
  const readingRef = useRef<ReadingDocument | null>(null);
  const assetUrlsRef = useRef<Record<string, string>>({});

  // The recorder hears where the book is: the book opening, each new slice, and a selection.
  const announced = useRef<string | null>(null);
  const sliceKey = reading?.slice ? `${reading.slice.partId}:${reading.slice.start}:${reading.slice.end}` : "";
  useEffect(() => {
    if (!reading?.slice) {
      if (!reading && announced.current) { captureBus.clear(announced.current); announced.current = null; }
      return;
    }
    const locator = {
      kind: "text" as const, partId: reading.slice.partId, representationId: reading.revisionId, normalizationVersion: NORMALIZATION_V1,
      range: { start: reading.slice.start, end: Math.max(reading.slice.end, reading.slice.start) },
    };
    const changed = announced.current !== reading.resourceId;
    announced.current = reading.resourceId;
    captureBus.emit({ reason: changed ? "resource_change" : "position", resourceId: reading.resourceId, resourceRevisionId: reading.revisionId, locator });
  }, [reading?.resourceId, reading?.revisionId, sliceKey]);
  // The right pane's conversation reads where the book is: the part, the window and the opening lines of it.
  useEffect(() => {
    const slice = reading?.slice;
    if (!reading || !slice) return;
    const part = reading.parts.find((entry) => entry.id === slice.partId);
    readerContext.set({
      kind: "novel", resourceId: reading.resourceId, revisionId: reading.revisionId, title: reading.title, workId,
      partId: slice.partId, partTitle: part?.title ?? reading.toc.find((item) => item.partId === slice.partId)?.label ?? "",
      start: slice.start, end: Math.max(slice.end, slice.start), excerpt: [...slice.text].slice(0, 200).join(""),
    });
  }, [reading?.resourceId, reading?.revisionId, sliceKey, workId]);
  useEffect(() => {
    const resourceId = reading?.resourceId;
    return () => { if (resourceId) { readerContext.clear(resourceId); quoteTags.clearFor(resourceId); } };
  }, [reading?.resourceId]);
  useEffect(() => {
    if (!agentSelection?.partId) return;
    captureBus.emit({
      reason: "selection", resourceId: agentSelection.resourceId, resourceRevisionId: agentSelection.resourceRevisionId,
      locator: {
        kind: "text", partId: agentSelection.partId, representationId: agentSelection.resourceRevisionId, normalizationVersion: NORMALIZATION_V1,
        range: { start: agentSelection.start, end: Math.max(agentSelection.end, agentSelection.start) }, quote: { exact: agentSelection.quote.slice(0, 200) },
      },
    });
  }, [agentSelection]);

  function publishReading(next: ReadingDocument | null) {
    readingRef.current = next;
    setReading(next);
    // An opened book is shown in the reader, whichever route opened it.
    if (next) setVisible(true);
  }


  async function openResource(resourceId: string) {
    const request = ++viewRequest.current;
    const result = await run("library.read", { resourceId });
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
    setWorkId(touched.status === "ok" ? ((touched.value as { workId?: string | null } | undefined)?.workId ?? null) : null);
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

  async function openSlice(partId: string, start: number, options: { highlight?: { start: number; end: number } | null; revisionId?: string } = {}) {
    const request = viewRequest.current;
    const current = readingRef.current;
    if (!current) return;
    const revisionId = options.revisionId ?? current.revisionId;
    const pdf = current.format === "pdf";
    const sliceStart = pdf ? 0 : start;
    const result = await run("library.readSlice", { resourceId: current.resourceId, revisionId, partId, start: sliceStart, limit: pdf ? 8000 : 4000 });
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
      await ensureBoundSession("resource", value.resourceId, request);
      if (request !== viewRequest.current) return;
      const read = await run("library.read", { resourceId: value.resourceId, revisionId: value.resourceRevisionId });
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
    const result = await run("library.repairSource", { resourceId, pathHandle: handle });
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
    setHighlight(null);
    setOriginalBytes(null);
    setSourceCard(null);
    setReturnTo(null);
    setHits([]);
    setSearched(false);
    setAgentSelection(null);
    setBookmarks([]);
    setWorkId(null);
    setVisible(false);
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
    reading, hits, searched, bookmarks, assetUrls, highlight, originalBytes, sourceCard, returnTo, agentSelection, visible, workId,
    setAgentSelection, setVisible,
    openResource, openSlice, markProgress, selectText, openNoteSource, backToNote, repairNoteSource,
    addBookmark, removeBookmark, openBookmark, closeReader, search, saveStyle,
  };
}

export type Novel = ReturnType<typeof useNovel>;
