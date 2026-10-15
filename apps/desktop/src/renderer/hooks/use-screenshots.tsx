import { useCallback, useState, type ReactNode } from "react";
import type { Translator } from "@manga/i18n";
import { attempt } from "../lib/api.ts";
import { ScreenshotTargetDialog, type ShotRef } from "../components/screenshot-targets.tsx";
import type { CaptureFailure } from "../readers/screenshot-capture.ts";

export type ShotInput = {
  resourceId: string;
  resourceRevisionId?: string;
  data: string;
  video?: { positionMs: number; frame?: number; playbackRate?: number; audioTrack?: string; subtitleTrack?: string; subtitleTrackId?: string; subtitleText?: string; subtitleSecondaryTrack?: string; subtitleSecondaryText?: string; composited?: "none" | "subtitles" | "danmaku" | "both" };
  comic?: { pageId: string; pageLabel?: string; pageIndex?: number; spreadPageIds?: string[]; direction?: "ltr" | "rtl" | "vertical"; region?: { x: number; y: number; width: number; height: number } };
};

/** What a reader is handed to take a screenshot with: the save, and the way to tell the person a picture could not be taken. */
export type ScreenshotPort = {
  save: (input: ShotInput) => Promise<boolean>;
  fail: (failure: CaptureFailure) => void;
};

export type RichNotice = { image?: { url: string; alt: string }; actions: Array<{ id: string; label: string; onClick: () => void }> };

/**
 * Screenshots from the readers (NOTE-05). A saved picture is told in the corner with its thumbnail and what can be done with it: open its folder,
 * put it in a note, put it on a whiteboard. The picture itself is already in the folder of its work when the notice appears.
 */
export function useScreenshots(deps: {
  i18n: Translator;
  setError: (message?: string) => void;
  setRichNotice: (message: string, rich: RichNotice) => void;
  setNotice: (message?: string) => void;
}): { port: ScreenshotPort; dialog: ReactNode } {
  const { i18n, setError, setRichNotice, setNotice } = deps;
  const { t } = i18n;
  const [target, setTarget] = useState<{ shot: ShotRef; target: "note" | "board" } | null>(null);

  const save = useCallback(async (input: ShotInput): Promise<boolean> => {
    const saved = await attempt<{ screenshot: { id: string; title: string } }>("screenshot.save", input);
    if (!saved.ok) { setError(t("screenshot.failed", { reason: saved.error.message })); return false; }
    const shot = saved.value.screenshot;
    const image = await attempt<{ url: string }>("screenshot.image", { screenshotId: shot.id });
    const ref: ShotRef = { id: shot.id, title: shot.title };
    setRichNotice(t("screenshot.saved", { title: shot.title }), {
      ...(image.ok ? { image: { url: image.value.url, alt: t("screenshot.thumb") } } : {}),
      actions: [
        { id: "folder", label: t("screenshot.openFolder"), onClick: () => void window.manga.reveal(`screenshot:${shot.id}`).then((result) => { if (result.status === "error") setError(result.error?.message); }) },
        { id: "note", label: t("screenshot.insertNote"), onClick: () => setTarget({ shot: ref, target: "note" }) },
        { id: "board", label: t("screenshot.addBoard"), onClick: () => setTarget({ shot: ref, target: "board" }) },
      ],
    });
    return true;
  }, [setError, setRichNotice, t]);

  const fail = useCallback((failure: CaptureFailure) => {
    setError(t(failure === "no-frame" ? "screenshot.noFrame" : failure === "tainted" ? "screenshot.tainted" : "screenshot.encode"));
  }, [setError, t]);

  const dialog = target ? (
    <ScreenshotTargetDialog
      t={t}
      shot={target.shot}
      target={target.target}
      onClose={() => setTarget(null)}
      onError={(message) => { setTarget(null); setError(message); }}
      onDone={(message) => { setTarget(null); setNotice(message); }}
    />
  ) : null;

  return { port: { save, fail }, dialog };
}
