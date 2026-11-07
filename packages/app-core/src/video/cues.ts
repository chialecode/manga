/** One line of subtitle text with its time on the original timeline. Styling and positioning are dropped: this feeds search and Agent context, not rendering. */
export type Cue = { startMs: number; endMs: number; text: string };

function clockToMs(text: string): number | null {
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(text.trim());
  if (!match) return null;
  const fraction = match[4]!.padEnd(3, "0");
  return ((Number(match[1] ?? 0) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000 + Number(fraction);
}

function assClockToMs(text: string): number | null {
  const match = /^(\d+):(\d{2}):(\d{2})[.](\d{1,2})$/.exec(text.trim());
  if (!match) return null;
  return ((Number(match[1]) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000 + Number(match[4]!.padEnd(2, "0")) * 10;
}

/** ASS override tags ({\an8}, {\pos(..)}) and drawing commands carry no words. */
function plainAss(text: string): string {
  return text
    .replace(/\{[^}]*\}/g, "")
    .replace(/\\[Nn]/g, "\n")
    .replace(/\\h/g, " ")
    .trim();
}

export function parseAssCues(source: string): Cue[] {
  const lines = source.replace(/^﻿/, "").split(/\r?\n/);
  let format: string[] = [];
  let inEvents = false;
  const cues: Cue[] = [];
  for (const line of lines) {
    const section = /^\[(.+)\]\s*$/.exec(line);
    if (section) { inEvents = section[1]!.trim().toLowerCase() === "events"; continue; }
    if (!inEvents) continue;
    if (/^format\s*:/i.test(line)) { format = line.slice(line.indexOf(":") + 1).split(",").map((field) => field.trim().toLowerCase()); continue; }
    if (!/^dialogue\s*:/i.test(line)) continue;
    const fields = format.length ? format : ["layer", "start", "end", "style", "name", "marginl", "marginr", "marginv", "effect", "text"];
    const body = line.slice(line.indexOf(":") + 1).trimStart();
    const parts = body.split(",");
    const textIndex = fields.indexOf("text");
    if (textIndex < 0 || parts.length <= textIndex) continue;
    const startIndex = fields.indexOf("start");
    const endIndex = fields.indexOf("end");
    const start = assClockToMs(parts[startIndex] ?? "");
    const end = assClockToMs(parts[endIndex] ?? "");
    if (start === null || end === null || end < start) continue;
    const text = plainAss(parts.slice(textIndex).join(","));
    // Drawing commands (\p1) show a shape, not words.
    if (!text || /\\p[1-9]/.test(body)) continue;
    cues.push({ startMs: start, endMs: end, text });
  }
  return cues.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

export function parseSrtCues(source: string): Cue[] {
  const blocks = source.replace(/^﻿/, "").split(/\r?\n\r?\n+/);
  const cues: Cue[] = [];
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).filter((line) => line.trim() !== "");
    const timing = lines.findIndex((line) => line.includes("-->"));
    if (timing < 0) continue;
    const [from, to] = lines[timing]!.split("-->").map((part) => part.trim().split(/\s+/)[0] ?? "");
    const start = clockToMs(from ?? "");
    const end = clockToMs(to ?? "");
    if (start === null || end === null || end < start) continue;
    const text = lines.slice(timing + 1).join("\n").replace(/<[^>]+>/g, "").replace(/\{\\[^}]*\}/g, "").trim();
    if (text) cues.push({ startMs: start, endMs: end, text });
  }
  return cues.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

export function parseCues(source: string, format: "ass" | "srt" | "vtt"): Cue[] {
  return format === "ass" ? parseAssCues(source) : parseSrtCues(source.replace(/^WEBVTT[^\n]*\n/, ""));
}

/** Cues overlapping [fromMs, toMs], never later than `limitMs` when a spoiler limit applies. */
export function cueWindow(cues: Cue[], fromMs: number, toMs: number, limitMs?: number): Cue[] {
  return cues.filter((cue) => cue.endMs >= fromMs && cue.startMs <= toMs && (limitMs === undefined || cue.startMs <= limitMs));
}
