import { createHash } from "node:crypto";
import type { ProposalTarget, ProposalTargetKind } from "@manga/contracts";
import type { DrizzleStore } from "@manga/storage-drizzle";
import { BUNDLE_LIMITS } from "./bundle.ts";
import type { EmbedService } from "./embeds.ts";
import { describeObject, isObjectKind, type ObjectKind } from "./objects.ts";
import { formatClock } from "./roughcut-plan.ts";

export const KIND_LABELS: Record<ProposalTargetKind, string> = {
  whiteboard: "白板",
  mindmap: "导图",
  draft: "文稿",
  roughcut: "粗剪",
  project: "项目",
};

export const SOURCE_KIND_LABELS: Record<string, string> = {
  note: "笔记",
  whiteboard: "白板",
  mindmap: "导图",
  draft: "文稿",
  roughcut: "粗剪",
  project: "项目",
};

export const MODULE_CHECKS: Record<ProposalTargetKind, { commandId: string; label: string }> = {
  whiteboard: { commandId: "whiteboard.list", label: "whiteboards" },
  mindmap: { commandId: "mindmap.list", label: "mind maps" },
  draft: { commandId: "draft.list", label: "drafts" },
  roughcut: { commandId: "roughcut.list", label: "rough cuts" },
  project: { commandId: "project.list", label: "projects" },
};

export const SYNC_OWNER_COMMANDS = new Set([
  "whiteboard.delete", "mindmap.delete", "draft.delete", "roughcut.delete",
  "whiteboard.rename", "mindmap.rename", "draft.rename", "roughcut.rename", "project.update", "roughcut.edit",
]);

export function formatDuration(ms: number): string {
  const safe = Math.max(0, Math.round(ms));
  const sec = (safe / 1000).toFixed(safe % 1000 === 0 ? 0 : 1);
  return `${formatClock(safe)}（${sec} 秒）`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

export function shortHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

export function parseJsonObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** Owner diagnostics can contain host paths or arbitrary provider text; the model only needs a concise failure category. */
export function decisionFailureReason(error: { code?: string; details?: { reason?: string } } | undefined): string {
  if (error?.details?.reason === "module-disabled") return "模块已关闭";
  const reasons: Record<string, string> = {
    CANCELLED: "用户取消了导出，需要时请重新提出",
    INTERRUPTED: "应用退出中断了操作，需要时请重新提出",
    LOCATION_UNAVAILABLE: "保存位置不可用，请用户检查后再提出",
    DISK_FULL: "保存位置空间不足，请用户检查后再提出",
    NOT_FOUND: "对象或所需文件已不存在，请先读取最新状态",
    UNSUPPORTED_FORMAT: "导出格式或片段不兼容，请先检查导出计划",
    VALIDATION_ERROR: "当前内容或操作参数不符合要求，请先读取最新状态",
    CAPABILITY_UNAVAILABLE: "所需功能当前不可用，请用户检查应用设置",
    FORBIDDEN: "当前操作不在授权范围内",
    SCOPE_DENIED: "目标已不在本次操作范围内",
    GRANT_REVOKED: "本次操作的授权已失效",
    EPOCH_MISMATCH: "所需模块的状态已改变",
  };
  return reasons[error?.code ?? ""] ?? "命令未完成，请用户在应用中查看具体原因";
}

export function idFieldOf(kind: Exclude<ProposalTargetKind, "project">): "boardId" | "mapId" | "draftId" | "cutId" {
  switch (kind) {
    case "whiteboard": return "boardId";
    case "mindmap": return "mapId";
    case "draft": return "draftId";
    case "roughcut": return "cutId";
  }
}

/** Reads the current revision of a target object; returns `null` when it has been deleted or moved out of the project. */
export function findTargetState(sqlite: DrizzleStore["sqlite"], kind: ProposalTargetKind, targetId: string, projectId: string): ProposalTarget | null {
  switch (kind) {
    case "project": {
      if (targetId !== projectId) return null;
      const row = sqlite.prepare("SELECT id, name, goal, status, updated_at FROM projects WHERE id = ?").get(projectId) as {
        id: string; name: string; goal: string; status: string; updated_at: string;
      } | undefined;
      if (!row) return null;
      return {
        kind: "project",
        targetId: row.id,
        title: row.name,
        revision: `proj:${row.updated_at}:${shortHash(row)}`,
      };
    }
    case "whiteboard": {
      const row = sqlite.prepare("SELECT id, project_id, title, updated_at FROM whiteboards WHERE id = ?").get(targetId) as {
        id: string; project_id: string | null; title: string; updated_at: string;
      } | undefined;
      if (!row || row.project_id !== projectId) return null;
      const ops = sqlite.prepare("SELECT COUNT(*) AS total, COALESCE(MAX(id), 0) AS maxId, COALESCE(SUM(CASE WHEN undone = 0 THEN 1 ELSE 0 END), 0) AS active FROM creative_ops WHERE doc_kind = 'whiteboard' AND doc_id = ?").get(targetId) as { total: number; maxId: number; active: number };
      const nodes = sqlite.prepare("SELECT id, kind, x, y, w, h, z, parent_id, data_json, updated_at FROM whiteboard_nodes WHERE board_id = ? ORDER BY id").all(targetId);
      const edges = sqlite.prepare("SELECT id, source_id, target_id, label FROM whiteboard_edges WHERE board_id = ? ORDER BY id").all(targetId);
      return {
        kind: "whiteboard",
        targetId: row.id,
        title: row.title,
        revision: `wb:op${ops.active}:${shortHash({ title: row.title, updatedAt: row.updated_at, ops, nodes, edges })}`,
      };
    }
    case "mindmap": {
      const row = sqlite.prepare("SELECT id, project_id, title, theme, updated_at FROM mindmaps WHERE id = ?").get(targetId) as {
        id: string; project_id: string | null; title: string; theme: string; updated_at: string;
      } | undefined;
      if (!row || row.project_id !== projectId) return null;
      const ops = sqlite.prepare("SELECT COUNT(*) AS total, COALESCE(MAX(id), 0) AS maxId, COALESCE(SUM(CASE WHEN undone = 0 THEN 1 ELSE 0 END), 0) AS active FROM creative_ops WHERE doc_kind = 'mindmap' AND doc_id = ?").get(targetId) as { total: number; maxId: number; active: number };
      const nodes = sqlite.prepare("SELECT id, parent_id, sort_key, text, collapsed, refs_json, updated_at FROM mindmap_nodes WHERE map_id = ? ORDER BY id").all(targetId);
      return {
        kind: "mindmap",
        targetId: row.id,
        title: row.title,
        revision: `mm:op${ops.active}:${shortHash({ title: row.title, theme: row.theme, updatedAt: row.updated_at, ops, nodes })}`,
      };
    }
    case "draft": {
      const row = sqlite.prepare("SELECT id, project_id, title, text, version, updated_at FROM drafts WHERE id = ?").get(targetId) as {
        id: string; project_id: string | null; title: string; text: string; version: number; updated_at: string;
      } | undefined;
      if (!row || row.project_id !== projectId) return null;
      return {
        kind: "draft",
        targetId: row.id,
        title: row.title,
        revision: `dr:v${row.version}:${shortHash({ title: row.title, version: row.version, updatedAt: row.updated_at, text: row.text })}`,
      };
    }
    case "roughcut": {
      const row = sqlite.prepare("SELECT id, project_id, title, updated_at FROM rough_cuts WHERE id = ?").get(targetId) as {
        id: string; project_id: string | null; title: string; updated_at: string;
      } | undefined;
      if (!row || row.project_id !== projectId) return null;
      const ops = sqlite.prepare("SELECT COUNT(*) AS total, COALESCE(MAX(id), 0) AS maxId, COALESCE(SUM(CASE WHEN undone = 0 THEN 1 ELSE 0 END), 0) AS active FROM creative_ops WHERE doc_kind = 'roughcut' AND doc_id = ?").get(targetId) as { total: number; maxId: number; active: number };
      const clips = sqlite.prepare("SELECT id, resource_id, resource_revision_id, in_ms, out_ms, sort_key, label FROM rough_cut_clips WHERE cut_id = ? ORDER BY sort_key, id").all(targetId);
      return {
        kind: "roughcut",
        targetId: row.id,
        title: row.title,
        revision: `rc:op${ops.active}:${shortHash({ title: row.title, updatedAt: row.updated_at, ops, clips })}`,
      };
    }
  }
}

export function collectBacklinks(
  sqlite: DrizzleStore["sqlite"],
  embeds: EmbedService,
  kind: Exclude<ProposalTargetKind, "project">,
  targetId: string,
): Array<{ sourceKind: string; sourceId: string; title: string }> {
  const seen = new Map<string, { sourceKind: string; sourceId: string; title: string }>();
  if (kind === "whiteboard" || kind === "mindmap") {
    for (const item of embeds.backlinks(kind, targetId)) {
      const key = `${item.sourceKind}:${item.sourceId}`;
      if (!seen.has(key)) seen.set(key, { sourceKind: item.sourceKind, sourceId: item.sourceId, title: item.title || item.sourceId });
    }
  }
  const wbRefs = sqlite.prepare(`
    SELECT w.id AS boardId, w.title AS title, n.data_json AS dataJson
    FROM whiteboard_nodes n JOIN whiteboards w ON w.id = n.board_id
    WHERE n.kind = 'ref' AND instr(n.data_json, ?) > 0
  `).all(targetId) as Array<{ boardId: string; title: string; dataJson: string }>;
  for (const ref of wbRefs) {
    if (kind === "whiteboard" && ref.boardId === targetId) continue;
    const parsed = parseJsonObject(ref.dataJson);
    const refKind = parsed?.refKind ?? parsed?.kind ?? (parsed?.ref as Record<string, unknown> | undefined)?.kind;
    const refId = parsed?.refId ?? parsed?.targetId ?? parsed?.id ?? (parsed?.ref as Record<string, unknown> | undefined)?.id ?? (parsed?.ref as Record<string, unknown> | undefined)?.targetId;
    if (refKind === kind && refId === targetId) {
      const key = `whiteboard:${ref.boardId}`;
      if (!seen.has(key)) seen.set(key, { sourceKind: "whiteboard", sourceId: ref.boardId, title: ref.title });
    }
  }
  const mmRefs = sqlite.prepare(`
    SELECT m.id AS mapId, m.title AS title, n.refs_json AS refsJson
    FROM mindmap_nodes n JOIN mindmaps m ON m.id = n.map_id
    WHERE n.refs_json <> '[]' AND instr(n.refs_json, ?) > 0
  `).all(targetId) as Array<{ mapId: string; title: string; refsJson: string }>;
  for (const ref of mmRefs) {
    if (kind === "mindmap" && ref.mapId === targetId) continue;
    try {
      const items = JSON.parse(ref.refsJson) as Array<{ kind?: string; targetId?: string; id?: string }>;
      if (Array.isArray(items) && items.some((item) => item.kind === kind && (item.targetId === targetId || item.id === targetId))) {
        const key = `mindmap:${ref.mapId}`;
        if (!seen.has(key)) seen.set(key, { sourceKind: "mindmap", sourceId: ref.mapId, title: ref.title });
      }
    } catch { /* ignore malformed json */ }
  }
  const materialRefs = sqlite.prepare(`
    SELECT pm.project_id AS projectId, p.name AS title
    FROM project_materials pm JOIN projects p ON p.id = pm.project_id
    WHERE pm.kind = ? AND pm.target_id = ?
  `).all(kind, targetId) as Array<{ projectId: string; title: string }>;
  for (const ref of materialRefs) {
    const key = `project:${ref.projectId}`;
    if (!seen.has(key)) seen.set(key, { sourceKind: "project", sourceId: ref.projectId, title: ref.title });
  }
  return [...seen.values()];
}

function collectJsonRefs(value: unknown, visit: (kind: string, id: string) => void): void {
  if (Array.isArray(value)) { for (const item of value) collectJsonRefs(item, visit); return; }
  if (!value || typeof value !== "object") return;
  const obj = value as Record<string, unknown>;
  const kind = typeof obj.refKind === "string" ? obj.refKind : typeof obj.kind === "string" ? obj.kind : null;
  if (kind && typeof obj.targetId === "string") visit(kind, obj.targetId);
  for (const child of Object.values(obj)) collectJsonRefs(child, visit);
}

/**
 * Lightweight digest and byte estimate for a project export proposal: hashes project content and referenced external
 * materials directly from SQLite without building or zipping the package (and ignoring view-only state like board viewports,
 * saved workspace tabs, and reading progress).
 */
export function projectExportFingerprint(store: DrizzleStore, projectId: string): { digest: string; estimatedBytes: number } | null {
  const sqlite = store.sqlite;
  const project = sqlite.prepare("SELECT id, name, goal, status, model_connection_id, created_at, updated_at FROM projects WHERE id = ?").get(projectId) as Record<string, unknown> | undefined;
  if (!project) return null;
  const hash = createHash("sha256");
  let estimatedBytes = 512;
  const feed = (tag: string, value: unknown, extraBytes = 0) => {
    const serialized = JSON.stringify(value);
    hash.update(tag).update("\0").update(serialized).update("\0");
    estimatedBytes += Buffer.byteLength(serialized, "utf8") + extraBytes;
  };
  const inList = (ids: string[]) => ids.map(() => "?").join(",") || "NULL";

  feed("project", project);
  const materials = sqlite.prepare("SELECT id, kind, target_id, label, sort_order, added_at, origin FROM project_materials WHERE project_id = ? ORDER BY sort_order, added_at, id").all(projectId) as Array<{ id: string; kind: string; target_id: string }>;
  feed("project_materials", materials);
  const terms = sqlite.prepare("SELECT id, term, heard, note, created_at FROM project_terms WHERE project_id = ? ORDER BY created_at, rowid").all(projectId);
  feed("project_terms", terms);

  const boards = sqlite.prepare("SELECT id, title, created_at, updated_at FROM whiteboards WHERE project_id = ? ORDER BY created_at, id").all(projectId) as Array<{ id: string }>;
  const boardIds = boards.map((row) => row.id);
  feed("whiteboards", boards);
  const boardNodes = boardIds.length
    ? sqlite.prepare(`SELECT id, board_id, kind, x, y, w, h, z, parent_id, data_json, updated_at FROM whiteboard_nodes WHERE board_id IN (${inList(boardIds)}) ORDER BY z, created_at, id`).all(...boardIds) as Array<{ data_json: string }>
    : [];
  const boardEdges = boardIds.length
    ? sqlite.prepare(`SELECT id, board_id, source_id, target_id, label FROM whiteboard_edges WHERE board_id IN (${inList(boardIds)}) ORDER BY created_at, id`).all(...boardIds)
    : [];
  feed("whiteboard_nodes", boardNodes);
  feed("whiteboard_edges", boardEdges);

  const maps = sqlite.prepare("SELECT id, title, theme, created_at, updated_at FROM mindmaps WHERE project_id = ? ORDER BY created_at, id").all(projectId) as Array<{ id: string }>;
  const mapIds = maps.map((row) => row.id);
  feed("mindmaps", maps);
  const mapNodes = mapIds.length
    ? sqlite.prepare(`SELECT id, map_id, parent_id, sort_key, text, collapsed, refs_json, updated_at FROM mindmap_nodes WHERE map_id IN (${inList(mapIds)}) ORDER BY created_at, id`).all(...mapIds) as Array<{ refs_json: string }>
    : [];
  feed("mindmap_nodes", mapNodes);

  const drafts = sqlite.prepare("SELECT id, title, version, updated_at, LENGTH(text) AS textLen FROM drafts WHERE project_id = ? ORDER BY created_at, id").all(projectId) as Array<{ id: string; textLen: number }>;
  const draftIds = drafts.map((row) => row.id);
  feed("drafts", drafts, drafts.reduce((sum, row) => sum + row.textLen, 0));
  const draftVersions = draftIds.length
    ? sqlite.prepare(`SELECT id, draft_id, version, label, created_at, LENGTH(text) AS textLen FROM draft_versions WHERE draft_id IN (${inList(draftIds)}) ORDER BY draft_id, version`).all(...draftIds) as Array<{ textLen: number }>
    : [];
  feed("draft_versions", draftVersions, draftVersions.reduce((sum, row) => sum + row.textLen, 0));
  const draftSuggestions = draftIds.length
    ? sqlite.prepare(`SELECT id, draft_id, kind, status, base_version, adopted_version, updated_at, LENGTH(base_text) + LENGTH(result_text) + LENGTH(sources_json) AS bytes FROM draft_suggestions WHERE draft_id IN (${inList(draftIds)}) AND status <> 'running' ORDER BY created_at, id`).all(...draftIds) as Array<{ bytes: number }>
    : [];
  feed("draft_suggestions", draftSuggestions, draftSuggestions.reduce((sum, row) => sum + row.bytes, 0));

  const excerpts = sqlite.prepare("SELECT id, page_id, title, start_offset, end_offset, note, created_at, LENGTH(text) AS textLen FROM excerpts WHERE project_id = ? ORDER BY created_at, id").all(projectId) as Array<{ id: string; page_id: string; textLen: number }>;
  feed("excerpts", excerpts, excerpts.reduce((sum, row) => sum + row.textLen, 0));
  const pageIds = [...new Set(excerpts.map((row) => row.page_id))];
  const excerptPages = pageIds.length
    ? sqlite.prepare(`SELECT id, url, title, fetched_at, content_hash, version, previous_id, LENGTH(body_text) AS bodyLen FROM excerpt_pages WHERE id IN (${inList(pageIds)}) ORDER BY url, version`).all(...pageIds) as Array<{ bodyLen: number }>
    : [];
  feed("excerpt_pages", excerptPages, excerptPages.reduce((sum, row) => sum + row.bodyLen, 0));

  const cuts = sqlite.prepare("SELECT id, title, created_at, updated_at FROM rough_cuts WHERE project_id = ? ORDER BY created_at, id").all(projectId) as Array<{ id: string }>;
  const cutIds = cuts.map((row) => row.id);
  feed("rough_cuts", cuts);
  const clips = cutIds.length
    ? sqlite.prepare(`SELECT id, cut_id, resource_id, resource_revision_id, in_ms, out_ms, sort_key, label FROM rough_cut_clips WHERE cut_id IN (${inList(cutIds)}) ORDER BY cut_id, sort_key`).all(...cutIds) as Array<{ resource_id: string }>
    : [];
  feed("rough_cut_clips", clips);

  const embedSources = [...boardIds.map((id) => ["whiteboard", id]), ...mapIds.map((id) => ["mindmap", id])] as Array<[string, string]>;
  const embeds = embedSources.length
    ? sqlite.prepare(`SELECT id, source_kind, source_id, slot, target_kind, target_id, locator_json, mode, snapshot_version, updated_at FROM embeds WHERE ${embedSources.map(() => "(source_kind = ? AND source_id = ?)").join(" OR ")} ORDER BY created_at, id`).all(...embedSources.flat()) as Array<{ target_kind: string; target_id: string }>
    : [];
  feed("embeds", embeds);

  // Hash referenced external objects (notes, recordings, works, resources, anchors, external excerpts) so changes to snapshot material mark export proposals stale.
  const owned = new Map<string, Set<string>>([
    ["whiteboard", new Set(boardIds)],
    ["mindmap", new Set(mapIds)],
    ["draft", new Set(draftIds)],
    ["excerpt", new Set(excerpts.map((row) => row.id))],
    ["roughcut", new Set(cutIds)],
  ]);
  const external = new Map<string, { kind: ObjectKind; id: string }>();
  const want = (kind: string, id: string) => {
    if (!id || !isObjectKind(kind) || owned.get(kind)?.has(id)) return;
    external.set(`${kind}:${id}`, { kind, id });
  };
  for (const row of materials) want(row.kind, row.target_id);
  for (const row of embeds) want(row.target_kind, row.target_id);
  for (const row of boardNodes) { try { collectJsonRefs(JSON.parse(row.data_json), want); } catch { /* ignore */ } }
  for (const row of mapNodes) { try { collectJsonRefs(JSON.parse(row.refs_json), want); } catch { /* ignore */ } }
  for (const row of clips) want("resource", row.resource_id);

  const keys = [...external.keys()].sort().slice(0, BUNDLE_LIMITS.snapshots);
  for (const key of keys) {
    const { kind, id } = external.get(key)!;
    if (kind === "note") {
      const note = sqlite.prepare("SELECT title, revision, updated_at, deleted_at, LENGTH(payload_json) AS bytes FROM content_objects WHERE id = ?").get(id) as { bytes: number } | undefined;
      feed(`ref:${key}`, note ?? null, Math.min(note?.bytes ?? 0, BUNDLE_LIMITS.snapshotText));
    } else if (kind === "recording") {
      const rec = sqlite.prepare("SELECT id, created_at FROM capture_sessions WHERE id = ?").get(id);
      const segs = rec ? sqlite.prepare("SELECT COALESCE(NULLIF(revised_text, ''), text) AS t FROM transcript_segments WHERE session_id = ? ORDER BY seq").all(id) : [];
      feed(`ref:${key}`, { rec: rec ?? null, segs });
    } else if (kind === "work") {
      const work = sqlite.prepare("SELECT title, updated_at FROM works WHERE id = ?").get(id);
      const res = work ? sqlite.prepare("SELECT title FROM resources WHERE work_id = ? ORDER BY sort_key, created_at LIMIT 20").all(id) : [];
      feed(`ref:${key}`, { work: work ?? null, res });
    } else if (kind === "excerpt") {
      const exc = sqlite.prepare("SELECT title, text, note FROM excerpts WHERE id = ?").get(id);
      feed(`ref:${key}`, exc ?? null);
    } else if (kind === "anchor") {
      const anc = sqlite.prepare("SELECT locator_json, preview_json FROM anchors WHERE id = ?").get(id);
      feed(`ref:${key}`, anc ?? null);
    } else {
      const found = describeObject(store, kind, id);
      feed(`ref:${key}`, found.exists ? { label: found.label } : null);
    }
  }

  return { digest: hash.digest("hex").slice(0, 16), estimatedBytes };
}
