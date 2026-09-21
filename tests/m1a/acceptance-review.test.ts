import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { completeText, streamText, mapHttpError } from "@manga/model-protocol";
import { startApp, tempProfile } from "./helpers.ts";

describe("A acceptance review regressions", () => {
  it.each([false, true])("sends Responses function definitions and round-trip call items (stream=%s)", async (stream) => {
    let payload: any;
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      payload = JSON.parse(Buffer.concat(chunks).toString());
      if (stream) {
        res.setHeader("content-type", "text/event-stream");
        res.end('data: {"type":"response.completed","response":{"status":"completed"}}\n\n');
      } else {
        res.setHeader("content-type", "application/json");
        res.end('{"output_text":"ok"}');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    const request = {
      model: "synthetic",
      messages: [
        { role: "user" as const, content: "find" },
        { role: "assistant" as const, content: "", toolCalls: [{ id: "call_1", name: "library.find", arguments: '{"text":"x"}' }] },
        { role: "tool" as const, toolCallId: "call_1", content: '{"items":[]}' },
      ],
      tools: [{ name: "library.find", description: "find", parameters: { type: "object", properties: { text: { type: "string" } } } }],
    };
    try {
      const url = `http://127.0.0.1:${address.port}/v1`;
      if (stream) { for await (const _event of streamText("openai-responses", url, "synthetic", request)) { /* drain */ } }
      else await completeText("openai-responses", url, "synthetic", request);
      expect(payload.tools[0]).toEqual({ type: "function", ...request.tools[0] });
      expect(payload.input).toEqual([
        { role: "user", content: "find" },
        { type: "function_call", call_id: "call_1", name: "library.find", arguments: '{"text":"x"}' },
        { type: "function_call_output", call_id: "call_1", output: '{"items":[]}' },
      ]);
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  it("does not echo provider bodies into public errors", () => {
    for (const status of [400, 404, 500]) {
      expect(JSON.stringify(mapHttpError(status, "private user text and reflected authorization").toJSON())).not.toContain("private user");
    }
  });

  it("filters inventory before returning it to an empty Agent grant", async () => {
    const { app, actor, grant } = await startApp();
    try {
      await app.call(actor, { commandId: "library.importText", idempotencyKey: "resource", input: { title: "owner-only", bytes: [...Buffer.from("private synthetic content")] } }, grant.handle);
      await app.call(actor, { commandId: "notes.create", idempotencyKey: "note", input: { title: "owner-note", text: "private" } }, grant.handle);
      const agent = { kind: "agent" as const, id: "empty-inventory" };
      const empty = app.issueAgentGrant(grant, agent, { readResourceIds: [] });
      const result = await app.call(agent, { commandId: "inventory.overview", idempotencyKey: "overview", input: {} }, empty.handle);
      expect(result.status).toBe("ok");
      expect(result.value).toMatchObject({ items: [], totals: { resource: { count: 0 }, note: { count: 0 } } });
      expect(JSON.stringify(result)).not.toContain("owner-only");
      expect(JSON.stringify(result)).not.toContain(app.layout.defaultRoot.replaceAll("\\", "\\\\"));
    } finally { app.close(); }
  });

  it("never deletes pre-existing files when rolling back a merely proposed location", async () => {
    const { app, actor, grant } = await startApp();
    const target = tempProfile();
    const keep = path.join(target, "resources", "keep.txt");
    fs.mkdirSync(path.dirname(keep), { recursive: true });
    fs.writeFileSync(keep, "synthetic pre-existing file");
    try {
      const handle = app.registerPath("profile", target);
      await app.call(actor, { commandId: "settings.proposeLocations", idempotencyKey: "plan", input: { pathHandle: handle } }, grant.handle);
      const result = await app.call(actor, { commandId: "settings.recoverJobs", idempotencyKey: "rollback", input: { action: "rollback" } }, grant.handle);
      expect(result.status).toBe("ok");
      expect(fs.existsSync(keep)).toBe(true);
      expect(fs.readFileSync(keep, "utf8")).toBe("synthetic pre-existing file");
      expect((result.value as { needsReview: string[] }).needsReview).toHaveLength(1);
    } finally { app.close(); }
  });
});
