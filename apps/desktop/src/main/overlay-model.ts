/** The floating recording box without Electron: where it may sit, what it may be told, and the page it shows. */

export type Rect = { x: number; y: number; width: number; height: number };
export type SavedRect = { x?: number; y?: number; width: number; height: number };

export const OVERLAY_MARGIN = 16;
const MIN_VISIBLE = 48;

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), Math.max(low, high));

/**
 * Where the box goes. A saved place that is still on some screen is kept (pulled in if part of it hangs off the edge); a
 * place that is on no screen any more (a monitor was unplugged) or none at all puts the box at the top right of the main
 * screen.
 */
export function placeOverlay(saved: SavedRect, workAreas: Rect[], primary: Rect = workAreas[0] ?? { x: 0, y: 0, width: 1280, height: 720 }): Rect {
  const width = clamp(Math.round(saved.width), 160, 640);
  const height = clamp(Math.round(saved.height), 48, 320);
  if (saved.x !== undefined && saved.y !== undefined) {
    const box = { x: saved.x, y: saved.y, width, height };
    const home = workAreas.find((area) => box.x + MIN_VISIBLE <= area.x + area.width && box.x + box.width - MIN_VISIBLE >= area.x && box.y + MIN_VISIBLE <= area.y + area.height && box.y + box.height - MIN_VISIBLE >= area.y);
    if (home) {
      return {
        x: Math.round(clamp(box.x, home.x, home.x + home.width - width)),
        y: Math.round(clamp(box.y, home.y, home.y + home.height - height)),
        width, height,
      };
    }
  }
  return { x: primary.x + primary.width - width - OVERLAY_MARGIN, y: primary.y + OVERLAY_MARGIN, width, height };
}

export type OverlayState = {
  phase: "recording" | "stopping";
  elapsedMs: number;
  level: number;
  retention: "keep" | "discard";
  mode: "hold" | "toggle";
  label: string;
  strings: { recording: string; stopping: string; stop: string; keep: string; discard: string; hold: string; toggle: string };
};

const text = (value: unknown, max = 80): string | null => (typeof value === "string" && value.length <= max ? value : null);

/** What came across the process boundary, checked before it is shown: anything off-shape is dropped, never shown. */
export function parseOverlayState(value: unknown): OverlayState | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const strings = raw.strings as Record<string, unknown> | undefined;
  if (!strings || typeof strings !== "object") return null;
  const names = ["recording", "stopping", "stop", "keep", "discard", "hold", "toggle"] as const;
  const picked: Record<string, string> = {};
  for (const name of names) {
    const item = text(strings[name]);
    if (item === null) return null;
    picked[name] = item;
  }
  const label = text(raw.label, 256);
  if ((raw.phase !== "recording" && raw.phase !== "stopping") || label === null) return null;
  if (typeof raw.elapsedMs !== "number" || !Number.isFinite(raw.elapsedMs) || raw.elapsedMs < 0) return null;
  if (typeof raw.level !== "number" || !Number.isFinite(raw.level)) return null;
  if (raw.retention !== "keep" && raw.retention !== "discard") return null;
  if (raw.mode !== "hold" && raw.mode !== "toggle") return null;
  return {
    phase: raw.phase, elapsedMs: Math.floor(raw.elapsedMs), level: Math.min(1, Math.max(0, raw.level)), retention: raw.retention, mode: raw.mode, label,
    strings: picked as OverlayState["strings"],
  };
}

/**
 * The page the box shows. It has no network, no storage and no way to reach the app except the two things the preload
 * gives it: state to display and a request to stop. Text is put in with `textContent`, never as markup.
 */
export function overlayDocument(): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>MANGA</title>
<style>
html,body{margin:0;height:100%;overflow:hidden;background:transparent;font:13px system-ui,"Microsoft YaHei",sans-serif;color:#303647;user-select:none}
.box{box-sizing:border-box;height:100%;display:flex;align-items:center;gap:10px;padding:8px 12px;background:#FFFFFFF2;border:1px solid #E2E5EC;border-radius:12px;box-shadow:0 4px 18px #30364733;-webkit-app-region:drag}
.dot{flex:none;width:10px;height:10px;border-radius:50%;background:#B42318;animation:p 1.2s ease-in-out infinite}
.stopping .dot{animation:none;opacity:.6}
@keyframes p{0%,100%{opacity:1}50%{opacity:.35}}
@media (prefers-reduced-motion:reduce){.dot{animation:none}}
.main{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
.row{display:flex;align-items:center;gap:8px;white-space:nowrap}
#label{font-weight:600}
#time{font-variant-numeric:tabular-nums}
.meta{color:#687184;font-size:12px;overflow:hidden;text-overflow:ellipsis}
.meter{height:5px;border-radius:3px;background:#F5C6C2;overflow:hidden}
.meter>span{display:block;height:100%;width:0;background:#B42318;transition:width 90ms linear}
button{flex:none;-webkit-app-region:no-drag;border:1px solid #B42318;color:#B42318;background:transparent;border-radius:999px;padding:4px 12px;font:inherit;cursor:pointer}
button:hover,button:focus-visible{background:#B42318;color:#fff;outline:none}
</style></head><body>
<div class="box" id="box"><span class="dot" aria-hidden="true"></span>
<div class="main"><div class="row"><span id="label"></span><span id="time"></span></div>
<div class="meter" aria-hidden="true"><span id="level"></span></div>
<div class="meta" id="meta"></div></div>
<button id="stop" type="button"></button></div>
<script>
(function () {
  var api = window.mangaOverlay;
  var $ = function (id) { return document.getElementById(id); };
  function clock(ms) { var s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60); var two = function (n) { return (n < 10 ? "0" : "") + n; }; return (h ? h + ":" + two(m % 60) : m) + ":" + two(s % 60); }
  function show(state) {
    if (!state) return;
    document.body.className = state.phase === "stopping" ? "stopping" : "";
    $("label").textContent = state.phase === "stopping" ? state.strings.stopping : state.strings.recording;
    $("time").textContent = clock(state.elapsedMs);
    $("level").style.width = Math.round(state.level * 100) + "%";
    $("meta").textContent = [state.mode === "hold" ? state.strings.hold : state.strings.toggle, state.retention === "keep" ? state.strings.keep : state.strings.discard, state.label].filter(Boolean).join(" · ");
    $("stop").textContent = state.strings.stop;
    $("stop").disabled = state.phase === "stopping";
  }
  if (api) { api.onState(show); $("stop").addEventListener("click", function () { api.stop(); }); }
})();
</script></body></html>`;
}
