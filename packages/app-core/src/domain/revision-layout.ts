import type { DrizzleStore } from "@manga/storage-drizzle";
import { codePointLength } from "./text.ts";

/**
 * Measurements of a revision that progress and listings need without parsing its whole payload on every write.
 * Computed once when the revision is written (or lazily for revisions that predate it) and stored in `layout_json`.
 */
export type RevisionLayout = {
  unit: "chars" | "pages" | "ms";
  total: number;
  /** Text parts in reading order with their code-point length. */
  parts?: Array<{ id: string; length: number }>;
  /** Page ids in reading order, for comics and for PDFs read as comics. */
  pages?: string[];
};

type PayloadLike = {
  format?: string;
  normalized?: string;
  parts?: Array<{ id?: string; normalized?: string; kind?: string }>;
  comic?: { pages?: Array<{ id: string }> };
  video?: { durationMs?: number };
};

export function layoutFromPayload(payload: PayloadLike): RevisionLayout {
  if (payload.video && typeof payload.video.durationMs === "number") return { unit: "ms", total: Math.max(0, Math.round(payload.video.durationMs)) };
  if (payload.comic?.pages) {
    const pages = payload.comic.pages.map((page) => page.id);
    return { unit: "pages", total: pages.length, pages };
  }
  const parts = payload.parts?.length ? payload.parts : [{ id: "body", normalized: payload.normalized ?? "", kind: "text" }];
  const measured = parts.map((part) => ({ id: part.id || "body", length: part.kind === "image" ? 0 : codePointLength(part.normalized ?? "") }));
  const total = measured.reduce((sum, part) => sum + part.length, 0);
  const layout: RevisionLayout = { unit: "chars", total, parts: measured };
  // A PDF's parts are its pages, so it can also be opened by page (comic reader).
  if (payload.format === "pdf") layout.pages = measured.map((part) => part.id);
  return layout;
}

export function readLayout(store: DrizzleStore, revisionId: string): RevisionLayout | undefined {
  const row = store.sqlite.prepare("SELECT layout_json, payload_json FROM resource_revisions WHERE id = ?").get(revisionId) as { layout_json: string | null; payload_json: string } | undefined;
  if (!row) return undefined;
  if (row.layout_json) return JSON.parse(row.layout_json) as RevisionLayout;
  const layout = layoutFromPayload(JSON.parse(row.payload_json) as PayloadLike);
  store.sqlite.prepare("UPDATE resource_revisions SET layout_json = ? WHERE id = ? AND layout_json IS NULL").run(JSON.stringify(layout), revisionId);
  return layout;
}
