/** The floating recording box without Electron: where it may sit, what it may be told, and the page it shows. */

export type Rect = { x: number; y: number; width: number; height: number };
export type OverlayPos = { x: number; y: number };
/** Saved coordinates; legacy `width` is accepted only to convert old top-right-aligned positions to the fixed size. */
export type SavedRect = { x?: number; y?: number; width?: number; height?: number };

export const OVERLAY_WIDTH = 116;
export const OVERLAY_HEIGHT = 36;
export const OVERLAY_MARGIN = 16;
/** Client x boundary (px) inside the 116×36 pill: [0, 82) drags the pill; [82, 116] belongs to the stop button. */
export const OVERLAY_STOP_HIT_X = 82;

const MIN_VISIBLE_X = 36;
const MIN_VISIBLE_Y = 18;
const SILENT_LEVEL = 0.02;

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), Math.max(low, high));

/**
 * Where the 116×36 pill goes. A saved place that is still on some screen is kept (pulled in if part of it hangs off the
 * edge); a legacy saved `width` shifts `x` by `width - 116` so a box that sat against a right screen edge stays flush
 * with that right edge; a place on no screen (unplugged monitor) or none at all puts it at the top right of the main screen.
 */
export function placeOverlay(saved: SavedRect, workAreas: Rect[], primary: Rect = workAreas[0] ?? { x: 0, y: 0, width: 1280, height: 720 }): Rect {
  const width = OVERLAY_WIDTH;
  const height = OVERLAY_HEIGHT;
  if (typeof saved.x === "number" && Number.isFinite(saved.x) && typeof saved.y === "number" && Number.isFinite(saved.y)) {
    const convertedX = typeof saved.width === "number" && Number.isFinite(saved.width) && saved.width !== OVERLAY_WIDTH
      ? Math.round(saved.x + saved.width - OVERLAY_WIDTH)
      : Math.round(saved.x);
    const box = { x: convertedX, y: Math.round(saved.y), width, height };
    const home = workAreas.find((area) => box.x + MIN_VISIBLE_X <= area.x + area.width && box.x + box.width - MIN_VISIBLE_X >= area.x && box.y + MIN_VISIBLE_Y <= area.y + area.height && box.y + box.height - MIN_VISIBLE_Y >= area.y);
    if (home) {
      return {
        x: Math.round(clamp(box.x, home.x, home.x + home.width - width)),
        y: Math.round(clamp(box.y, home.y, home.y + home.height - height)),
        width,
        height,
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
  strings: { recording: string; stopping: string; stop: string; keep: string; discard: string; hold: string; toggle: string; mic?: string };
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
  if (strings.mic !== undefined) {
    const mic = text(strings.mic);
    if (mic === null) return null;
    picked.mic = mic;
  }
  const label = text(raw.label, 256);
  if ((raw.phase !== "recording" && raw.phase !== "stopping") || label === null) return null;
  if (typeof raw.elapsedMs !== "number" || !Number.isFinite(raw.elapsedMs) || raw.elapsedMs < 0) return null;
  if (typeof raw.level !== "number" || !Number.isFinite(raw.level)) return null;
  if (raw.retention !== "keep" && raw.retention !== "discard") return null;
  if (raw.mode !== "hold" && raw.mode !== "toggle") return null;
  return {
    phase: raw.phase,
    elapsedMs: Math.floor(raw.elapsedMs),
    level: Math.min(1, Math.max(0, raw.level)),
    retention: raw.retention,
    mode: raw.mode,
    label,
    strings: picked as OverlayState["strings"],
  };
}

export function formatOverlayClock(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const two = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return (h ? `${h}:${two(m % 60)}` : `${m}`) + `:${two(s % 60)}`;
}

/**
 * Microphone icon color from input level:
 * - Silent (`level <= 0.02`) or `stopping`: light gray (`#9CA3AF`).
 * - `prefers-reduced-motion`: binary switch between `#9CA3AF` and primary `#AD3268`.
 * - Normal motion: continuous shade along `#DE6C9B` -> `#AD3268` -> `#84204D` as speech volume rises.
 */
export function micColorForLevel(level: number, phase: "recording" | "stopping", reducedMotion = false): string {
  if (phase === "stopping" || !(level > SILENT_LEVEL)) return "#9CA3AF";
  if (reducedMotion) return "#AD3268";
  const t = Math.min(1, Math.max(0, (level - SILENT_LEVEL) / 0.68));
  const lerp = (a: number, b: number, u: number) => Math.round(a + (b - a) * u);
  const hex = (n: number) => n.toString(16).padStart(2, "0").toUpperCase();
  const [r, g, b] = t <= 0.5
    ? [lerp(0xDE, 0xAD, t * 2), lerp(0x6C, 0x32, t * 2), lerp(0x9B, 0x68, t * 2)]
    : [lerp(0xAD, 0x84, (t - 0.5) * 2), lerp(0x32, 0x20, (t - 0.5) * 2), lerp(0x68, 0x4D, (t - 0.5) * 2)];
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/** Accessible name & hover tooltip carrying status, clock, mode, audio retention, and local device label. */
export function overlaySummary(state: OverlayState, displayedClock = formatOverlayClock(state.elapsedMs)): string {
  const status = state.phase === "stopping" ? state.strings.stopping : state.strings.recording;
  const mode = state.mode === "hold" ? state.strings.hold : state.strings.toggle;
  const retention = state.retention === "keep" ? state.strings.keep : state.strings.discard;
  const micLabel = state.strings.mic || "麦克风";
  const parts = [`${status} ${displayedClock}`, mode, retention];
  if (state.label) parts.push(`${micLabel}：${state.label}`);
  return parts.join("，");
}

/**
 * The page the box shows. It has no network, no storage and no way to reach the app except the two things the preload
 * gives it: state to display and a request to stop. Visible text holds only the `m:ss` clock (`textContent`, never markup);
 * status, mode, retention, and device name live on the pill's `aria-label` and `title`.
 *
 * Note on dragging: `.box` deliberately stays in client hit-testing (`HTCLIENT` on `Chrome_RenderWidgetHostHWND`, which
 * returns `MA_NOACTIVATE = 3`) rather than `-webkit-app-region: drag` (`HTCAPTION` on `Chrome_WidgetWin_1`, which returns
 * `MA_NOACTIVATEANDEAT = 4` when `focusable: false` on Windows and discards hardware mouse-downs). The main process moves
 * the window from `webContents` `input-event` coordinates without activating the overlay or blurring the main window.
 */
export function overlayDocument(): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>MANGA</title>
<style>
html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:transparent;font:13px system-ui,"Microsoft YaHei",sans-serif;color:#303647;user-select:none}
.box{box-sizing:border-box;width:${OVERLAY_WIDTH}px;height:${OVERLAY_HEIGHT}px;display:flex;align-items:center;justify-content:space-between;gap:6px;padding:0 7px 0 10px;background:#FFFFFFF2;border:1px solid #E2E5EC;border-radius:999px;cursor:grab}
.box:active{cursor:grabbing}
.mic{flex:none;width:16px;height:16px;display:inline-flex;align-items:center;justify-content:center;color:#9CA3AF;transition:color 80ms linear}
.stopping .mic{color:#9CA3AF;opacity:.65;transition:none}
@media (prefers-reduced-motion:reduce){.mic{transition:none}}
#time{flex:1;text-align:center;font-size:13px;font-weight:600;line-height:1;font-variant-numeric:tabular-nums;color:#303647;white-space:nowrap}
.stopping #time{color:#687184}
#stop{flex:none;width:24px;height:24px;padding:0;display:inline-flex;align-items:center;justify-content:center;border:1px solid #E2E5EC;border-radius:999px;background:#F3F4F7;color:#AD3268;cursor:pointer}
#stop:hover,#stop:focus-visible{background:#AD3268;border-color:#AD3268;color:#FFFFFF;outline:none}
#stop:disabled{opacity:.45;cursor:default;background:#F3F4F7;border-color:#E2E5EC;color:#9CA3AF}
</style></head><body>
<div class="box" id="box" role="status">
<span class="mic" id="mic" aria-hidden="true"><svg width="15" height="15" viewBox="0 0 16 16" fill="none"><rect x="5.2" y="1.5" width="5.6" height="8.2" rx="2.8" fill="currentColor"/><path d="M3.2 7.2a4.8 4.8 0 0 0 9.6 0M8 12v2.5M5.5 14.5h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></span>
<span id="time">0:00</span>
<button id="stop" type="button"><svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true"><rect x="1" y="1" width="8" height="8" rx="1.6" fill="currentColor"/></svg></button>
</div>
<script>
(function () {
  var api = window.mangaOverlay;
  var $ = function (id) { return document.getElementById(id); };
  var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)");
  var lastTime = "";
  function clock(ms) {
    var s = Math.floor(Math.max(0, ms) / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60);
    var two = function (n) { return (n < 10 ? "0" : "") + n; };
    return (h ? h + ":" + two(m % 60) : m) + ":" + two(s % 60);
  }
  function hex(n) { var v = Math.round(n).toString(16).toUpperCase(); return v.length < 2 ? "0" + v : v; }
  function lerp(a, b, u) { return a + (b - a) * u; }
  function micColor(level, phase) {
    if (phase === "stopping" || !(level > 0.02)) return "#9CA3AF";
    if (reduced && reduced.matches) return "#AD3268";
    var t = Math.min(1, Math.max(0, (level - 0.02) / 0.68));
    var u = t <= 0.5 ? t * 2 : (t - 0.5) * 2;
    var r = t <= 0.5 ? lerp(0xDE, 0xAD, u) : lerp(0xAD, 0x84, u);
    var g = t <= 0.5 ? lerp(0x6C, 0x32, u) : lerp(0x32, 0x20, u);
    var b = t <= 0.5 ? lerp(0x9B, 0x68, u) : lerp(0x68, 0x4D, u);
    return "#" + hex(r) + hex(g) + hex(b);
  }
  function show(state) {
    if (!state) return;
    var stopping = state.phase === "stopping";
    document.body.className = stopping ? "stopping" : "";
    if (!stopping || !lastTime) lastTime = clock(state.elapsedMs);
    $("time").textContent = lastTime;
    var color = micColor(state.level, state.phase);
    var mic = $("mic");
    mic.style.color = color;
    mic.setAttribute("data-color", color);
    mic.setAttribute("data-speaking", !stopping && state.level > 0.02 ? "true" : "false");
    var status = stopping ? state.strings.stopping : state.strings.recording;
    var mode = state.mode === "hold" ? state.strings.hold : state.strings.toggle;
    var retention = state.retention === "keep" ? state.strings.keep : state.strings.discard;
    var micWord = state.strings.mic || "麦克风";
    var parts = [status + " " + lastTime, mode, retention];
    if (state.label) parts.push(micWord + "：" + state.label);
    var summary = parts.join("，");
    var box = $("box");
    box.setAttribute("aria-label", summary);
    box.setAttribute("title", summary);
    var stop = $("stop");
    stop.setAttribute("aria-label", state.strings.stop);
    stop.setAttribute("title", state.strings.stop);
    stop.disabled = stopping;
  }
  if (api) { api.onState(show); $("stop").addEventListener("click", function () { api.stop(); }); }
})();
</script></body></html>`;
}
