import { afterEach, describe, expect, it } from "vitest";
import { completeText, startMockProvider, streamText, type StreamEvent, type ToolDefinition } from "@manga/model-protocol";

// AT-142: the native runtime and pi-ai 1.x, run against the same fake service, send the same tool surface and give the same answers for text,
// tool calls, pictures, streams and an abort. The tool parameters are plain JSON Schema handed over unchanged ($ref, enum, optional fields).

const TOOL: ToolDefinition = {
  name: "library.find",
  description: "find in the library",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string" },
      kind: { type: "string", enum: ["novel", "comic", "video"] },
      range: { $ref: "#/$defs/range" },
    },
    required: ["text"],
    additionalProperties: false,
    $defs: { range: { type: "object", properties: { start: { type: "integer" }, end: { type: "integer" } }, required: ["start"] } },
  },
};
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); });

async function service(options: Parameters<typeof startMockProvider>[0] = {}) {
  const seen: Array<{ url: string; body: Record<string, any> }> = [];
  const server = await startMockProvider({ ...options, onRequest: (request) => seen.push(request) });
  closers.push(server.close);
  return { url: server.url, seen };
}

async function collect(stream: AsyncGenerator<StreamEvent>) {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

/** The tool schema as it reached the service, wherever the protocol keeps it. */
function sentSchema(body: Record<string, any>): unknown {
  const tool = body.tools?.[0];
  return tool?.function?.parameters ?? tool?.parameters;
}

describe.each(["openai-chat-completions", "openai-responses"] as const)("the two runtimes over %s (AT-142)", (protocol) => {
  it("send the same JSON Schema for a tool and report the same call", async () => {
    const answers: Record<string, { schema: unknown; call: { name: string; arguments: string } }> = {};
    for (const runtime of ["native", "pi"] as const) {
      const { url, seen } = await service({ streamToolArguments: '{"text":"hello","kind":"comic","range":{"start":2}}' });
      const events = await collect(streamText(protocol, url, "k", { model: "demo", messages: [{ role: "user", content: "find" }], tools: [TOOL], stream: true }, runtime));
      const deltas = events.filter((event): event is Extract<StreamEvent, { type: "tool-call-delta" }> => event.type === "tool-call-delta");
      expect(deltas.length).toBeGreaterThan(0);
      answers[runtime] = { schema: sentSchema(seen.at(-1)!.body), call: { name: deltas[0]!.name, arguments: deltas.map((delta) => delta.argumentsDelta).join("") } };
      expect(events.at(-1)?.type).toBe("completed");
    }
    // pi may add its own keywords next to the schema (strict mode is off); what MANGA wrote must arrive whole.
    expect(answers.pi!.schema).toMatchObject(TOOL.parameters);
    expect(answers.native!.schema).toMatchObject(TOOL.parameters);
    expect(answers.pi!.call.name).toBe(answers.native!.call.name);
    expect(JSON.parse(answers.pi!.call.arguments)).toEqual(JSON.parse(answers.native!.call.arguments));
  });

  it("answer text, stream it and accept a picture the same way", async () => {
    const results: Record<string, { text: string; streamed: string; imageSent: boolean }> = {};
    for (const runtime of ["native", "pi"] as const) {
      const { url, seen } = await service();
      const done = await completeText(protocol, url, "k", { model: "demo", messages: [{ role: "user", content: "hello", images: [{ mediaType: "image/png", base64: PNG }] }] }, runtime);
      const imageSent = JSON.stringify(seen.at(-1)!.body).includes(PNG);
      const events = await collect(streamText(protocol, url, "k", { model: "demo", messages: [{ role: "user", content: "hello" }], stream: true }, runtime));
      results[runtime] = { text: done.text, streamed: events.filter((event) => event.type === "text-delta").map((event) => (event as { text: string }).text).join(""), imageSent };
    }
    expect(results.pi).toEqual(results.native);
    expect(results.native!.imageSent).toBe(true);
    expect(results.native!.text.length).toBeGreaterThan(0);
  });

  it("stop giving events once the request is aborted, and report a cancel", async () => {
    for (const runtime of ["native", "pi"] as const) {
      const { url } = await service({ delayMs: 400 });
      const controller = new AbortController();
      const events: StreamEvent[] = [];
      setTimeout(() => controller.abort(), 50);
      let failure: unknown;
      try {
        for await (const event of streamText(protocol, url, "k", { model: "demo", messages: [{ role: "user", content: "slow" }], stream: true, signal: controller.signal }, runtime)) events.push(event);
      } catch (error) {
        failure = error;
      }
      const afterAbort = events.length;
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(events.length, runtime).toBe(afterAbort);
      expect(events.some((event) => event.type === "completed"), runtime).toBe(false);
      expect((failure as { code?: string } | undefined)?.code, runtime).toBe("CANCELLED");
    }
  });
});
