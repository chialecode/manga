import type { WindowControlsState } from "../lib/api.ts";

export type WindowControlLabels = { group: string; minimize: string; maximize: string; restore: string; close: string };

type Kind = "minimize" | "toggle-maximize" | "close";

/** The three glyphs are drawn as thin strokes on a 10-pixel grid, like the system's own, so they take the text color and stay sharp at any scale. */
function Glyph(props: { kind: "minimize" | "maximize" | "restore" | "close" }) {
  const common = { width: 10, height: 10, viewBox: "0 0 10 10", fill: "none", stroke: "currentColor", strokeWidth: 1, "aria-hidden": true as const, focusable: false as const };
  if (props.kind === "minimize") return <svg {...common}><path d="M0 5.5h10" /></svg>;
  if (props.kind === "maximize") return <svg {...common}><rect x="0.5" y="0.5" width="9" height="9" /></svg>;
  if (props.kind === "restore") return <svg {...common}><path d="M2.5 2.5v-2h7v7h-2" /><rect x="0.5" y="2.5" width="7" height="7" /></svg>;
  return <svg {...common}><path d="M0 0l10 10M10 0L0 10" /></svg>;
}

/**
 * The window's minimize, maximize or restore, and close (A-91), drawn in the theme's own colors where the system does not draw them. They are never part
 * of a drag area. The window's state comes from the main process, so the middle glyph is right however the window was maximized.
 */
export function WindowControls(props: { labels: WindowControlLabels; state: WindowControlsState | null }) {
  const { labels, state } = props;
  if (!state?.controls) return null;
  const act = (kind: Kind) => {
    const host = window.manga;
    if (typeof host?.windowAction === "function") void host.windowAction(kind).catch(() => undefined);
  };
  return (
    <div className="window-controls shell-no-drag" role="group" aria-label={labels.group} data-testid="window-controls" data-maximized={state.maximized ? "true" : "false"}>
      <button type="button" className="window-control" data-kind="minimize" data-testid="window-minimize" aria-label={labels.minimize} title={labels.minimize} onClick={() => act("minimize")}><Glyph kind="minimize" /></button>
      <button type="button" className="window-control" data-kind="maximize" data-testid="window-maximize" aria-label={state.maximized ? labels.restore : labels.maximize} title={state.maximized ? labels.restore : labels.maximize} onClick={() => act("toggle-maximize")}><Glyph kind={state.maximized ? "restore" : "maximize"} /></button>
      <button type="button" className="window-control" data-kind="close" data-testid="window-close" aria-label={labels.close} title={labels.close} onClick={() => act("close")}><Glyph kind="close" /></button>
    </div>
  );
}
