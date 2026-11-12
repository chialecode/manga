import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileVideo, MoreHorizontal } from "lucide-react";
import { createTranslator } from "@manga/i18n";
import { Menu } from "../renderer/components/menu.tsx";
import { WindowControls } from "../renderer/components/window-controls.tsx";
import { useWindowState } from "../renderer/hooks/use-window-state.ts";
import { DEFAULT_KEY_TABLE } from "../renderer/lib/key-table.tsx";
import { useWindowFullscreenKeys, WindowFullscreenProvider } from "../renderer/readers/window-fullscreen.tsx";
import { lightHost, type LightState } from "./light-host.ts";
import { LightVideoPlayer } from "./light-video-player.tsx";
import { LightComicReader } from "./light-comic-reader.tsx";

/**
 * Light open's window (READ-05, 交互设计): the app's own title bar with the file's name and a "…" menu, and under it one video player or one comic
 * reader, an empty window that takes a dropped file, or the reason a file cannot be shown. Errors are said in the window, never in a dialog.
 */
export function LightApp() {
  const i18n = useMemo(() => createTranslator(), []);
  const t = i18n.t;
  const host = lightHost();
  const windowState = useWindowState();
  const [state, setState] = useState<LightState | null>(null);
  const [opening, setOpening] = useState(false);
  const [about, setAbout] = useState(false);
  const [notice, setNotice] = useState("");
  const [dragging, setDragging] = useState(false);
  // Window full screen: the title bar steps aside, the window keeps its own buttons on hover of the top edge.
  const [immersive, setImmersive] = useState(false);
  const windowFull = useMemo(() => ({ active: immersive, toggle: () => setImmersive((value) => !value), exit: () => setImmersive(false) }), [immersive]);

  const refresh = useCallback(async () => {
    if (!host) return;
    setState(await host.state());
    setOpening(false);
  }, [host]);
  useEffect(() => {
    if (!host) return;
    void refresh();
    return host.onChanged(() => { void refresh(); });
  }, [host, refresh]);

  const openFile = useCallback(async () => {
    if (!host) return;
    const next = await host.openDialog();
    setState(next);
  }, [host]);

  const sibling = useCallback(async (direction: 1 | -1) => {
    if (!host) return;
    setNotice("");
    const result = await host.sibling(direction);
    if (!result.moved) setNotice(direction > 0 ? t("light.noNext") : t("light.noPrevious"));
  }, [host, t]);

  // A file dropped anywhere on the window replaces what it shows.
  useEffect(() => {
    if (!host) return;
    const over = (event: DragEvent) => { if (event.dataTransfer?.types.includes("Files")) { event.preventDefault(); setDragging(true); } };
    const leave = (event: DragEvent) => { if (event.relatedTarget === null) setDragging(false); };
    const drop = (event: DragEvent) => {
      event.preventDefault();
      setDragging(false);
      const file = event.dataTransfer?.files[0];
      if (!file) return;
      setOpening(true);
      void host.openDropped(file).then(setState).finally(() => setOpening(false));
    };
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => { window.removeEventListener("dragover", over); window.removeEventListener("dragleave", leave); window.removeEventListener("drop", drop); };
  }, [host]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 3000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const opened = state?.opened ?? null;
  const labels = { group: t("window.controls"), minimize: t("window.minimize"), maximize: t("window.maximize"), restore: t("window.restore"), close: t("window.close") };
  const types = state?.types;
  const errorText = state?.error
    ? state.error.kind === "missing" ? t("light.missing") : state.error.kind === "unsupported" ? t("light.unsupported") : t("light.broken", { reason: state.error.detail })
    : "";
  const typeList = types ? t("light.emptyTypes", { video: types.video.map((ext) => ext.slice(1)).join(" "), image: types.image.map((ext) => ext.slice(1)).join(" ") }) : "";
  const aboutButton = useRef<HTMLButtonElement>(null);
  useWindowFullscreenKeys({ enabled: Boolean(opened), active: immersive, toggleKeys: DEFAULT_KEY_TABLE["global.windowFullscreen"] ?? [], toggle: windowFull.toggle, exit: windowFull.exit });

  return (
    <WindowFullscreenProvider value={windowFull}>
    <div className="light-shell" data-testid="light-shell" data-immersive={immersive || undefined} data-kind={opened?.kind ?? (state?.error ? "error" : "empty")} data-dragging={dragging || undefined}>
      <header className="shell-top light-top shell-drag" data-testid="light-top">
        <span className="light-brand" aria-hidden="true"><FileVideo size={15} /></span>
        <span className="light-title" data-testid="light-title" title={opened?.name ?? ""}>{opened?.name ?? t("light.title")}</span>
        <span className="shell-no-drag light-menu">
          <Menu
            label={t("light.menu")}
            testId="light-menu"
            className="titlebar-menu"
            items={[
              { id: "open", label: t("light.openFile"), onSelect: () => void openFile() },
              { id: "reveal", label: t("light.reveal"), disabled: !opened, onSelect: () => void host?.reveal() },
              { id: "about", label: t("light.about"), onSelect: () => setAbout(true) },
            ]}
            trigger={<MoreHorizontal size={16} />}
          />
        </span>
        <span className="top-fill" />
        <WindowControls labels={labels} state={windowState} />
      </header>
      <main className="light-body" data-testid="light-body">
        {opened?.kind === "video" ? (
          <LightVideoPlayer key={opened.sessionId} t={t} opened={opened} resume={state?.resume ?? null} onSibling={sibling} />
        ) : opened?.kind === "comic" ? (
          <LightComicReader key={opened.sessionId} t={t} opened={opened} resume={state?.resume ?? null} onSibling={sibling} />
        ) : (
          <div className="light-empty" data-testid={state?.error ? "light-error" : "light-empty"} data-error={state?.error?.kind}>
            {state?.error ? <p className="light-empty-title" role="alert">{errorText}</p> : <p className="light-empty-title">{opening ? t("light.opening") : t("light.empty")}</p>}
            {typeList ? <p className="light-empty-types" data-testid="light-types">{typeList}</p> : null}
            <button type="button" className="primary-button" data-testid="light-open" onClick={() => void openFile()}>{t("light.openFile")}</button>
          </div>
        )}
        {notice ? <p className="light-notice" role="status" data-testid="light-notice">{notice}</p> : null}
        {about ? (
          <div className="light-about" role="dialog" aria-modal="true" aria-label={t("light.about")} data-testid="light-about">
            <p>{t("light.aboutText", { version: state?.version ?? "" })}</p>
            <button ref={aboutButton} type="button" className="secondary-button" autoFocus onClick={() => setAbout(false)}>{t("light.aboutClose")}</button>
          </div>
        ) : null}
      </main>
    </div>
    </WindowFullscreenProvider>
  );
}
