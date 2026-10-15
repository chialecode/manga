import type { DrizzleStore } from "@manga/storage-drizzle";

/**
 * Everything a project, an embed or a package can point at, in one place: whether it exists, what to call it, and which feature owns it
 * (so a switched-off feature shows a placeholder instead of a broken link, while the row stays).
 */
export type ObjectKind = "work" | "resource" | "anchor" | "note" | "recording" | "excerpt" | "whiteboard" | "mindmap" | "draft" | "roughcut" | "excerptPage" | "screenshot";

type Spec = { feature: string; table: string; label: string; where?: string };

const SPECS: Record<ObjectKind, Spec> = {
  work: { feature: "library", table: "works", label: "title" },
  resource: { feature: "library", table: "resources", label: "title" },
  anchor: { feature: "library", table: "anchors", label: "id" },
  note: { feature: "notes", table: "content_objects", label: "title", where: "type = 'notes.document' AND deleted_at IS NULL" },
  recording: { feature: "voice", table: "capture_sessions", label: "created_at" },
  excerpt: { feature: "research", table: "excerpts", label: "COALESCE(NULLIF(title, ''), substr(text, 1, 40))" },
  excerptPage: { feature: "research", table: "excerpt_pages", label: "COALESCE(NULLIF(title, ''), url)" },
  whiteboard: { feature: "whiteboard", table: "whiteboards", label: "title" },
  mindmap: { feature: "mindmap", table: "mindmaps", label: "title" },
  draft: { feature: "copywriting", table: "drafts", label: "title" },
  roughcut: { feature: "roughcut", table: "rough_cuts", label: "title" },
  screenshot: { feature: "library", table: "screenshots", label: "title" },
};

export const featureOfKind = (kind: ObjectKind): string => SPECS[kind].feature;
export const isObjectKind = (value: string): value is ObjectKind => Object.prototype.hasOwnProperty.call(SPECS, value);

/** Where a reference to a resource or an anchor opens: the file, the reader that shows it and the work it belongs to. */
export type ObjectOpens = {
  resourceId: string; mediaKind: string; workId: string | null;
  /** Where in the resource a reference lands: the moment of a video, the page of a comic. */
  position?: { kind: "temporal"; startMs: number } | { kind: "image"; pageId: string };
};

/** What a reader can say about an object without opening it: its name, or nothing when it is gone. */
export function describeObject(store: DrizzleStore, kind: ObjectKind, id: string): { exists: boolean; label: string; opens?: ObjectOpens } {
  const spec = SPECS[kind];
  const row = store.sqlite.prepare(`SELECT ${spec.label} AS label FROM ${spec.table} WHERE id = ?${spec.where ? ` AND ${spec.where}` : ""}`).get(id) as { label: string | null } | undefined;
  if (!row) return { exists: false, label: "" };
  if (kind === "anchor") {
    const anchor = store.sqlite.prepare("SELECT r.id AS resourceId, r.kind AS mediaKind, r.work_id AS workId, r.title AS title FROM anchors a JOIN resources r ON r.id = a.resource_id WHERE a.id = ?").get(id) as { resourceId: string; mediaKind: string; workId: string | null; title: string } | undefined;
    return { exists: true, label: anchor?.title ?? "", ...(anchor ? { opens: { resourceId: anchor.resourceId, mediaKind: anchor.mediaKind, workId: anchor.workId } } : {}) };
  }
  if (kind === "resource") {
    const resource = store.sqlite.prepare("SELECT kind AS mediaKind, work_id AS workId FROM resources WHERE id = ?").get(id) as { mediaKind: string; workId: string | null } | undefined;
    return { exists: true, label: String(row.label ?? ""), ...(resource ? { opens: { resourceId: id, mediaKind: resource.mediaKind, workId: resource.workId } } : {}) };
  }
  if (kind === "screenshot") {
    const shot = store.sqlite.prepare("SELECT s.resource_id AS resourceId, s.media_kind AS mediaKind, s.work_id AS workId, s.position_ms AS positionMs, s.page_id AS pageId FROM screenshots s WHERE s.id = ?").get(id) as
      { resourceId: string; mediaKind: string; workId: string | null; positionMs: number | null; pageId: string | null } | undefined;
    const position = shot?.positionMs !== null && shot?.positionMs !== undefined ? { kind: "temporal" as const, startMs: shot.positionMs } : shot?.pageId ? { kind: "image" as const, pageId: shot.pageId } : undefined;
    return { exists: true, label: String(row.label ?? ""), ...(shot ? { opens: { resourceId: shot.resourceId, mediaKind: shot.mediaKind === "comic" ? "comic" : "video", workId: shot.workId, ...(position ? { position } : {}) } } : {}) };
  }
  return { exists: true, label: String(row.label ?? "") };
}

/** The resources an object leads to, so a project's scope can be worked out from what it holds. */
export function resourcesOf(store: DrizzleStore, kind: ObjectKind, id: string): string[] {
  const column = (sql: string, ...params: unknown[]): string[] => (store.sqlite.prepare(sql).all(...params) as Array<{ id: string | null }>).map((row) => row.id).filter((value): value is string => Boolean(value));
  switch (kind) {
    case "resource": return column("SELECT id FROM resources WHERE id = ?", id);
    case "work": return column("SELECT id FROM resources WHERE work_id = ?", id);
    case "anchor": return column("SELECT resource_id AS id FROM anchors WHERE id = ?", id);
    case "note": return column("SELECT DISTINCT a.resource_id AS id FROM refs r JOIN anchors a ON a.id = r.to_id WHERE r.from_object_id = ? AND r.to_kind = 'anchor'", id);
    case "screenshot": return column("SELECT resource_id AS id FROM screenshots WHERE id = ?", id);
    case "recording": return column("SELECT DISTINCT resource_id AS id FROM capture_events WHERE session_id = ? AND resource_id IS NOT NULL", id);
    default: return [];
  }
}
