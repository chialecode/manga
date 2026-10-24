import { useEffect, useState } from "react";
import { attempt } from "./api.ts";

type Kind = "comic" | "video";
type Listener = (kind: Kind, patch: Record<string, unknown>) => void;
const listeners = new Set<Listener>();

/**
 * The reader preferences are one set for the whole application (A-94): a reader tab, a second reader tab beside it and the settings tab all show the same
 * values. A change made in any of them is told to the others as it is made, so an open reader follows the settings page at once.
 */
export const mediaPrefs = {
  publish(kind: Kind, patch: Record<string, unknown>): void {
    for (const listener of [...listeners]) listener(kind, patch);
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
};

/** The saved comic and video preferences for the settings tab, kept in step with the readers. */
export function useMediaPrefs<C extends object, V extends object>(defaults: { comic: C; video: V }, onError: (message: string) => void) {
  const [comic, setComic] = useState<C>(defaults.comic);
  const [video, setVideo] = useState<V>(defaults.video);
  useEffect(() => {
    let cancelled = false;
    void attempt<{ comic?: Partial<C>; video?: Partial<V> }>("settings.getMedia").then((saved) => {
      if (cancelled || !saved.ok) return;
      if (saved.value.comic) setComic({ ...defaults.comic, ...saved.value.comic });
      if (saved.value.video) setVideo({ ...defaults.video, ...saved.value.video });
    });
    const off = mediaPrefs.subscribe((kind, patch) => {
      if (kind === "comic") setComic((current) => ({ ...current, ...patch }));
      else setVideo((current) => ({ ...current, ...patch }));
    });
    return () => { cancelled = true; off(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return {
    comic: { settings: comic, change: (patch: Partial<C>) => {
      setComic((current) => ({ ...current, ...patch }));
      mediaPrefs.publish("comic", patch);
      void attempt("settings.setMedia", { comic: patch }).then((result) => { if (!result.ok) onError(result.error.message); });
    } },
    video: { settings: video, change: (patch: Partial<V>) => {
      setVideo((current) => ({ ...current, ...patch }));
      mediaPrefs.publish("video", patch);
      void attempt("settings.setMedia", { video: patch }).then((result) => { if (!result.ok) onError(result.error.message); });
    } },
  };
}
