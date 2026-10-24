import { useEffect, useRef, useState } from "react";
import { readingLabels } from "../../lib/labels.ts";
import { DEFAULT_SHELL_PREFERENCE, type ReadingStylePatch } from "@manga/contracts/reading";
import { AddToRoughcut } from "../../components/add-to-roughcut.tsx";
import { useComic } from "../../hooks/use-comic.ts";
import { readerHeading, useNovel } from "../../hooks/use-novel.ts";
import { useVideo } from "../../hooks/use-video.ts";
import { useWorkLinked } from "../../lib/use-work-linked.ts";
import { ReadingPane } from "../../reading.tsx";
import { ComicReader } from "../../readers/comic-reader.tsx";
import { VideoPlayer } from "../../readers/video-player.tsx";
import { str } from "../model.ts";
import { ElsewhereBar } from "../elsewhere-bar.tsx";
import type { Elsewhere } from "../elsewhere.ts";
import { useServices } from "../services.tsx";
import { useTabEnv, type TabEnv } from "../tab-env.tsx";
import { useWorkspaceValue } from "../context.tsx";

type Locator = { kind?: string; pageId?: string; region?: unknown; startMs?: number; endMs?: number; partId?: string; range?: { start: number; end: number } };
type Launched = {
  anchor?: { resourceId: string; resourceRevisionId: string | null; locator: Locator };
  fromNote?: { probe: never; objectId: string; blockId: string | null };
};

function Loading(props: { text: string; testId: string }) {
  return <p className="page-pad detail-muted" role="status" data-testid={props.testId}>{props.text}</p>;
}

/**
 * A reader tab (A-95). The tab holds the resource; the content — the book, the pages, the video — is made while the tab is in view or among the last
 * readers used, and let go after that, so ten open readers cost what three do. Coming back loads it again at the saved place.
 */
export function ReaderTab() {
  const env = useTabEnv();
  const s = useServices();
  const loaded = useWorkspaceValue((controller) => controller.isMounted(env.key, env.tabId));
  if (!env.model) return null;
  if (!loaded) return <Loading text={s.t("status.loading")} testId="reader-unloaded" />;
  const kind = str(env.model.target.mediaKind);
  return kind === "comic" ? <ComicBody env={env} /> : kind === "video" ? <VideoBody env={env} /> : <NovelBody env={env} />;
}

/** The facts a reader learns about its book are written back to the tab: the work it belongs to, and a name for the tab. */
function useFacts(env: TabEnv) {
  return (facts: { workId: string | null; heading: string }) => {
    env.controller.retarget(env.tabId, { workId: facts.workId });
    if (facts.heading) env.controller.retitle(env.tabId, facts.heading);
  };
}

function NovelBody({ env }: { env: TabEnv }) {
  const s = useServices();
  const { i18n, t } = s;
  const resourceId = str(env.model?.target.resourceId);
  const novel = useNovel({ i18n, setError: s.setError, setNotice: s.setNotice, contextId: env.contextId, tabId: env.tabId, openNote: s.open.note, refresh: s.refresh, onFacts: useFacts(env) });
  const novelRef = useRef(novel);
  novelRef.current = novel;
  const loadedFor = useRef<string | null>(null);
  useEffect(() => {
    const launch = env.takeLaunch() as (Launched & { n: number }) | undefined;
    void (async () => {
      const book = novelRef.current;
      if (launch?.fromNote) {
        loadedFor.current = resourceId;
        await book.openNoteSource(launch.fromNote.objectId, launch.fromNote.blockId ?? undefined);
        return;
      }
      if (loadedFor.current !== resourceId) { loadedFor.current = resourceId; await book.openResource(resourceId); }
      const locator = launch?.anchor?.locator;
      if (locator?.partId) await novelRef.current.openSlice(locator.partId, Math.max(0, (locator.range?.start ?? 0) - 100), { highlight: locator.range ?? null, revisionId: launch?.anchor?.resourceRevisionId ?? undefined });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resourceId, env.launchN]);

  const linked = useWorkLinked(novel.workId, s.facets.has("metadata"), s.matchVersion);
  const onMatch = novel.workId && linked === false ? () => s.openMatch(novel.workId!) : undefined;
  const reading = novel.reading;
  const [elsewhere, dismissed] = useDismissable<Elsewhere>((reading as { elsewhere?: Elsewhere | null } | null)?.elsewhere ?? null, reading?.resourceId);
  // The book's author style applies only while the reader keeps the built-in defaults; any saved preference means the user's own choice wins.
  const styleIsDefault = JSON.stringify(s.shell.reading) === JSON.stringify(DEFAULT_SHELL_PREFERENCE.reading);
  const authorStyle = styleIsDefault ? ((reading as { authorStyle?: Record<string, unknown> } | null)?.authorStyle ?? null) : null;

  if (!reading) return <Loading text={t("status.loading")} testId="reader-loading" />;
  return (
    <div className="tab-reader" data-testid="tab-reader-novel">
      {elsewhere ? <ElsewhereBar t={t} elsewhere={elsewhere} onJump={() => { dismissed(); void jumpTo(s, resourceId, elsewhere.locator); }} onDismiss={dismissed} /> : null}
      <ReadingPane
        document={{ ...reading, authorStyle } as never}
        style={{ ...s.shell.reading }}
        hits={novel.hits}
        bookmarks={novel.bookmarks}
        assets={novel.assetUrls}
        originalBytes={novel.originalBytes}
        highlight={novel.highlight}
        sourceCard={novel.sourceCard}
        onBackToNote={() => void novel.backToNote()}
        onRepair={() => void novel.repairNoteSource()}
        onMatch={onMatch}
        labelsExtra={{ sourceNeedsReview: t("reading.sourceNeedsReview"), sourceMissing: t("reading.sourceMissing"), sourceRepair: t("reading.sourceRepair") }}
        t={t}
        labels={readingLabels(i18n)}
        searched={novel.searched}
        onSearch={(text) => void novel.search(text)}
        onJump={(partId, start, end) => {
          // A hit is pinned to the revision it was found in, which may not be the open one.
          const hit = novel.hits.find((entry) => entry.locator?.partId === partId && entry.locator.range.start === start) as { revisionId?: string } | undefined;
          void novel.openSlice(partId, Math.max(0, start - 200), { highlight: { start, end: Math.max(end, start) }, revisionId: hit?.revisionId });
        }}
        onProgress={() => void novel.markProgress()}
        onSelect={(quote, start, end, partId) => novel.selectText(quote, start, end, partId)}
        onMore={(partId, start) => void novel.openSlice(partId, start)}
        onPart={(partId, start) => void novel.openSlice(partId, start)}
        onStyle={(patch) => void s.saveReadingStyle(patch as ReadingStylePatch)}
        onBookmark={() => void novel.addBookmark()}
        onRemoveBookmark={(bookmarkId) => void novel.removeBookmark(bookmarkId)}
        onOpenBookmark={(bookmark) => void novel.openBookmark(bookmark as never)}
      />
    </div>
  );
}

function ComicBody({ env }: { env: TabEnv }) {
  const s = useServices();
  const { i18n, t } = s;
  const resourceId = str(env.model?.target.resourceId);
  const workId = str(env.model?.target.workId) || null;
  const comic = useComic({ i18n, setError: s.setError, setNotice: s.setNotice, contextId: env.contextId, tabId: env.tabId, openNote: s.open.note, refresh: s.refresh, onFacts: useFacts(env) });
  const comicRef = useRef(comic);
  comicRef.current = comic;
  const loadedFor = useRef<string | null>(null);
  useEffect(() => {
    const launch = env.takeLaunch() as (Launched & { n: number }) | undefined;
    void (async () => {
      const book = comicRef.current;
      if (launch?.fromNote) {
        loadedFor.current = resourceId;
        await book.openFromNote(launch.fromNote.probe, launch.fromNote.objectId, launch.fromNote.blockId ?? undefined);
        return;
      }
      const at = launch?.anchor?.locator;
      if (at?.pageId) {
        loadedFor.current = resourceId;
        await book.open(resourceId, { revisionId: launch?.anchor?.resourceRevisionId ?? undefined, focus: { pageId: at.pageId, ...(at.region ? { region: at.region as never } : {}) } });
        return;
      }
      if (loadedFor.current !== resourceId) { loadedFor.current = resourceId; await book.open(resourceId, { workId }); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resourceId, env.launchN]);

  const doc = comic.doc;
  const linked = useWorkLinked(doc?.workId ?? null, s.facets.has("metadata"), s.matchVersion);
  const onMatch = doc?.workId && linked === false ? () => s.openMatch(doc.workId!) : undefined;
  const [elsewhere, dismissed] = useDismissable<Elsewhere>(comic.elsewhere, doc?.resourceId);
  if (!doc) return <Loading text={t("status.loading")} testId="page-comic-loading" />;
  return (
    <div className="tab-reader" data-testid="tab-reader-comic">
      {elsewhere ? <ElsewhereBar t={t} elsewhere={elsewhere} onJump={() => { dismissed(); void jumpTo(s, doc.resourceId, elsewhere.locator); }} onDismiss={dismissed} /> : null}
      <ComicReader
        key={`${doc.resourceId}:${doc.revisionId}`}
        t={t}
        doc={doc}
        settings={comic.settings}
        onSettings={comic.changeSettings}
        startPageId={comic.startPageId}
        focus={comic.focus}
        onFocusApplied={comic.focusApplied}
        sourceCard={comic.sourceCard}
        onMatch={onMatch}
        onBack={() => env.controller.closeTab(env.tabId)}
        onPage={comic.recordPages}
        onBackToNote={() => void comic.backToNote()}
        onRepair={() => void comic.repair()}
        screenshots={s.screenshots}
      />
    </div>
  );
}

function VideoBody({ env }: { env: TabEnv }) {
  const s = useServices();
  const { i18n, t } = s;
  const resourceId = str(env.model?.target.resourceId);
  const workId = str(env.model?.target.workId) || null;
  const video = useVideo({ i18n, setError: s.setError, setNotice: s.setNotice, contextId: env.contextId, tabId: env.tabId, openNote: s.open.note, refresh: s.refresh, onFacts: useFacts(env) });
  const videoRef = useRef(video);
  videoRef.current = video;
  const loadedFor = useRef<string | null>(null);
  useEffect(() => {
    const launch = env.takeLaunch() as (Launched & { n: number }) | undefined;
    void (async () => {
      const player = videoRef.current;
      if (launch?.fromNote) {
        loadedFor.current = resourceId;
        await player.openFromNote(launch.fromNote.probe, launch.fromNote.objectId, launch.fromNote.blockId ?? undefined);
        return;
      }
      const at = launch?.anchor?.locator;
      if (at && at.kind === "temporal" && typeof at.startMs === "number") {
        loadedFor.current = resourceId;
        await player.open(resourceId, { revisionId: launch?.anchor?.resourceRevisionId ?? undefined, focus: { startMs: at.startMs, ...(at.endMs !== undefined ? { endMs: at.endMs } : {}) } });
        return;
      }
      if (loadedFor.current !== resourceId) { loadedFor.current = resourceId; await player.open(resourceId, { workId }); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resourceId, env.launchN]);

  const doc = video.doc;
  const linked = useWorkLinked(doc?.workId ?? null, s.facets.has("metadata"), s.matchVersion);
  const onMatch = doc?.workId && linked === false ? () => s.openMatch(doc.workId!) : undefined;
  const [elsewhere, dismissed] = useDismissable<Elsewhere>(video.elsewhere, doc?.resourceId);
  if (!doc) return <Loading text={t("status.loading")} testId="page-video-loading" />;
  return (
    <div className="tab-reader" data-testid="tab-reader-video">
      {elsewhere ? <ElsewhereBar t={t} elsewhere={elsewhere} onJump={() => { dismissed(); void jumpTo(s, doc.resourceId, elsewhere.locator); }} onDismiss={dismissed} /> : null}
      <VideoPlayer
        key={`${doc.resourceId}:${doc.revisionId}`}
        t={t}
        doc={doc}
        settings={video.settings}
        onSettings={video.changeSettings}
        startMs={video.startMs}
        focus={video.focus}
        onFocusApplied={video.focusApplied}
        sourceCard={video.sourceCard}
        next={video.next}
        onMatch={onMatch}
        onBack={() => env.controller.closeTab(env.tabId)}
        onNext={() => { const next = video.next; if (next) void s.open.episode(env.tabId, next.resourceId); }}
        onEpisode={(episode) => void s.open.episode(env.tabId, episode)}
        onProgress={video.recordProgress}
        onBackToNote={() => void video.backToNote()}
        onRepair={() => void video.repair()}
        screenshots={s.screenshots}
        danmakuOn={s.facets.has("danmaku")}
        onDanmakuSettings={() => s.open.settings("danmaku")}
        duck={s.recorder.duck}
        tools={s.facets.has("roughcut") ? ({ currentMs, durationMs, interval }) => (
          <AddToRoughcut t={t} resourceId={doc.resourceId} revisionId={doc.revisionId} title={doc.title} durationMs={durationMs} currentMs={currentMs} interval={interval} onError={s.setError} onNotice={s.setNotice} />
        ) : undefined}
      />
    </div>
  );
}

/** The offer to go where another context was: shown once for a resource, until it is taken or put away. */
function useDismissable<T>(value: T | null, key: string | undefined): [T | null, () => void] {
  const [gone, setGone] = useState<string | null>(null);
  return [value && key && gone !== key ? value : null, () => setGone(key ?? null)];
}

/** Jumps to a position another context saved: the tab's reader opens there, and the position is then this context's own. */
async function jumpTo(s: ReturnType<typeof useServices>, resourceId: string, locator: unknown): Promise<void> {
  await s.open.anchor({ resourceId, locator } as never);
}
