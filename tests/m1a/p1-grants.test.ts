import { describe, expect, it } from "vitest";
import { startApp } from "./helpers.ts";

describe("P1 grants and lifecycle", () => {
  it("rejects cross-resource reads when the allowlist is empty or enumerated", async () => {
    const { app, actor, grant } = await startApp();
    const imported = await app.call(actor, {
      commandId: "library.importText",
      idempotencyKey: "imp-1",
      input: { title: "alpha", bytes: [...Buffer.from("秘密正文")] },
    }, grant.handle);
    expect(imported.status).toBe("ok");
    const outsider = app.issueAgentGrant(grant, { kind: "agent", id: "agent-1" }, { readResourceIds: [] });
    const denied = await app.call({ kind: "agent", id: "agent-1" }, {
      commandId: "library.getResource",
      idempotencyKey: "get-denied",
      input: { resourceId: imported.value?.resourceId },
    }, outsider.handle);
    expect(denied.status).toBe("error");
    expect(denied.error?.code).toBe("SCOPE_DENIED");
    const search = await app.call({ kind: "agent", id: "agent-1" }, {
      commandId: "library.find",
      idempotencyKey: "find-empty",
      input: { text: "秘密" },
    }, outsider.handle);
    expect(search.status).toBe("ok");
    expect(search.value).toEqual([]);
    app.close();
  });

  it("blocks revoked grants on idempotent replay and late module epochs", async () => {
    const { app, actor, grant } = await startApp();
    const created = await app.call(actor, {
      commandId: "notes.create",
      idempotencyKey: "note-1",
      input: { title: "one", text: "body" },
    }, grant.handle);
    expect(created.status).toBe("ok");
    app.grants.revoke(grant.handle);
    const replay = await app.call(actor, {
      commandId: "notes.create",
      idempotencyKey: "note-1",
      input: { title: "one", text: "body" },
    }, grant.handle);
    expect(replay.status).toBe("error");
    expect(replay.error?.code).toBe("GRANT_REVOKED");
    app.close();
  });

  it("registers and revokes the React UI facet on the real start/stop chain", async () => {
    const { app } = await startApp();
    expect(app.uiFacets.has("agent")).toBe(true);
    expect(app.uiFacets.has("library")).toBe(true);
    await app.runtime.applyProfile({
      profileId: "m1a",
      revision: 2,
      enabledFeatures: ["library", "notes", "settings", "inventory"],
      disabledFeatures: ["agent"],
      preferredProviders: {},
    });
    expect(app.uiFacets.has("agent")).toBe(false);
    expect(app.runtime.gateway.has("agent.send")).toBe(false);
    await app.runtime.applyProfile({
      profileId: "m1a",
      revision: 3,
      enabledFeatures: ["library", "notes", "settings", "inventory", "agent"],
      disabledFeatures: [],
      preferredProviders: {},
    });
    expect(app.uiFacets.has("agent")).toBe(true);
    app.close();
  });

  it("survives 50 start/stop cycles without leaking UI facets", async () => {
    const { app } = await startApp();
    for (let i = 0; i < 50; i += 1) {
      await app.runtime.applyProfile({
        profileId: "m1a",
        revision: i + 2,
        enabledFeatures: i % 2 === 0 ? ["library", "notes", "settings", "inventory"] : ["library", "notes", "settings", "inventory", "agent"],
        disabledFeatures: i % 2 === 0 ? ["agent"] : [],
        preferredProviders: {},
      });
    }
    expect(app.uiFacets.has("library")).toBe(true);
    expect(app.runtime.resourceTotals().subscription ?? 0).toBeGreaterThan(0);
    app.close();
  });

  it("lets UI and Agent create the same note command through one service", async () => {
    const { app, actor, grant } = await startApp();
    const ui = await app.call(actor, { commandId: "notes.create", idempotencyKey: "ui-note", input: { title: "from-ui", text: "ui" } }, grant.handle);
    const agentGrant = app.issueAgentGrant(grant, { kind: "agent", id: "agent-ui" }, { readResourceIds: [] });
    const agent = await app.call({ kind: "agent", id: "agent-ui" }, { commandId: "notes.create", idempotencyKey: "agent-note", input: { title: "from-agent", text: "agent" } }, agentGrant.handle);
    expect(ui.status).toBe("ok");
    expect(agent.status).toBe("ok");
    expect(ui.value?.objectId).not.toBe(agent.value?.objectId);
    const created = await app.call(actor, { commandId: "notes.create", idempotencyKey: "late-note", input: { title: "late", text: "v1" } }, grant.handle);
    await app.runtime.applyProfile({
      profileId: "m1a",
      revision: 9,
      enabledFeatures: ["library", "settings", "inventory", "agent"],
      disabledFeatures: ["notes"],
      preferredProviders: {},
    });
    const late = await app.call(actor, {
      commandId: "notes.update",
      idempotencyKey: "late-write",
      input: { objectId: created.value?.objectId, expectedRevision: 1, text: "v2" },
    }, grant.handle);
    expect(late.status).toBe("error");
    expect(late.error?.code).toBe("CAPABILITY_UNAVAILABLE");
    app.close();
  });

  it("does not grant the agent the whole library when send omits a read list", async () => {
    const { app, actor, grant } = await startApp();
    const imported = await app.call(actor, {
      commandId: "library.importText",
      idempotencyKey: "all-imp",
      input: { title: "secret", bytes: [...Buffer.from("secret body")] },
    }, grant.handle);
    const session = await app.call(actor, { commandId: "agent.createSession", idempotencyKey: "all-ses", input: {} }, grant.handle);
    const sent = await app.call(actor, {
      commandId: "agent.send",
      idempotencyKey: "all-send",
      input: { sessionId: session.value?.id, text: "read everything" },
    }, grant.handle);
    expect(sent.status).toBe("ok");
    const agentGrant = app.grants.get(String(sent.value?.grantHandle));
    expect(agentGrant?.readResourceIds).toEqual([]);
    const peek = await app.call({ kind: "agent", id: `agent:${String(sent.value?.runId)}` }, {
      commandId: "library.getResource",
      idempotencyKey: "all-get",
      input: { resourceId: imported.value?.resourceId },
    }, String(sent.value?.grantHandle));
    expect(peek.status).toBe("error");
    expect(peek.error?.code).toBe("SCOPE_DENIED");
    app.close();
  });

  it("stops the parse worker on deactivate and starts a new one after re-enable", async () => {
    const { app } = await startApp({ useParseWorker: true });
    const live = app as unknown as { parseWorker?: { pid(): number | undefined } };
    expect(live.parseWorker?.pid()).toBeGreaterThan(0);
    await app.runtime.applyProfile({
      profileId: "m1a",
      revision: 2,
      enabledFeatures: ["settings"],
      disabledFeatures: ["library", "notes", "inventory", "agent"],
      preferredProviders: {},
    });
    expect(live.parseWorker).toBeUndefined();
    await app.runtime.applyProfile({
      profileId: "m1a",
      revision: 3,
      enabledFeatures: ["library", "notes", "settings", "inventory", "agent"],
      disabledFeatures: [],
      preferredProviders: {},
    });
    expect(live.parseWorker?.pid()).toBeGreaterThan(0);
    app.close();
  });
});
