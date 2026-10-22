import { useLayoutEffect, useRef } from "react";
import { DEFAULT_COMIC_SETTINGS } from "../../hooks/use-comic.ts";
import { DEFAULT_VIDEO_SETTINGS } from "../../hooks/use-video.ts";
import { useMediaPrefs } from "../../lib/media-prefs.ts";
import type { SettingsPageId } from "../../lib/shell-model.ts";
import type { ComicSettings } from "../../readers/comic-reader.tsx";
import type { VideoSettings } from "../../readers/video-player.tsx";
import { useServices } from "../../workspace/services.tsx";
import { useSettingsActions } from "../../workspace/settings-actions.ts";
import { SettingsView } from "./settings-view.tsx";

/** Where each page was scrolled to when it was left: the settings come back to the page and to the place on it (交互设计 2.12). */
const scrolled = new Map<string, number>();

/** The main area of the settings view (A-101): the page the directory names, with its own scroll position kept. */
export function SettingsPane(props: { page: SettingsPageId; onPage: (page: SettingsPageId) => void }) {
  const s = useServices();
  const actions = useSettingsActions(s, props.page === "storage");
  const prefs = useMediaPrefs<ComicSettings, VideoSettings>({ comic: DEFAULT_COMIC_SETTINGS, video: DEFAULT_VIDEO_SETTINGS }, (message) => s.setError(message));
  const host = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const view = host.current?.querySelector<HTMLElement>(".settings-view");
    if (!view) return;
    const wanted = scrolled.get(props.page) ?? 0;
    view.scrollTop = wanted;
    // A page that fills in after its data arrives is not tall enough yet: the position is tried again on the next frames.
    const frame = requestAnimationFrame(() => { if (wanted > 0 && view.scrollTop !== wanted) view.scrollTop = wanted; });
    const onScroll = () => scrolled.set(props.page, view.scrollTop);
    view.addEventListener("scroll", onScroll, { passive: true });
    return () => { cancelAnimationFrame(frame); view.removeEventListener("scroll", onScroll); };
  }, [props.page]);

  return (
    <div ref={host} className="settings-pane" data-testid="settings-pane" data-page={props.page}>
      <SettingsView
        i18n={s.i18n}
        page={props.page}
        host={s.host}
        settings={s.settings}
        facets={new Set(s.facets)}
        scan={s.scan}
        pkg={s.pkg}
        inventory={actions.inventory}
        migration={actions.migration}
        shell={s.shell}
        onReading={(patch) => void s.saveReadingStyle(patch)}
        recording={{ settings: s.recorder.settings, save: s.recorder.saveSettings }}
        comic={prefs.comic}
        video={prefs.video}
        keys={s.keyBindings}
        onGoto={props.onPage}
        onModulesChanged={() => s.refresh()}
        onChanged={s.bump}
        onError={(message) => s.setError(message)}
        onNotice={s.setNotice}
        general={actions.general}
        models={actions.models}
        storage={actions.storage}
      />
    </div>
  );
}
