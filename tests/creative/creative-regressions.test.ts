import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { DrizzleStore } from "@manga/storage-drizzle";
import { checkBundle, collectBundle } from "../../packages/app-core/src/creative/bundle.ts";
import { DraftService } from "../../packages/app-core/src/creative/drafts.ts";
import { EmbedService } from "../../packages/app-core/src/creative/embeds.ts";
import { safeFileName } from "../../packages/app-core/src/creative/export-file.ts";
import { MindmapService } from "../../packages/app-core/src/creative/mindmap.ts";
import { OpLog } from "../../packages/app-core/src/creative/ops.ts";
import { ProjectService } from "../../packages/app-core/src/creative/projects.ts";
import { ProposalService } from "../../packages/app-core/src/creative/proposals.ts";
import { ResearchService } from "../../packages/app-core/src/creative/research.ts";
import { planClipCut, primaryVideoStreamIndex } from "../../packages/app-core/src/creative/roughcut-plan.ts";
import { RoughcutService } from "../../packages/app-core/src/creative/roughcut.ts";
import { WhiteboardService } from "../../packages/app-core/src/creative/whiteboard.ts";
import { cleanupManualScan } from "../../packages/app-core/src/library-scan/cleanup.ts";
import { MediaServices } from "../../packages/app-core/src/media/index.ts";
import { VideoService } from "../../packages/app-core/src/video/service.ts";
import type { LlmPort } from "../../packages/app-core/src/voice/ports.ts";
import { WorkFolders } from "../../packages/app-core/src/work-folders.ts";
import { libraryRoot, startApp } from "../helpers/app.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "manga-creative-reg-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function fakeLlm(complete: LlmPort["complete"]): LlmPort {
  return {
    resolve: () => ({ id: "conn-1", model: "test-model", supportsStreaming: false }),
    complete,
  };
}

function makeEnv(name: string) {
  const dir = path.join(root, name);
  const store = new DrizzleStore({ profileDir: path.join(dir, "data"), hostId: `cr-${name}`, attachmentsDir: path.join(dir, "att") });
  const media = new MediaServices({ cacheDir: path.join(dir, "cache"), tools: null });
  const ops = new OpLog(store);
  const embeds = new EmbedService(store);
  const projects = new ProjectService(store);
  const whiteboards = new WhiteboardService(store, ops, embeds);
  const mindmaps = new MindmapService(store, ops, embeds);
  const drafts = new DraftService(store, {
    llm: () => fakeLlm(async () => "generated"),
    notify: () => undefined,
  });
  const research = new ResearchService(store, {
    broker: {
      fetchText: async (requestedUrl: string) => ({
        requestedUrl,
        finalUrl: requestedUrl,
        contentType: "text/html",
        text: "<!doctype html><html><head><title>Fetched</title></head><body><article><p>Freshly fetched article body with enough words to excerpt safely.</p></article></body></html>",
      }),
    } as never,
  });
  const videos = new VideoService(store, media);
  const folders = new WorkFolders(store, path.join(dir, "works"));
  const roughcuts = new RoughcutService({ store, ops, videos, ffmpeg: media.ffmpeg, folders, stagingRoot: path.join(dir, "staging"), notify: () => undefined });
  return {
    dir, store, media, ops, embeds, projects, whiteboards, mindmaps, drafts, research, videos, folders, roughcuts,
    close: () => { media.dispose(); store.close(); },
  };
}

describe("creative & cleanup regressions", () => {
  it("cleanupManualScan protects project_materials & user covers and defers forget callbacks until after commit", () => {
    const env = makeEnv("cleanup-safety");
    try {
      const libDir = path.join(env.dir, "lib");
      fs.mkdirSync(libDir, { recursive: true });
      const lpPath = libraryRoot({ store: env.store }, libDir, "comic");
      const lp = env.store.sqlite.prepare("SELECT id FROM library_paths WHERE path = ?").get(lpPath) as { id: string };
      const now = new Date().toISOString();

      const seedMissing = (workId: string, resourceId: string, revisionId: string, rel: string) => {
        env.store.sqlite.prepare("INSERT INTO works(id, title, media_kind, created_at, updated_at) VALUES (?,?,?,?,?)").run(workId, workId, "comic", now, now);
        env.store.sqlite.prepare("INSERT INTO resources(id, work_id, kind, title, aliases_json, created_at, sort_key) VALUES (?,?,?,?,?,?,?)").run(resourceId, workId, "comic", rel, "[]", now, "");
        env.store.sqlite.prepare("INSERT INTO resource_revisions(id, resource_id, fingerprint, parser_version, payload_json, created_at) VALUES (?,?,?,?,?,?)").run(revisionId, resourceId, `fp_${revisionId}`, "v1", "{}", now);
        env.store.sqlite.prepare("INSERT INTO file_locations(id, resource_revision_id, library_path_id, relative_path, fingerprint, available, hosted) VALUES (?,?,?,?,?,0,0)").run(`fl_${revisionId}`, revisionId, lp.id, rel, `fp_${revisionId}`);
        env.store.sqlite.prepare("INSERT INTO library_files(path_id, relative_path, state, resource_id, size, mtime_ms, updated_at) VALUES (?,?,?,?,?,?,?)").run(lp.id, rel, "missing", resourceId, 1024, 1, now);
      };

      // Work 1: referenced by project_materials -> MUST survive.
      seedMissing("wrk_mat", "res_mat", "rev_mat", "mat.cbz");
      const project = env.projects.create({ name: "MyProject" });
      env.projects.addMaterial({ projectId: project.id, kind: "work", targetId: "wrk_mat" });

      // Work 2: user-locked cover -> MUST survive.
      seedMissing("wrk_cov", "res_cov", "rev_cov", "cov.cbz");
      env.store.sqlite.prepare("UPDATE works SET cover_state = 'user' WHERE id = ?").run("wrk_cov");

      // Work 3: no user content -> eligible to purge, AND if commit throws, host.forget* must NOT fire.
      seedMissing("wrk_del", "res_del", "rev_del", "del.cbz");

      const forgottenRevs: string[] = [];
      const forgottenCovers: string[][] = [];
      const host = {
        assertWritable: () => undefined,
        forgetRevision: (rev: string) => forgottenRevs.push(rev),
        forgetWorkCovers: (ids: readonly string[]) => forgottenCovers.push([...ids]),
      };

      const commitSpy = vi.spyOn(env.store, "commit").mockImplementationOnce(() => { throw new Error("simulated commit failure"); });
      expect(() => cleanupManualScan(env.store, host, { id: lp.id, path: libDir }, [])).toThrow("simulated commit failure");
      commitSpy.mockRestore();
      expect(forgottenRevs).toEqual([]);
      expect(forgottenCovers).toEqual([]);

      const result = cleanupManualScan(env.store, host, { id: lp.id, path: libDir }, []);
      expect(result.removedWorks).toBe(1);
      expect(result.removedResources).toBe(1);
      expect(forgottenRevs).toEqual(["rev_del"]);
      expect(forgottenCovers).toEqual([["wrk_del"]]);
      expect(env.store.sqlite.prepare("SELECT id FROM works ORDER BY id").all()).toEqual([{ id: "wrk_cov" }, { id: "wrk_mat" }]);
    } finally {
      env.close();
    }
  });

  it("EmbedService.sync handles missing snapshot targets and duplicate slots without crashing", () => {
    const env = makeEnv("embed-sync");
    try {
      const prj = env.projects.create({ name: "Embeds" });
      const board = env.whiteboards.create({ projectId: prj.id, title: "B" });
      expect(() => env.embeds.sync("whiteboard", board.id, [
        { slot: "s1", targetKind: "mindmap", targetId: "mm_deleted", mode: "snapshot" },
        { slot: "s1", targetKind: "mindmap", targetId: "mm_deleted_2", mode: "snapshot" },
      ])).not.toThrow();
      const rows = env.store.sqlite.prepare("SELECT slot, target_id, snapshot_json FROM embeds WHERE source_id = ?").all(board.id) as Array<{ slot: string; target_id: string; snapshot_json: string | null }>;
      expect(rows).toEqual([{ slot: "s1", target_id: "mm_deleted_2", snapshot_json: null }]);
    } finally {
      env.close();
    }
  });

  it("ResearchService.prune keeps newly fetched version when 20 older versions have excerpts; follow() matches whitespace linearly; create() validates offsets", async () => {
    const env = makeEnv("research-prune");
    try {
      const url = "https://example.org/article";
      const now = new Date().toISOString();
      const prj = env.projects.create({ name: "Research" });
      // Seed 20 older versions all referenced by excerpts.
      for (let i = 1; i <= 20; i += 1) {
        const pageId = `pgv_old_${i}`;
        const body = `Article version ${i} content with some notable sentence.`;
        env.store.sqlite.prepare("INSERT INTO excerpt_pages(id, url, title, fetched_at, content_hash, body_text, version, previous_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
          .run(pageId, url, "Title", new Date(Date.now() - (30 - i) * 60_000).toISOString(), createHash("sha256").update(body).digest("hex"), body, i, i > 1 ? `pgv_old_${i - 1}` : null, now);
        env.research.create({ pageId, start: 0, end: 15, title: `Ex ${i}`, projectId: prj.id });
      }
      // Fetch v21 with new content: prune() MUST NOT delete the newly created v21!
      const fresh = await env.research.fetch(url);
      expect(fresh.page.version).toBe(21);
      expect(env.store.sqlite.prepare("SELECT id FROM excerpt_pages WHERE id = ?").get(fresh.page.id)).toEqual({ id: fresh.page.id });

      // Out-of-range offsets rejected; linear whitespace follow() works on long text.
      expect(() => env.research.create({ pageId: fresh.page.id, start: 0, end: 999999, title: "TooLong", projectId: prj.id })).toThrowError(/outside|range|bounds/i);
      const longBody = `${"word ".repeat(5000)}alpha   \n\t  beta   gamma${" tail".repeat(5000)}`;
      env.store.sqlite.prepare("INSERT INTO excerpt_pages(id, url, title, fetched_at, content_hash, body_text, version, previous_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .run("pgv_v1", "https://example.org/ws", "WS", now, "h1", "prefix alpha beta gamma suffix", 1, null, now);
      env.store.sqlite.prepare("INSERT INTO excerpt_pages(id, url, title, fetched_at, content_hash, body_text, version, previous_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .run("pgv_v2", "https://example.org/ws", "WS", now, "h2", longBody, 2, "pgv_v1", now);
      const ex = env.research.create({ pageId: "pgv_v1", start: 7, end: 23, title: "WS", projectId: prj.id });
      const followed = env.research.follow(ex.id);
      expect(followed.status).toBe("found");
      expect(followed.excerpt?.text.replace(/\s+/g, " ")).toBe("alpha beta gamma");
    } finally {
      env.close();
    }
  });

  it("checkBundle rejects corrupted board/mindmap graphs & invalid sort_key; mindmap/roughcut self-heal legacy 'a0' keys; whiteboard rejects nested groups; safeFileName handles reserved stems & 80-char trailing dots", () => {
    const env = makeEnv("bundle-graph");
    try {
      const prj = env.projects.create({ name: "Graph" });
      const boardA = env.whiteboards.create({ projectId: prj.id, title: "A" });
      const boardB = env.whiteboards.create({ projectId: prj.id, title: "B" });
      env.whiteboards.edit({
        boardId: boardA.id,
        actions: [
          { type: "addNode", id: "g1", kind: "group", x: 0, y: 0, w: 300, h: 300, data: { title: "G1" } },
          { type: "addNode", id: "c1", kind: "card", x: 10, y: 10, data: { title: "C1" } },
        ],
      });
      // Nested group rejected in addNode.
      expect(() => env.whiteboards.edit({ boardId: boardA.id, actions: [{ type: "addNode", id: "g2", kind: "group", parentId: "g1", x: 10, y: 10, data: { title: "G2" } }] })).toThrowError(/group/i);

      env.whiteboards.edit({ boardId: boardB.id, actions: [{ type: "addNode", id: "c2", kind: "card", x: 0, y: 0, data: { title: "C2" } }] });
      const map = env.mindmaps.create({ projectId: prj.id, title: "M", rootText: "Root" });
      const rootNodeId = env.mindmaps.get(map.id).nodes[0]!.id;
      env.mindmaps.edit({ mapId: map.id, actions: [{ type: "addChild", id: "n1", parentId: rootNodeId, text: "Child" }] });

      // Self-heal legacy "a0" sort key on edit without crashing.
      env.store.sqlite.prepare("UPDATE mindmap_nodes SET sort_key = 'a0' WHERE id = 'n1'").run();
      expect(() => env.mindmaps.edit({ mapId: map.id, actions: [{ type: "addChild", id: "n2", parentId: rootNodeId, text: "Child2" }] })).not.toThrow();

      const valid = collectBundle(env.store, prj.id);
      expect(() => checkBundle(valid)).not.toThrow();

      // Cross-board edge rejected.
      const crossEdge = structuredClone(valid);
      crossEdge.tables.whiteboard_edges.push({ id: "wbe_bad", board_id: boardA.id, source_id: "c1", target_id: "c2", label: "", created_at: new Date().toISOString() });
      expect(() => checkBundle(crossEdge)).toThrowError(/board/i);

      // Mindmap cycle rejected.
      const cycle = structuredClone(valid);
      const rootRow = cycle.tables.mindmap_nodes.find((row) => row.id === rootNodeId)!;
      rootRow.parent_id = "n1";
      expect(() => checkBundle(cycle)).toThrowError(/cycle/i);

      // Malformed sort_key rejected.
      const badKey = structuredClone(valid);
      badKey.tables.mindmap_nodes[0]!.sort_key = "BAD KEY!";
      expect(() => checkBundle(badKey)).toThrowError(/sort key/i);

      // safeFileName neutralizes Windows reserved names with extensions & trailing dots after 80-char truncation.
      expect(safeFileName("nul.txt", "fallback")).not.toMatch(/^nul\./i);
      expect(safeFileName(`${"a".repeat(79)}. trailing`, "fallback")).not.toMatch(/[. ]$/);

      // addTerm allows updating an existing term even at MAX_TERMS (2000).
      const now = new Date().toISOString();
      const stmt = env.store.sqlite.prepare("INSERT INTO project_terms(id, project_id, term, heard, note, created_at) VALUES (?,?,?,?,?,?)");
      env.store.sqlite.transaction(() => {
        for (let i = 0; i < 2000; i += 1) stmt.run(`ptm_${i}`, prj.id, `term_${i}`, null, null, now);
      })();
      expect(() => env.projects.addTerm({ projectId: prj.id, term: "  term_0  ", note: "updated" })).not.toThrow();
      expect(() => env.projects.addTerm({ projectId: prj.id, term: "term_2001" })).toThrowError(/too many|limit/i);
    } finally {
      env.close();
    }
  });

  it("planClipCut enforces frames >= 1 for sub-frame spans and primaryVideoStreamIndex skips attached_pic", () => {
    const cut = planClipCut({ inMs: 100, outMs: 110 }, { ptsMs: [0, 42, 84, 126, 168], keyframesMs: [0, 1000] }, 2000);
    expect(cut.frames).toBeGreaterThanOrEqual(1);
    expect(cut.actualOutMs).toBeGreaterThan(cut.actualInMs);

    const probe = {
      streams: [
        { index: 0, codec_type: "video", codec_name: "mjpeg", width: 200, height: 200, disposition: { attached_pic: 1 } },
        { index: 1, codec_type: "video", codec_name: "h264", width: 1280, height: 720, r_frame_rate: "24/1" },
      ],
    };
    expect(primaryVideoStreamIndex(probe)).toBe(1);
  });

  it("ProposalService.recover fails missing exportRoughcut rows and accurately distinguishes applied vs failed", async () => {
    const ctx = await startApp();
    try {
      const prj = (await ctx.app.call(ctx.actor, { commandId: "project.create", idempotencyKey: "p1", input: { name: "Rec" } }, ctx.grant.handle)).value as { id: string };
      const now = new Date().toISOString();
      // Seed an 'applying' exportRoughcut proposal with a committed operation receipt pointing at a non-existent exportId.
      ctx.app.store.sqlite.prepare(
        `INSERT INTO operations(idempotency_key, command_id, result_json, committed_at) VALUES (?,?,?,?)`,
      ).run("prop_missing_exp", "roughcut.export", JSON.stringify({ status: "ok", value: { export: { id: "rce_missing", state: "running" } } }), now);
      ctx.app.store.sqlite.prepare(
        `INSERT INTO agent_proposals(id, session_id, run_id, project_id, kind, command_id, input_json, preview_json, target_json, reason, status, result_json, created_at, decided_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        "prop_missing_exp", "sess_1", "run_1", prj.id, "exportRoughcut", "roughcut.export",
        JSON.stringify({ cutId: "rc_1" }),
        JSON.stringify({ title: "Cut", changes: [], backlinks: [] }),
        JSON.stringify({ kind: "roughcut", id: "rc_1", title: "Cut", revision: "v1" }),
        null, "applying",
        JSON.stringify({ exportId: "rce_missing" }),
        now, now,
      );

      const proposals = (ctx.app as unknown as { proposals: ProposalService }).proposals;
      const recovered = proposals.recover();
      expect(recovered.failed).toBe(1);
      expect(recovered.applied).toBe(0);
      const row = ctx.app.store.sqlite.prepare("SELECT status FROM agent_proposals WHERE id = 'prop_missing_exp'").get() as { status: string };
      expect(row.status).toBe("failed");
    } finally {
      ctx.app.close();
    }
  });

  it("DraftService.cancel is synchronous, adopt enforces DRAFT_TEXT_LIMIT, abortForProject aborts running drafts, and ProjectService.delete fires beforeDeleteHook & clears project.pages.<id>", async () => {
    const dir = path.join(root, "draft-lifecycle");
    const store = new DrizzleStore({ profileDir: path.join(dir, "data"), hostId: "cr-drafts", attachmentsDir: path.join(dir, "att") });
    let abortedSignals = 0;
    const drafts = new DraftService(store, {
      llm: () => fakeLlm(async (_conn, { signal }) => new Promise((_resolve, reject) => {
        if (signal?.aborted) {
          abortedSignals += 1;
          reject(new Error("aborted"));
          return;
        }
        signal?.addEventListener("abort", () => {
          abortedSignals += 1;
          reject(new Error("aborted"));
        });
      })),
      notify: () => undefined,
    });
    const projects = new ProjectService(store);
    try {
      const prj = projects.create({ name: "DraftPrj" });
      const draft = drafts.create({ projectId: prj.id, title: "D1", text: "initial" });

      // cancel() transitions status to 'cancelled' synchronously in SQLite.
      const s1 = drafts.suggest({ draftId: draft.id, kind: "polish", instruction: "clean" });
      await Promise.resolve();
      drafts.cancel(s1.suggestion.id);
      expect((store.sqlite.prepare("SELECT status FROM draft_suggestions WHERE id = ?").get(s1.suggestion.id) as { status: string }).status).toBe("cancelled");

      // adopt() enforces DRAFT_TEXT_LIMIT (500_000 chars).
      const now = new Date().toISOString();
      store.sqlite.prepare(
        `INSERT INTO draft_suggestions(id, draft_id, kind, instruction, status, base_version, base_text, result_text, sources_json, model_json, adopted_version, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run("sug_huge", draft.id, "continue", "", "pending", 1, "initial", "x".repeat(500_001), "[]", null, null, now, now);
      expect(() => drafts.adopt("sug_huge")).toThrowError(/limit|long/i);

      // ProjectService.setBeforeDeleteHook + DraftService.abortForProject + project.pages.<id> cleanup.
      drafts.suggest({ draftId: draft.id, kind: "polish", instruction: "keep running" });
      await Promise.resolve();
      store.sqlite.prepare("INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, ?)").run(`project.pages.${prj.id}`, "[]");

      const hooked: string[] = [];
      projects.setBeforeDeleteHook((projectId) => {
        hooked.push(projectId);
        drafts.abortForProject(projectId);
      });
      projects.delete(prj.id);
      await drafts.settled();
      expect(hooked).toEqual([prj.id]);
      expect(abortedSignals).toBeGreaterThanOrEqual(2);
      expect(store.sqlite.prepare("SELECT value FROM schema_meta WHERE key = ?").get(`project.pages.${prj.id}`)).toBeUndefined();
    } finally {
      store.close();
    }
  });
});
