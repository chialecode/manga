import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MangaRuntime, ResourceScope, SequencedBus } from "../../packages/kernel/src/index.ts";
import type { MangaModule } from "../../packages/plugin-sdk/src/index.ts";
import { DrizzleStore, acquireHostLock, matchQuery, releaseHostLock } from "@manga/storage-drizzle";

const tmpDirs: string[] = [];
function makeTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe("kernel: planner, runtime, scope, bus", () => {
  it("does not bounce unaffected sibling modules when toggling an unrelated module (F-01)", async () => {
    let agentStarts = 0;
    let agentStops = 0;

    const coreMod: MangaModule = {
      manifest: {
        moduleId: "manga.core",
        version: "1.0.0",
        displayName: "Core",
        featureId: "core",
        contributes: [{ capabilityId: "core.api", version: "1.0.0" }],
        needs: [],
      },
      activate: () => {},
      deactivate: () => {},
    };
    const agentMod: MangaModule = {
      manifest: {
        moduleId: "manga.agent",
        version: "1.0.0",
        displayName: "Agent",
        featureId: "agent",
        contributes: [{ capabilityId: "agent.api", version: "1.0.0" }],
        needs: [{ capabilityId: "core.api", version: "^1.0.0" }],
      },
      activate: (ctx) => {
        agentStarts += 1;
        ctx.register({ id: "agent-res", kind: "subscription", dispose: () => { agentStops += 1; } });
      },
      deactivate: () => {},
    };
    const voiceMod: MangaModule = {
      manifest: {
        moduleId: "manga.voice",
        version: "1.0.0",
        displayName: "Voice",
        featureId: "voice",
        contributes: [{ capabilityId: "voice.api", version: "1.0.0" }],
        needs: [{ capabilityId: "core.api", version: "^1.0.0" }],
      },
      activate: () => {},
      deactivate: () => {},
    };

    const runtime = new MangaRuntime([coreMod, agentMod, voiceMod]);
    await runtime.applyProfile({ profileId: "p", revision: 1, enabledFeatures: ["core", "agent", "voice"], disabledFeatures: [], preferredProviders: {} });
    expect(agentStarts).toBe(1);
    expect(agentStops).toBe(0);

    // Turning off voice must NOT stop or restart agent.
    await runtime.applyProfile({ profileId: "p", revision: 2, enabledFeatures: ["core", "agent"], disabledFeatures: ["voice"], preferredProviders: {} });
    expect(agentStarts).toBe(1);
    expect(agentStops).toBe(0);

    // Re-enabling voice must also leave agent untouched.
    await runtime.applyProfile({ profileId: "p", revision: 3, enabledFeatures: ["core", "agent", "voice"], disabledFeatures: [], preferredProviders: {} });
    expect(agentStarts).toBe(1);
    expect(agentStops).toBe(0);
  });

  it("deduplicates concurrent ResourceScope disposal so dispose runs once (F-18)", async () => {
    const scope = new ResourceScope();
    let disposed = 0;
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    const disposer = scope.register({
      id: "timer-1",
      kind: "timer",
      dispose: async () => {
        disposed += 1;
        await gate;
      },
    });

    const p1 = disposer();
    const p2 = scope.stop();
    const p3 = disposer();
    releaseGate();
    await Promise.all([p1, p2, p3]);
    expect(disposed).toBe(1);
    expect(scope.size).toBe(0);
    expect(scope.activeCounts).toEqual({ timer: 0 });
  });

  it("caps SequencedBus event history while preserving monotonic sequence numbers (F-33)", () => {
    const bus = new SequencedBus(5);
    const now = new Date().toISOString();
    for (let i = 1; i <= 12; i += 1) {
      bus.publish("test", { i }, `evt-${i}`, now);
    }
    const all = bus.snapshotFrom(0);
    expect(all).toHaveLength(5);
    expect(all.map((e) => e.seq)).toEqual([8, 9, 10, 11, 12]);
  });
});

describe("storage-drizzle: lock, ngrams, rebuildSearchIndex, commit isolation", () => {
  it("recovers from stale .WRITE_LOCK.guard and corrupt WRITE_LOCK.json (F-05)", () => {
    const dir = makeTmp("manga-lock-");
    const guardPath = path.join(dir, ".WRITE_LOCK.guard");
    const lockPath = path.join(dir, "WRITE_LOCK.json");

    fs.mkdirSync(guardPath);
    const old = new Date(Date.now() - 20_000);
    fs.utimesSync(guardPath, old, old);
    fs.writeFileSync(lockPath, "{corrupt json", "utf8");

    const acquired = acquireHostLock(dir, "host-1");
    expect(acquired).toMatchObject({ hostId: "host-1", pid: process.pid });
    expect(fs.existsSync(guardPath)).toBe(false);
    expect(JSON.parse(fs.readFileSync(lockPath, "utf8"))).toMatchObject({ pid: process.pid, hostId: "host-1" });
    releaseHostLock(dir, "host-1");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("matches CJK queries containing punctuation/spaces and multi-word English queries (F-06)", () => {
    const store = new DrizzleStore({ profileDir: makeTmp("manga-fts-") });
    try {
      const mutations = [
        ...store.indexFragment({ id: "frag-1", resourceId: "res-1", objectId: "obj-1", kind: "body", text: "进击的巨人 - 第1话：致二千年后的你" }),
        ...store.indexFragment({ id: "frag-2", resourceId: "res-2", objectId: "obj-2", kind: "body", text: "魔法少女：「圆环」火影  忍者" }),
        ...store.indexFragment({ id: "frag-3", resourceId: "res-3", objectId: "obj-3", kind: "body", text: "Attack on Titan Episode 1" }),
      ];
      store.commit({
        actor: { kind: "user", id: "u1" },
        commandId: "test.index",
        idempotencyKey: "fts-1",
        mutations,
        events: [],
        result: { ok: true },
      });

      const search = (q: string) =>
        store.sqlite.prepare("SELECT fragment_id FROM search_idx WHERE search_idx MATCH ?").all(matchQuery(q)) as Array<{ fragment_id: string }>;

      expect(search("进击的巨人 - 第1话").map((r) => r.fragment_id)).toContain("frag-1");
      expect(search("魔法少女：「圆环」").map((r) => r.fragment_id)).toContain("frag-2");
      expect(search("火影  忍者").map((r) => r.fragment_id)).toContain("frag-2");
      expect(search("Attack Titan").map((r) => r.fragment_id)).toContain("frag-3");
      expect(matchQuery("   ---   ")).toBe("");
    } finally {
      store.close();
    }
  });

  it("preserves resource_id for anchorless resource notes in rebuildSearchIndex and cleans old FTS rows on re-index (F-11)", () => {
    const store = new DrizzleStore({ profileDir: makeTmp("manga-rebuild-") });
    try {
      const now = new Date().toISOString();
      store.sqlite.prepare(
        "INSERT INTO content_objects(id, type, owner_module_id, scope_json, schema_version, revision, title, payload_json, tags_json, attachment_ids_json, preview_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        "obj-note-1", "notes.document", "manga.notes", JSON.stringify({ resourceId: "res-scope-1" }), 1, 1,
        "无锚点笔记", JSON.stringify({ blocks: [{ id: "b1", type: "paragraph", text: "独特短语星辰大海" }] }),
        "[]", "[]", JSON.stringify({ text: "独特短语星辰大海" }), now, now,
      );

      store.rebuildSearchIndex();
      const row = store.sqlite.prepare("SELECT resource_id, object_id FROM text_fragments WHERE object_id = 'obj-note-1'").get() as { resource_id: string | null; object_id: string };
      expect(row).toEqual({ resource_id: "res-scope-1", object_id: "obj-note-1" });

      // Re-indexing a fragment removes stale text from FTS5.
      store.commit({
        actor: { kind: "user", id: "u1" },
        commandId: "test.index1",
        idempotencyKey: "re-1",
        mutations: store.indexFragment({ id: "frag-re", resourceId: "res-scope-1", kind: "body", text: "旧关键词琥珀" }),
        events: [],
        result: { ok: true },
      });
      store.commit({
        actor: { kind: "user", id: "u1" },
        commandId: "test.index2",
        idempotencyKey: "re-2",
        mutations: store.indexFragment({ id: "frag-re", resourceId: "res-scope-1", kind: "body", text: "新关键词琉璃" }),
        events: [],
        result: { ok: true },
      });
      const oldHits = store.sqlite.prepare("SELECT fragment_id FROM search_idx WHERE search_idx MATCH ?").all(matchQuery("琥珀"));
      const newHits = store.sqlite.prepare("SELECT fragment_id FROM search_idx WHERE search_idx MATCH ?").all(matchQuery("琉璃"));
      expect(oldHits).toHaveLength(0);
      expect(newHits).toHaveLength(1);

      // Fresh chunk inserts must not emit O(N) FTS5 DELETE scans on unindexed fragment_id (#109).
      const chunkMutations = store.indexTextChunks({
        resourceId: "res-scope-1",
        resourceRevisionId: "rev-1",
        partId: "body",
        representationId: "rev-1",
        kind: "body",
        text: "甲".repeat(8500),
      });
      expect(chunkMutations.filter((m) => m.sql.startsWith("DELETE FROM search_idx"))).toHaveLength(0);
      expect(chunkMutations).toHaveLength(6); // 3 chunks * (INSERT text_fragments + INSERT search_idx)
    } finally {
      store.close();
    }
  });

  it("isolates post-commit listener errors without rolling back committed SQLite writes (F-26)", () => {
    const store = new DrizzleStore({ profileDir: makeTmp("manga-commit-") });
    try {
      const seen: string[] = [];
      store.onEvent(() => { throw new Error("listener boom"); });
      store.onEvent((event) => { seen.push(event.type); });

      store.commit({
        actor: { kind: "user", id: "u1" },
        commandId: "test.cmd",
        idempotencyKey: "idem-commit-1",
        mutations: [{ sql: "INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, ?)", params: ["commit-test", "saved"] }],
        events: [{ type: "test.committed", payload: { ok: true } }],
        result: { ok: true },
      });

      expect(store.getMeta("commit-test")).toBe("saved");
      expect(seen).toEqual(["test.committed"]);
    } finally {
      store.close();
    }
  });
});
