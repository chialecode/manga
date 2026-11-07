import { describe, expect, it } from "vitest";
import { startMockProvider } from "@manga/model-protocol";
import type { ScopeGrant } from "@manga/contracts";
import { withEmptyScopeNote } from "../../packages/app-core/src/agent-scope.ts";
import { startApp, waitForRun } from "../helpers/app.ts";

const grantOf = (patch: Partial<ScopeGrant>) => ({ access: "agent", readResourceIds: [], ...patch }) as unknown as ScopeGrant;
const found = { status: "ok", value: { items: [] } } as const;

describe("AT-129 a tool result explains an empty scope", () => {
  it("adds why and what to do only to a read with nothing it may read", () => {
    const noted = withEmptyScopeNote(grantOf({}), "library.find", found as never);
    expect((noted.value as any).scope.readable).toBe(0);
    expect((noted.value as any).result).toEqual({ items: [] });
    // A scope with resources answers as it always did, found or not; so do the owner and the tools that do not read resources.
    expect(withEmptyScopeNote(grantOf({ readResourceIds: ["r1"] }), "library.find", found as never)).toBe(found);
    expect(withEmptyScopeNote(grantOf({ access: "owner" } as never), "library.find", found as never)).toBe(found);
    expect(withEmptyScopeNote(grantOf({}), "notes.create", found as never)).toBe(found);
  });

  it("gives the model the note after its one find, so it can tell the person instead of asking again", async () => {
    const bodies: Array<Record<string, any>> = [];
    const server = await startMockProvider({ streamToolScript: [{ name: "library.find", arguments: '{"text":"第一章"}' }], onRequest: ({ body }) => { bodies.push(body); } });
    const { app, actor, grant } = await startApp();
    try {
      const secret = app.stashSecret("test-credential-value-for-vault");
      await app.call(actor, { commandId: "connections.upsert", idempotencyKey: "es-conn", input: { label: "mock", protocol: "openai-chat-completions", baseUrl: server.url, modelId: "demo", purpose: "text", credentialHandle: secret } }, grant.handle);
      const session = await app.call(actor, { commandId: "agent.createSession", idempotencyKey: "es-ses", input: { kind: "shared" } }, grant.handle);
      const sent = await app.call(actor, { commandId: "agent.send", idempotencyKey: "es-send", input: { sessionId: session.value?.id, text: "第一章讲了什么" } }, grant.handle);
      const done = await waitForRun(app, actor, grant.handle, String(sent.value?.runId));
      expect(done.value?.status, JSON.stringify(done.value?.error ?? {})).toBe("succeeded");
      const tools = done.value?.tools as Array<{ commandId: string }>;
      expect(tools.map((tool) => tool.commandId)).toEqual(["library.find"]);
      const toolMessages = (bodies.at(-1)!.messages as Array<{ role: string; content: unknown }>).filter((message) => message.role === "tool").map((message) => String(message.content));
      expect(toolMessages).toHaveLength(1);
      expect(toolMessages[0]).toContain("\"readable\":0");
      expect(toolMessages[0]).toContain("不要再次调用查找");
    } finally {
      await server.close();
      app.close();
    }
  });
});
