import type { Translator } from "@manga/i18n";
import { formatClock } from "../readers/video-model.ts";

type T = Translator["t"];

/** What the session list query returns for a row; the left rail shows a cover, a title and the place the reader is at. */
export type SessionProgress = {
  percent: number;
  completion?: string;
  locator: { kind?: string; startMs?: number; pageId?: string } | null;
  unit: string | null;
  total: number;
};

export type SessionRowFacts = {
  kind: string;
  mediaKind?: string | null;
  ordinalLabel?: string | null;
  progress?: SessionProgress | null;
};

/**
 * Where the reader is, in the words the shelf uses: "第 01 话 · 12/28", "第 3 集 · 12:30", "34%". Nothing internal (run counts,
 * session kinds) is shown. An empty string means there is nothing to say yet.
 */
export function sessionPositionLabel(session: SessionRowFacts, t: T): string {
  if (session.kind !== "resource") return "";
  const progress = session.progress ?? null;
  const label = session.ordinalLabel ?? "";
  const join = (...parts: string[]) => parts.filter(Boolean).join(" · ");
  if (!progress) return label;
  const percent = Math.max(0, Math.min(100, Math.round(progress.percent * 100)));
  if (session.mediaKind === "video") {
    const at = progress.locator?.kind === "temporal" && typeof progress.locator.startMs === "number" ? formatClock(progress.locator.startMs) : "";
    return join(label, at || (percent > 0 ? `${percent}%` : ""));
  }
  if (session.mediaKind === "comic") {
    const total = Math.max(0, progress.total);
    const page = total > 0 ? Math.max(1, Math.min(total, Math.round(progress.percent * total))) : 0;
    return join(label, total > 0 && percent > 0 ? t("shell.sessionPage", { page, total }) : percent > 0 ? `${percent}%` : "");
  }
  return join(label, percent > 0 ? `${percent}%` : "");
}

export type SettingsGroupId = "basic" | "agent" | "records" | "logs";
export type SettingsPageId =
  | "general" | "appearance" | "reading" | "recording" | "library" | "sources" | "storage" | "modules" | "shortcuts"
  | "models" | "quick" | "usage"
  | "records"
  | "logs";

/** The settings navigation (交互设计 3.5): which pages exist and how they are grouped. */
export const SETTINGS_GROUPS: ReadonlyArray<{ id: SettingsGroupId; pages: readonly SettingsPageId[] }> = [
  { id: "basic", pages: ["general", "appearance", "reading", "recording", "library", "sources", "storage", "modules", "shortcuts"] },
  { id: "agent", pages: ["models", "quick", "usage"] },
  { id: "records", pages: ["records"] },
  { id: "logs", pages: ["logs"] },
];

export const SETTINGS_PAGES: readonly SettingsPageId[] = SETTINGS_GROUPS.flatMap((group) => group.pages);
