import { afterEach, describe, expect, it } from "vitest";
import { isLocalHostname, isPrivateAddress, normalizeHostname } from "../../packages/app-core/src/net/address.ts";
import { NetworkBroker } from "../../packages/app-core/src/net/broker.ts";
import { describeObject, OperationLog } from "../../packages/app-core/src/ops/operation-log.ts";
import { recordsList } from "../../packages/app-core/src/ops/records.ts";
import { REDACTED_PATH, REDACTED_SECRET, redactDeep, redactText, SECRET_KEY } from "../../packages/app-core/src/ops/redact.ts";
import { sessionStream } from "../../packages/app-core/src/ops/stream.ts";
import { usageQuery } from "../../packages/app-core/src/ops/usage.ts";
import { splitForSpeech } from "../../packages/app-core/src/providers/speech.ts";
import { recordServiceUse } from "../../packages/app-core/src/providers/usage.ts";
import { startApp } from "../helpers/app.ts";
import { call, deepseekApp } from "../helpers/provider-fixture.ts";

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

describe("net/address & NetworkBroker security (F-17, F-30)", () => {
  it("blocks trailing-dot local hostnames and expanded/mapped IPv6 private addresses", () => {
    expect(normalizeHostname("[::1].")).toBe("::1");
    expect(isLocalHostname("localhost.")).toBe(true);
    expect(isLocalHostname("printer.local.")).toBe(true);
    expect(isLocalHostname("svc.internal.")).toBe(true);
    expect(isLocalHostname("example.com.")).toBe(false);

    expect(isPrivateAddress("0:0:0:0:0:0:0:1")).toBe(true);
    expect(isPrivateAddress("0000:0000:0000:0000:0000:0000:0000:0000")).toBe(true);
    expect(isPrivateAddress("0:0:0:0:0:ffff:7f00:0001")).toBe(true);
    expect(isPrivateAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateAddress("::127.0.0.1")).toBe(true);
    expect(isPrivateAddress("64:ff9b::127.0.0.1")).toBe(true);
    expect(isPrivateAddress("fe80::1%eth0")).toBe(true);
    expect(isPrivateAddress("2002:7f00:0001::1")).toBe(true);
    expect(isPrivateAddress("2001:0db8::1")).toBe(true);
    expect(isPrivateAddress("2606:4700:4700::1111")).toBe(false);

    // TUN / CGNAT ranges are blocked by default and allowed when allowTunnelRanges is set.
    expect(isPrivateAddress("198.18.0.1")).toBe(true);
    expect(isPrivateAddress("100.64.0.1")).toBe(true);
    expect(isPrivateAddress("198.18.0.1", { allowTunnelRanges: true })).toBe(false);
    expect(isPrivateAddress("100.64.0.1", { allowTunnelRanges: true })).toBe(false);
    expect(isPrivateAddress("127.0.0.1", { allowTunnelRanges: true })).toBe(true);
  });

  it("rejects trailing-dot local URLs and throws CANCELLED when caller aborts mid-body", async () => {
    const broker = new NetworkBroker({ lookup: async () => ["93.184.216.34"] });
    await expect(broker.check("https://localhost./secret")).rejects.toMatchObject({ code: "PATH_ESCAPE" });
    await expect(broker.check("https://box.local./secret")).rejects.toMatchObject({ code: "PATH_ESCAPE" });

    const ac = new AbortController();
    const slowBroker = new NetworkBroker({
      lookup: async () => ["93.184.216.34"],
      fetch: async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("partial"));
          setTimeout(() => ac.abort(), 20);
        },
      }), { status: 200, headers: { "content-type": "text/plain" } }),
    });
    await expect(slowBroker.fetchText("https://example.com/slow", ac.signal)).rejects.toMatchObject({ code: "CANCELLED" });
  });
});

describe("providers: speech & web-search & usage (F-15, F-29)", () => {
  it("splits long speech text in linear time and handles limit=1 safely", () => {
    const huge = "这是一句非常长的话".repeat(10_000);
    const t0 = performance.now();
    const parts = splitForSpeech(huge, 10_000);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(parts.length).toBeGreaterThan(10);
    expect(parts.every((p) => p.length > 0)).toBe(true);

    const tiny = splitForSpeech("汉字a", 1);
    expect(tiny).toEqual(["汉", "字", "a"]);
  });

  it("maps mid-flight plugin disable on web.search to PROVIDER_UNAVAILABLE and estimates cost for partially billed error rows", async () => {
    const rig = await deepseekApp({ mock: { delayMs: 250 } });
    closers.push(rig.close);

    // Trigger web.search and immediately disable the provider plugin while in flight.
    const pending = call(rig.ctx, "web.search", { query: "慢查询" });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const disabled = await call(rig.ctx, "plugin.disable", { pluginId: "demo.provider" });
    expect(disabled.status).toBe("ok");
    const res = await pending;
    expect(res.status).toBe("error");
    expect(res.error?.code).toBe("PROVIDER_UNAVAILABLE");

    // Re-enable plugin to verify recordServiceUse computes cost_usd when quantity > 0 even if status === "error".
    await call(rig.ctx, "plugin.enable", { pluginId: "demo.provider" });
    const speechConn = rig.ctx.app.speech.connection()!;
    recordServiceUse(rig.ctx.app, {
      connectionId: speechConn.id,
      service: "speech",
      task: "read-aloud",
      unit: "char",
      quantity: 1000,
      status: "error",
      errorCode: "CANCELLED",
    });
    const row = rig.ctx.app.store.sqlite
      .prepare("SELECT cost_usd, quantity, status FROM service_usage WHERE service = 'speech' ORDER BY rowid DESC LIMIT 1")
      .get() as { cost_usd: number | null; quantity: number; status: string };
    expect(row.status).toBe("error");
    expect(row.quantity).toBe(1000);
    expect(row.cost_usd).toBeGreaterThan(0);
  });
});

describe("ops: redact, stream, operation-log, usage, records (F-08, F-09, F-19, F-24)", () => {
  it("preserves token count fields while redacting secret fields, file:// paths, query secrets, Basic auth, JWTs, and cycles (F-08)", () => {
    expect(SECRET_KEY.test("inputTokens")).toBe(false);
    expect(SECRET_KEY.test("outputTokens")).toBe(false);
    expect(SECRET_KEY.test("maxOutputTokens")).toBe(false);
    expect(SECRET_KEY.test("accessToken")).toBe(true);
    expect(SECRET_KEY.test("refresh_token")).toBe(true);
    expect(SECRET_KEY.test("token")).toBe(true);

    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123def456ghi789";
    const fileUri = ["file://", "/Users", "/alice/book.cbz"].join("");
    const socksUrl = ["socks5://", "me:pw", "@proxy.local/?api_key=xyz123&x=1"].join("");
    const text = redactText(`open ${fileUri} via ${socksUrl} Basic dXNlcjpwYXNzMTIzNDU2 ${jwt}`);
    expect(text.text).not.toContain("alice");
    expect(text.text).not.toContain("me:pw");
    expect(text.text).not.toContain("xyz123");
    expect(text.text).not.toContain("dXNlcjpwYXNzMTIzNDU2");
    expect(text.text).not.toContain("eyJhbGci");
    expect(text.text).toContain(REDACTED_PATH);
    expect(text.text).toContain(REDACTED_SECRET);

    const circular: Record<string, unknown> = { inputTokens: 120, outputTokens: 45, accessToken: "topsecret" };
    circular.self = circular;
    const cleaned = redactDeep(circular, { maxDepth: 10, overflowMarker: "[cycle]" });
    expect(cleaned.value).toEqual({
      inputTokens: 120,
      outputTokens: 45,
      accessToken: REDACTED_SECRET,
      self: "[cycle]",
    });

    // Regression: redactText must remain strictly linear (no ReDoS backtracking) on 300 KiB adversarial blobs.
    const httpScheme = ["http", "://"].join("");
    const credUrl = [httpScheme, "u:p", "@h"].join("");
    const adversarial = [
      "a1b2c3d4e5f6".repeat(25_000),
      `${"a-".repeat(150_000)} ${credUrl}`,
      `${httpScheme}${"a:".repeat(150_000)}@`,
      "?key=".repeat(60_000),
      `eyJ${"a".repeat(300_000)}`,
      "\\".repeat(300_000),
    ];
    const t0 = performance.now();
    for (const blob of adversarial) redactText(blob);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(redactText(`${"a-".repeat(1000)} ${credUrl}`).text).toContain(`${httpScheme}${REDACTED_SECRET}@h`);
  });

  it("never splits an equal-timestamp (user, agent) pair at the stream boundary and clamps limit (F-09)", async () => {
    const ctx = await startApp();
    closers.push(() => ctx.app.close());
    const db = ctx.app.store.sqlite;
    const session = (await ctx.app.call(ctx.actor, { commandId: "agent.createSession", idempotencyKey: "s1", input: { title: "t" } }, ctx.grant.handle)).value as { id: string };
    const insert = db.prepare("INSERT INTO agent_runs(id, session_id, status, grant_handle, budget_json, input_text, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)");
    insert.run("r1", session.id, "succeeded", "h", "{}", "q1", "2026-01-01T00:00:01.000Z", "2026-01-01T00:00:01.000Z");
    insert.run("r2", session.id, "succeeded", "h", "{}", "q2", "2026-01-01T00:00:02.000Z", "2026-01-01T00:00:02.000Z");

    // Odd limit=3 across 2 runs (4 items) must not start on r1:agent (which would drop r1:user on next page).
    const page1 = sessionStream(ctx.app.store, null, { sessionId: session.id, limit: 3 });
    expect(page1.items.map((i) => i.id)).toEqual(["r2:user", "r2:agent"]);
    expect(page1.hasMore).toBe(true);

    const page2 = sessionStream(ctx.app.store, null, { sessionId: session.id, limit: 3, before: page1.items[0]!.at });
    expect(page2.items.map((i) => i.id)).toEqual(["r1:user", "r1:agent"]);
    expect(page2.hasMore).toBe(false);

    // limit: 0 is clamped to >= 1.
    expect(sessionStream(ctx.app.store, null, { sessionId: session.id, limit: 0 }).items.length).toBeGreaterThanOrEqual(1);
  });

  it("classifies capture sessions/drafts in describeObject, clamps log limit, avoids usage double-count, and searches removed_works in recordsList (F-19, F-24)", async () => {
    const ctx = await startApp();
    closers.push(() => ctx.app.close());
    const db = ctx.app.store.sqlite;
    const now = "2026-10-10T10:00:00.000Z";
    db.prepare("INSERT INTO capture_sessions(id, clock_json, status, created_at, stage, duration_ms) VALUES ('cap-desc', '{}', 'stopped', ?, 'done', 60000)").run(now);
    db.prepare("INSERT INTO capture_drafts(id, session_id, state, text, created_at, updated_at) VALUES ('cd-1', 'cap-desc', 'ready', 'x', ?, ?)").run(now, now);

    // Even without 4th action arg, capture_sessions & capture_drafts are classified as "recording".
    expect(describeObject(ctx.app.store, { sessionId: "cap-desc" }, null)).toEqual({ kind: "recording", id: "cap-desc", label: null });
    expect(describeObject(ctx.app.store, { draftId: "cd-1" }, null)).toEqual({ kind: "recording", id: "cd-1", label: null });
    expect(describeObject(ctx.app.store, { sessionId: "cap-unknown" }, null, "capture.stop")).toEqual({ kind: "recording", id: "cap-unknown", label: null });

    // OperationLog.query clamps limit: 0 to 1 without crashing on nextBefore.
    const log = new OperationLog(ctx.app.store);
    log.record({ actorKind: "user", category: "notes", action: "notes.create", outcome: "ok" });
    log.record({ actorKind: "user", category: "notes", action: "notes.delete", outcome: "ok" });
    const q0 = log.query({ limit: 0 });
    expect(q0.entries).toHaveLength(1);
    expect(q0.nextBefore).toBe(q0.entries[0]!.id);

    // usageQuery does not double-count recording audioMs in byDay and unions service_usage.model_id into models.
    db.prepare("INSERT INTO service_usage(id, connection_id, model_id, service, task, unit, quantity, cost_usd, status, created_at) VALUES ('u1', NULL, 'asr-model-x', 'transcription', 'transcription', 'second', 60, 0.01, 'ok', ?)").run(now);
    const u = usageQuery(ctx.app.store, { limit: 0, offset: -5 });
    expect(u.rows.length).toBeGreaterThanOrEqual(1);
    expect(u.models).toContain("asr-model-x");
    const day = u.byDay.find((d) => d.key === "2026-10-10")!;
    expect(day.audioMs).toBe(60_000);

    // recordsList matches removed_works.title when filtering by q.
    db.prepare("INSERT INTO removed_works(id, title, media_kind, removed_at) VALUES ('rw-1', '已删作品秘境', 'novel', ?)").run(now);
    db.prepare("INSERT INTO content_objects(id, type, owner_module_id, work_id, scope_json, schema_version, revision, title, payload_json, tags_json, attachment_ids_json, preview_json, created_at, updated_at) VALUES ('n-rw', 'notes.document', 'manga.notes', 'rw-1', '{}', 1, 1, '普通标题', '{}', '[]', '[]', '{\"text\":\"普通正文\"}', ?, ?)").run(now, now);
    const found = recordsList(ctx.app.store, { q: "已删作品秘境", limit: 0, offset: -1 });
    expect(found.total).toBe(1);
    expect(found.items[0]!.id).toBe("n-rw");
  });
});
