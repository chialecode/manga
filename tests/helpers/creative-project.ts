import { createHash } from "node:crypto";
import { expect } from "vitest";
import type { startApp } from "./app.ts";

type App = Awaited<ReturnType<typeof startApp>>;
let counter = 0;

type Call = Awaited<ReturnType<App["app"]["call"]>>;

/** A command run as the owner; `ok` unwraps its value and fails the test with what the command said when it did not succeed. */
export function run(ctx: App, commandId: string, input: Record<string, unknown>, key?: string): Promise<Call> {
  counter += 1;
  return ctx.app.call(ctx.actor, { commandId, idempotencyKey: key ?? `cp-${counter}`, input }, ctx.grant.handle);
}
export function ok<T = Record<string, any>>(result: Call): T {
  expect(result.status, JSON.stringify(result)).toBe("ok");
  return result.value as T;
}
export const one = <T>(ctx: App, query: string, ...params: unknown[]) => ctx.app.store.sqlite.prepare(query).get(...params) as T;
export const all = <T>(ctx: App, query: string, ...params: unknown[]) => ctx.app.store.sqlite.prepare(query).all(...params) as T[];

export const PAGE_TEXT = "沙漠里的驼队在黄昏时分才开始赶路，星空低得像要落下来。他们沿着干涸的河床走了很久，直到月亮升起。";
export const OWNED_TABLES = ["whiteboards", "whiteboard_nodes", "whiteboard_edges", "mindmaps", "mindmap_nodes", "drafts", "draft_versions", "draft_suggestions", "excerpts", "rough_cuts", "rough_cut_clips", "embeds", "project_materials", "project_terms"];

/** A project that uses everything a project holds: references to personal material, a board and a map that point at each other and at notes, a draft with history, an excerpt of a page. */
export async function makeProject(ctx: App, name = "雨夜纪录片") {
  const book = ok<{ resourceId: string; revisionId: string; workId: string }>(await run(ctx, "library.importText", { title: "雨夜行人", bytes: [...Buffer.from("雨夜里，一个行人撑着伞走过石桥。\n桥下的水很深，倒映着整座城市的光。")] }));
  const noteA = ok<{ objectId: string }>(await run(ctx, "notes.create", { title: "笔记甲", text: "甲的第一段话，说的是雨夜与石桥。" })).objectId;
  const noteB = ok<{ objectId: string }>(await run(ctx, "notes.create", { title: "笔记乙", text: "乙的第一段话，说的是驼队。" })).objectId;
  const s = ctx.app.store.sqlite;
  s.prepare("INSERT INTO capture_sessions(id, clock_json, status, created_at, updated_at, stage, work_id) VALUES (?,?,?,?,?,?,?)").run("cap-1", "{}", "done", "2026-10-01T10:00:00.000Z", "2026-10-01T10:00:00.000Z", "done", book.workId);
  s.prepare("INSERT INTO transcript_segments(id, session_id, seq, chunk_key, start_ms, end_ms, text, revised_text, state, precision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("seg-1", "cap-1", 1, "c1", 1000, 4000, "语音里提到了海边的灯塔", null, "done", "segment", "2026-10-01T10:00:01.000Z", "2026-10-01T10:00:01.000Z");
  s.prepare("INSERT INTO excerpt_pages(id, url, title, fetched_at, content_hash, body_text, version, previous_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("pgv-1", "https://pages.example.org/desert", "沙漠网页", "2026-10-01T10:00:00.000Z", createHash("sha256").update(PAGE_TEXT).digest("hex"), PAGE_TEXT, 1, null, "2026-10-01T10:00:00.000Z");

  const projectId = ok<{ id: string }>(await run(ctx, "project.create", { name, goal: "做一支十分钟的解说" })).id;
  const excerptId = ok<{ excerpt: { id: string } }>(await run(ctx, "excerpt.create", { pageId: "pgv-1", start: 0, end: 26, title: "驼队", note: "可以当开场", projectId })).excerpt.id;
  for (const [kind, targetId] of [["work", book.workId], ["note", noteA], ["recording", "cap-1"], ["excerpt", excerptId]] as const) ok(await run(ctx, "project.addMaterial", { projectId, kind, targetId }));
  ok(await run(ctx, "project.addTerm", { projectId, term: "石桥", heard: "时桥", note: "地名" }));

  const mapId = ok<{ map: { id: string } }>(await run(ctx, "mindmap.create", { projectId, title: "结构导图", rootText: "解说结构" })).map.id;
  const rootId = ok<{ nodes: Array<{ id: string }> }>(await run(ctx, "mindmap.get", { mapId })).nodes[0]!.id;
  ok(await run(ctx, "mindmap.edit", { mapId, actions: [{ type: "addChild", parentId: rootId, id: "mm-child", text: "开场" }, { type: "addRef", nodeId: "mm-child", kind: "note", targetId: noteB }, { type: "addRef", nodeId: "mm-child", kind: "work", targetId: book.workId }] }));

  const boardId = ok<{ board: { id: string } }>(await run(ctx, "whiteboard.create", { projectId, title: "素材墙" })).board.id;
  ok(await run(ctx, "whiteboard.edit", { boardId, actions: [
    { type: "addNode", id: "wb-card", kind: "card", x: 0, y: 0, data: { title: "雨夜的石桥" } },
    { type: "addNode", id: "wb-text", kind: "text", x: 240, y: 0, data: { text: "想法" } },
    { type: "addNode", id: "wb-note", kind: "ref", x: 0, y: 200, data: { refKind: "note", targetId: noteA } },
    { type: "addNode", id: "wb-map", kind: "ref", x: 240, y: 200, data: { refKind: "mindmap", targetId: mapId, mode: "snapshot" } },
    { type: "addEdge", id: "wb-edge", sourceId: "wb-card", targetId: "wb-text", label: "引出" },
    { type: "group", ids: ["wb-card", "wb-text"], groupId: "wb-group", title: "想法组" },
  ] }));

  const draftId = ok<{ draft: { id: string } }>(await run(ctx, "draft.create", { projectId, title: "解说词", text: "第一稿" })).draft.id;
  ok(await run(ctx, "draft.save", { draftId, expectedVersion: 1, text: "第二稿，加了开场。" }));
  ok(await run(ctx, "draft.checkpoint", { draftId, label: "开场完成" }));
  const now = "2026-10-02T10:00:00.000Z";
  s.prepare("INSERT INTO draft_suggestions(id, draft_id, kind, instruction, status, base_version, base_text, result_text, sources_json, model_json, adopted_version, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("sug-done", draftId, "polish", "更简洁", "pending", 2, "第二稿，加了开场。", "第二稿，更简洁。", JSON.stringify([{ kind: "excerpt", targetId: excerptId }, { kind: "note", targetId: noteA }]), JSON.stringify({ connectionId: null }), null, now, now);
  s.prepare("INSERT INTO draft_suggestions(id, draft_id, kind, instruction, status, base_version, base_text, result_text, sources_json, model_json, adopted_version, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("sug-running", draftId, "continue", "", "running", 2, "第二稿，加了开场。", "", "[]", null, null, now, now);
  s.prepare("INSERT INTO rough_cuts(id, project_id, title, created_at, updated_at) VALUES (?,?,?,?,?)").run("cut-1", projectId, "第一版粗剪", now, now);
  s.prepare("INSERT INTO rough_cut_clips(id, cut_id, resource_id, resource_revision_id, in_ms, out_ms, sort_key, label, created_at) VALUES (?,?,?,?,?,?,?,?,?)").run("clip-1", "cut-1", book.resourceId, book.revisionId, 1000, 5000, "a0", "开头", now);
  return { projectId, book, noteA, noteB, excerptId, mapId, boardId, draftId };
}
