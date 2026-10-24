import { z } from "zod";

/**
 * The keys of the readers and of the window, in one table. The key handling of the readers and the shortcuts page of the settings both read it,
 * so a key that is changed in one place is changed everywhere, and two actions that share a key can be found before the person tries it.
 *
 * A key is a chord: modifiers in the order Ctrl, Alt, Shift, then the key itself (`Ctrl+Shift+D`); the Cmd key counts as Ctrl. A letter is written upper case.
 * A key that is not one printable character (an arrow, Space, Home) carries Shift in its name when Shift is down; a printable one does not,
 * because its own character already says it (`[` and `{` are two keys).
 */

export type KeyGroup = "global" | "video" | "comic" | "novel";

export type KeyActionDef = {
  id: string;
  group: KeyGroup;
  /** The message key of the action's name. */
  label: string;
  defaults: readonly string[];
  /** Shown in the table but not changed: the key means the same everywhere (Esc closes the topmost thing). */
  fixed?: boolean;
};

export const KEY_GROUPS: readonly KeyGroup[] = ["global", "video", "comic", "novel"];

const action = (id: string, defaults: readonly string[], fixed = false): KeyActionDef => ({
  id, group: id.slice(0, id.indexOf(".")) as KeyGroup, label: `keys.${id}`, defaults, ...(fixed ? { fixed: true } : {}),
});

/** The defaults are Q-13's and Q-26's: R switches the custom rate, S takes a picture, W fills the window. */
export const KEY_ACTIONS: readonly KeyActionDef[] = [
  action("global.windowFullscreen", ["W"]),
  action("global.debug", ["Ctrl+Shift+D"]),
  action("global.escape", ["Esc"], true),
  // The one workspace (A-94): tabs, columns and the side columns.
  action("global.newTab", ["Ctrl+T"]),
  action("global.closeTab", ["Ctrl+W"]),
  action("global.reopenTab", ["Ctrl+Shift+T"]),
  action("global.nextTab", ["Ctrl+Tab"]),
  action("global.prevTab", ["Ctrl+Shift+Tab"]),
  action("global.column1", ["Ctrl+1"]),
  action("global.column2", ["Ctrl+2"]),
  action("global.column3", ["Ctrl+3"]),
  action("global.column4", ["Ctrl+4"]),
  action("global.splitToggle", ["Ctrl+\\"]),
  action("global.sidebar", ["Ctrl+B"]),
  action("global.dock", ["Ctrl+Alt+B"]),
  action("global.newConversation", ["Ctrl+N"]),
  action("global.newProject", ["Ctrl+Shift+N"]),
  // The search box and the settings (A-100, A-101).
  action("global.search", ["Ctrl+K"]),
  action("global.settings", ["Ctrl+,"]),

  action("video.toggle", ["Space", "K"]),
  action("video.seekBack", ["ArrowLeft"]),
  action("video.seekForward", ["ArrowRight"]),
  action("video.volumeUp", ["ArrowUp"]),
  action("video.volumeDown", ["ArrowDown"]),
  action("video.framePrev", [","]),
  action("video.frameNext", ["."]),
  action("video.mute", ["M"]),
  action("video.fullscreen", ["F"]),
  action("video.markA", ["I"]),
  action("video.markB", ["O"]),
  action("video.rateDown", ["["]),
  action("video.rateUp", ["]"]),
  action("video.customRate", ["R"]),
  action("video.start", ["Home"]),
  action("video.time", ["T"]),
  action("video.screenshot", ["S"]),
  action("video.danmaku", ["D"]),

  action("comic.left", ["ArrowLeft"]),
  action("comic.right", ["ArrowRight"]),
  action("comic.next", ["PageDown", "Space"]),
  action("comic.prev", ["PageUp", "Shift+Space"]),
  action("comic.first", ["Home"]),
  action("comic.last", ["End"]),
  action("comic.zoomIn", ["Ctrl+=", "Ctrl++"]),
  action("comic.zoomOut", ["Ctrl+-"]),
  action("comic.zoomReset", ["Ctrl+0"]),
  action("comic.fullscreen", ["F"]),
  action("comic.screenshot", ["S"]),

  action("novel.next", ["ArrowRight", "PageDown", "Space"]),
  action("novel.prev", ["ArrowLeft", "PageUp"]),
];

const BY_ID = new Map(KEY_ACTIONS.map((entry) => [entry.id, entry]));
export const keyAction = (id: string): KeyActionDef | undefined => BY_ID.get(id);

const NAMED = new Set(["Space", "Esc", "Enter", "Tab", "Backspace", "Delete", "Insert", "Home", "End", "PageUp", "PageDown", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);
const FUNCTION_KEY = /^F(?:[1-9]|1[0-9]|2[0-4])$/;

/** The most chords one action keeps. */
export const MAX_CHORDS = 4;

/** The parts of a chord: its modifiers and its key, or null when the text is not a chord. */
export function parseChord(chord: string): { ctrl: boolean; alt: boolean; shift: boolean; key: string } | null {
  let rest = chord;
  const flags = { ctrl: false, alt: false, shift: false };
  for (const [name, flag] of [["Ctrl+", "ctrl"], ["Alt+", "alt"], ["Shift+", "shift"]] as const) {
    if (rest.startsWith(name) && rest.length > name.length) { flags[flag] = true; rest = rest.slice(name.length); }
  }
  const key = rest;
  const printable = [...key].length === 1 && key !== " ";
  if (!printable && !NAMED.has(key) && !FUNCTION_KEY.test(key)) return null;
  if (printable && /[a-z]/.test(key)) return null;
  // The modifiers must come in the written order, so one chord has one spelling.
  const canonical = `${flags.ctrl ? "Ctrl+" : ""}${flags.alt ? "Alt+" : ""}${flags.shift ? "Shift+" : ""}${key}`;
  if (canonical !== chord) return null;
  return { ...flags, key };
}

export const isChord = (chord: string): boolean => parseChord(chord) !== null;

/**
 * The chord of a key event, or null for a key that is only a modifier. Shift is part of the chord for a key that is not one printable
 * character, and for any key pressed with Ctrl (or Cmd) or Alt.
 */
export function chordOf(event: { key: string; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; metaKey?: boolean }): string | null {
  const raw = event.key;
  if (raw === "Control" || raw === "Alt" || raw === "Shift" || raw === "Meta" || raw === "AltGraph" || raw === "CapsLock" || raw === "Dead" || raw === "Process" || raw === "Unidentified") return null;
  const key = raw === " " ? "Space" : raw === "Escape" ? "Esc" : [...raw].length === 1 ? raw.toUpperCase() : raw;
  const printable = [...key].length === 1;
  const ctrl = Boolean(event.ctrlKey || event.metaKey);
  const withShift = event.shiftKey && (!printable || ctrl || event.altKey);
  return `${ctrl ? "Ctrl+" : ""}${event.altKey ? "Alt+" : ""}${withShift ? "Shift+" : ""}${key}`;
}

const SHOWN: Record<string, string> = { ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓" };

/** How a chord is shown: arrows as arrows, the parts apart (`Ctrl + Shift + D`). */
export function chordLabel(chord: string): string {
  const parsed = parseChord(chord);
  if (!parsed) return chord;
  const parts = [parsed.ctrl ? "Ctrl" : "", parsed.alt ? "Alt" : "", parsed.shift ? "Shift" : "", SHOWN[parsed.key] ?? parsed.key].filter(Boolean);
  return parts.join(" + ");
}

export const KeyOverridesSchema = z.record(z.string().regex(/^[a-z]+\.[A-Za-z]+$/).max(48), z.array(z.string().max(40)).max(MAX_CHORDS));
/** What is saved: only the actions the person changed. An empty list is an action with no key. */
export type KeyOverrides = z.infer<typeof KeyOverridesSchema>;

/** Every action with the keys it answers to now: the person's own where they changed it, else the defaults. */
export function resolveKeys(overrides: KeyOverrides | null | undefined): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const entry of KEY_ACTIONS) {
    const own = entry.fixed ? undefined : overrides?.[entry.id];
    out[entry.id] = own ? [...own] : [...entry.defaults];
  }
  return out;
}

export type KeyConflict = { chord: string; actions: string[] };

/**
 * Two actions answer to one key when they are in the same group, or one of them is a global one: only one reader is in front at a time,
 * so a video key and a comic key may be the same.
 */
export function findConflicts(resolved: Record<string, readonly string[]>): KeyConflict[] {
  const found: KeyConflict[] = [];
  const seen = new Set<string>();
  for (const entry of KEY_ACTIONS) {
    for (const chord of resolved[entry.id] ?? []) {
      const sharing = KEY_ACTIONS.filter((other) => (other.group === entry.group || other.group === "global" || entry.group === "global") && (resolved[other.id] ?? []).includes(chord));
      if (sharing.length < 2) continue;
      const key = `${chord}|${sharing.map((item) => item.id).sort().join(",")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ chord, actions: sharing.map((item) => item.id) });
    }
  }
  return found;
}

/** The other actions that already use `chord` where `actionId` would use it. */
export function conflictsWith(resolved: Record<string, readonly string[]>, actionId: string, chord: string): string[] {
  const entry = keyAction(actionId);
  if (!entry) return [];
  return KEY_ACTIONS
    .filter((other) => other.id !== actionId && (other.group === entry.group || other.group === "global" || entry.group === "global") && (resolved[other.id] ?? []).includes(chord))
    .map((other) => other.id);
}

/** A reason the overrides cannot be kept, or null: an action that does not exist, a chord that is not one, a fixed key, a key two actions share. */
export function checkOverrides(overrides: KeyOverrides): string | null {
  for (const [id, chords] of Object.entries(overrides)) {
    const entry = keyAction(id);
    if (!entry) return `unknown key action: ${id}`;
    if (entry.fixed) return `the key of ${id} cannot be changed`;
    for (const chord of chords) if (!isChord(chord)) return `not a key: ${chord}`;
    if (new Set(chords).size !== chords.length) return `${id} lists a key twice`;
  }
  const conflict = findConflicts(resolveKeys(overrides))[0];
  return conflict ? `${conflict.chord} is used by ${conflict.actions.join(" and ")}` : null;
}

/** The action of a group (or of the global group) a key event means, or null. The global actions are asked for by the window, the group's by its reader. */
export function actionOf(event: Parameters<typeof chordOf>[0], resolved: Record<string, readonly string[]>, group: KeyGroup): string | null {
  const chord = chordOf(event);
  if (chord === null) return null;
  for (const entry of KEY_ACTIONS) {
    if (entry.group !== group) continue;
    if ((resolved[entry.id] ?? []).includes(chord)) return entry.id;
  }
  return null;
}
