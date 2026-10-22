import { useEffect, useRef, useState } from "react";
import type { Translator } from "@manga/i18n";
import { asArray, attempt } from "../lib/api.ts";
import { relinkNotice, relinkResource } from "../lib/relink.ts";
import { autoAddMaterial } from "../lib/materials.ts";
import { mediaPrefs } from "../lib/media-prefs.ts";
import type { Elsewhere } from "../workspace/elsewhere.ts";
import type { SourceCard } from "../lib/types.ts";
import type { Region } from "../readers/comic-model.ts";
import type { ComicDoc, ComicFocus, ComicSettings } from "../readers/comic-reader.tsx";

export type ComicDeps = {
  i18n: Translator;
  setError: (message?: string) => void;
  setNotice: (message?: string, action?: { label: string; onClick: () => void }) => void;
  /** The context the book is read in: its position and read pages are that context's (A-96). */
  contextId: string | null;
  tabId: string;
  openNote: (objectId: string, focusBlockId?: string) => void | Promise<void>;
  refresh: () => Promise<void>;
  /** The reader knows more about what it shows than the tab was opened with. */
  onFacts?: (facts: { workId: string | null; heading: string }) => void;
};

export const DEFAULT_COMIC_SETTINGS: ComicSettings = { direction: "rtl", layout: "single", coverAlone: true, fit: "page", zoom: 1, autoFlipSeconds: 0, animation: "fade" };

type OpenOptions = {
  revisionId?: string;
  workId?: string | null;
  focus?: { pageId: string; region?: Region };
  card?: SourceCard | null;
  returnTo?: { objectId: string; blockId: string | null } | null;
};

/** The note-source facts a jump into a page needs. */
export type ImageSource = {
  resourceId?: string;
  resourceRevisionId?: string;
  status?: string;
  locator?: { kind: "image"; pageId: string; region?: Region };
  card?: SourceCard;
  returnTo?: { objectId: string; blockId: string | null };
};

/**
 * The comic reader's state in one tab: the open book, the reader settings, where to start, and the round trip
 * to a note. Every await re-checks the request counter, so an answer for a book the reader has already left is dropped.
 */
export function useComic(deps: ComicDeps) {
  const { i18n, setError, setNotice, contextId, openNote, refresh } = deps;
  const viewRequest = useRef(0);
  /** Where another context has been in this book when this one has not started, for the offer to jump there. */
  const [elsewhere, setElsewhere] = useState<Elsewhere | null>(null);
  const [doc, setDoc] = useState<ComicDoc | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [startPageId, setStartPageId] = useState<string | null>(null);
  const [settings, setSettings] = useState<ComicSettings>(DEFAULT_COMIC_SETTINGS);
  // The saved preferences are also shown in settings, before any comic has been opened.
  useEffect(() => {
    let cancelled = false;
    void attempt<{ comic?: Partial<ComicSettings> }>("settings.getMedia").then((saved) => {
      if (!cancelled && saved.ok && saved.value.comic) setSettings({ ...DEFAULT_COMIC_SETTINGS, ...saved.value.comic });
    });
    return () => { cancelled = true; };
  }, []);
  // The settings page and the other comic tabs change the same preferences; this reader follows them.
  useEffect(() => mediaPrefs.subscribe((kind, patch) => { if (kind === "comic") setSettings((current) => ({ ...current, ...patch })); }), []);
  const [focus, setFocus] = useState<ComicFocus | null>(null);
  const [sourceCard, setSourceCard] = useState<SourceCard | null>(null);
  const [returnTo, setReturnTo] = useState<{ objectId: string; blockId: string | null } | null>(null);
  const workId = useRef<string | null>(null);
  const docRef = useRef<ComicDoc | null>(null);
  const nonce = useRef(0);
  const progressChain = useRef<Promise<void>>(Promise.resolve());
  /** The last page the reader recorded: a reader mounted again starts there, not at the page the book was opened at. */
  const reached = useRef<{ resourceId: string; pageId: string } | null>(null);

  async function open(resourceId: string, options: OpenOptions = {}) {
    const request = ++viewRequest.current;
    setStatus("loading");
    setError(undefined);
    const pages = await attempt<{ resourceId: string; revisionId: string; title: string; direction: "ltr" | "rtl" | null; available: boolean; warnings: string[]; pages: ComicDoc["pages"] }>("comic.pages", { resourceId, revisionId: options.revisionId });
    if (request !== viewRequest.current) return;
    if (!pages.ok) {
      setStatus("error");
      setDoc(null);
      docRef.current = null;
      setError(pages.error.message);
      return;
    }
    const value = pages.value;
    const loaded: ComicDoc = {
      resourceId: value.resourceId,
      revisionId: value.revisionId,
      title: value.title,
      direction: value.direction === "ltr" || value.direction === "rtl" ? value.direction : null,
      available: value.available !== false,
      warnings: asArray<string>(value.warnings),
      pages: asArray<ComicDoc["pages"][number]>(value.pages),
    };
    const [saved, progress, touched] = await Promise.all([
      attempt<{ comic?: Partial<ComicSettings> }>("settings.getMedia"),
      attempt<{ locator: { kind?: string; pageId?: string } | null; completion?: string; elsewhere?: Elsewhere | null }>("progress.get", { contextId, resourceId, resourceRevisionId: value.revisionId }),
      attempt<{ workId: string | null }>("works.open", { resourceId }),
    ]);
    if (request !== viewRequest.current) return;
    if (saved.ok && saved.value.comic) setSettings({ ...DEFAULT_COMIC_SETTINGS, ...saved.value.comic });
    // A finished book starts again from its first page; an unfinished one resumes where it was left.
    const locator = progress.ok ? progress.value.locator : null;
    const last = loaded.pages[loaded.pages.length - 1]?.id;
    const resume = locator?.kind === "image" && locator.pageId && loaded.pages.some((page) => page.id === locator.pageId) ? locator.pageId : null;
    const finished = progress.ok && progress.value.completion === "completed" && resume === last;
    setStartPageId(options.focus ? options.focus.pageId : finished ? null : resume);
    setElsewhere(progress.ok && !options.focus ? progress.value.elsewhere ?? null : null);
    reached.current = null;
    workId.current = options.workId ?? (touched.ok ? touched.value.workId : null) ?? null;
    loaded.workId = workId.current;
    docRef.current = loaded;
    setDoc(loaded);
    setSourceCard(options.card ?? null);
    setReturnTo(options.returnTo ?? null);
    setFocus(options.focus ? { ...options.focus, nonce: ++nonce.current } : null);
    setStatus("ready");
    deps.onFacts?.({ workId: workId.current, heading: loaded.title });
    void autoAddMaterial(contextId, "resource", loaded.resourceId);
  }

  /** A note's source on a page: open that book at that page, with the region it framed. */
  async function openFromNote(value: ImageSource, objectId: string, blockId?: string) {
    if (!value.resourceId || value.locator?.kind !== "image") return;
    const locator = value.locator;
    await open(value.resourceId, {
      revisionId: value.resourceRevisionId,
      focus: { pageId: locator.pageId, ...(locator.region ? { region: locator.region } : {}) },
      card: value.card ?? { status: value.status ?? "unresolved" },
      returnTo: value.returnTo ?? { objectId, blockId: blockId ?? null },
    });
  }

  function close() {
    viewRequest.current += 1;
    docRef.current = null;
    reached.current = null;
    setDoc(null);
    setStatus("idle");
    setSourceCard(null);
    setReturnTo(null);
    setFocus(null);
    setElsewhere(null);
  }

  /** The reader went to the page a note pointed at; a reader mounted again must not go there a second time. */
  function focusApplied(focusNonce: number) {
    setFocus((current) => (current && current.nonce === focusNonce && !current.applied ? { ...current, applied: true } : current));
  }

  async function backToNote() {
    if (returnTo?.objectId) await openNote(returnTo.objectId, returnTo.blockId ?? undefined);
    setSourceCard(null);
    setReturnTo(null);
    setFocus(null);
  }

  /** Re-point a stale source at the file the user picks; the resource identity and its notes stay. */
  async function repair() {
    const current = docRef.current;
    if (!current) return;
    const outcome = await relinkResource(current.resourceId);
    if (outcome.kind === "cancelled") return;
    const shown = relinkNotice(i18n.t, outcome, () => void repair());
    if (shown.error) { setError(shown.error); return; }
    setNotice(shown.notice, shown.action);
    // A folder that is no library path yet: nothing was changed, and the notice offers adding it.
    if (outcome.kind !== "done") return;
    await open(current.resourceId, { revisionId: current.revisionId, card: sourceCard, returnTo, focus: focus ? { pageId: focus.pageId, region: focus.region } : undefined });
    await refresh();
  }

  function changeSettings(patch: Partial<ComicSettings>) {
    setSettings((current) => ({ ...current, ...patch }));
    mediaPrefs.publish("comic", patch);
    void attempt("settings.setMedia", { comic: patch }).then((result) => { if (!result.ok) setError(result.error.message); });
  }

  /** The pages now on screen count as read. Writes go one after another so the last page wins as the saved position. */
  function recordPages(pageIds: string[], consumed = true, book?: { resourceId: string; revisionId: string }) {
    const current = book ?? docRef.current;
    if (!current || !pageIds.length) return;
    const { resourceId, revisionId } = current;
    reached.current = { resourceId, pageId: pageIds[pageIds.length - 1]! };
    progressChain.current = progressChain.current.then(async () => {
      for (const pageId of pageIds) {
        const result = await attempt("progress.setPage", { contextId, resourceId, resourceRevisionId: revisionId, pageId, consumed });
        if (!result.ok) { setError(result.error.message); return; }
      }
    });
  }

  /** Resolves once every position written so far is saved. */
  const settled = () => progressChain.current;

  const resumePageId = reached.current && doc && reached.current.resourceId === doc.resourceId ? reached.current.pageId : startPageId;

  return { doc, status, elsewhere, dismissElsewhere: () => setElsewhere(null), startPageId: resumePageId, focusApplied, settings, focus, sourceCard, visible: doc !== null, open, openFromNote, close, backToNote, repair, changeSettings, recordPages, settled };
}

export type Comic = ReturnType<typeof useComic>;
