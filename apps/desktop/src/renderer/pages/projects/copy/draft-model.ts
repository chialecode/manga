import { diffWords } from "diff";
import type { DraftSourceKind, DraftSuggestionKind, DraftSuggestionStatus } from "@manga/contracts/copy";

export type DraftSummary = { id: string; title: string; version: number; chars: number; pending: number; updatedAt: string };
export type DraftDoc = { id: string; projectId: string | null; title: string; text: string; version: number; updatedAt: string };
export type VersionItem = { version: number; label: string; chars: number; createdAt: string; current: boolean };
export type SourceState = "same" | "changed" | "missing" | "disabled";
export type SuggestionItem = {
  id: string; draftId: string; kind: DraftSuggestionKind; instruction: string; status: DraftSuggestionStatus; baseVersion: number; adoptedVersion: number | null;
  createdAt: string; updatedAt: string; model: string | null; by: "agent" | null; connectionId: string | null; range: { start: number; end: number } | null; language: string | null;
  preview: string; error: { code: string; message: string } | null; baseChanged: boolean; stale: boolean;
  sources: Array<{ kind: DraftSourceKind; targetId: string; label: string; state: SourceState }>;
};
export type SuggestionDetail = Omit<SuggestionItem, "sources"> & {
  baseText: string; resultText: string; generated: string;
  quoted: Array<{ kind: DraftSourceKind; targetId: string; label: string; text: string }>;
  sources: Array<{ kind: DraftSourceKind; targetId: string; label: string; state: SourceState; before: string; after: string | null }>;
};
export type Range = { start: number; end: number };

/** What can be quoted from a project besides the draft itself. */
export const QUOTABLE_KINDS: ReadonlySet<string> = new Set(["note", "excerpt", "draft", "mindmap", "whiteboard", "recording"]);
export const SUGGEST_KINDS: readonly DraftSuggestionKind[] = ["outline", "continue", "polish", "translate", "terms", "cite"];

/** One paragraph per line: the draft is plain text, and an empty line is an empty paragraph. */
export function contentOf(text: string) {
  return {
    type: "doc",
    content: text.split("\n").map((line) => ({ type: "draftBlock", content: line ? [{ type: "text", text: line }] : [] })),
  };
}

export type DiffPart = { kind: "same" | "add" | "del"; text: string };

/** A difference by words, or `null` when the texts are too long to compare in reasonable time. */
export function wordDiff(before: string, after: string): DiffPart[] | null {
  if (before === after) return [{ kind: "same", text: before }];
  if (before.length + after.length > 60_000) return null;
  const parts = diffWords(before, after, { timeout: 1500 });
  if (!parts) return null;
  return parts.map((part) => ({ kind: part.added ? "add" as const : part.removed ? "del" as const : "same" as const, text: part.value }));
}
