import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MODEL_PROFILE } from "@manga/contracts/models";
import { startMockProvider } from "@manga/model-protocol";
import { startApp, waitForRun } from "../helpers/app.ts";

/**
 * AT-95. A model has a profile: its window, the longest answer it gives, what it takes in and what it can do. The numbers are the person's, or a test's, or a default.
 * The profile reaches the service as parameters, under both runtimes.
 * AT-96. A test of the connection asks it a question and says what is wrong in the words of the fix: success with the delay and the first words, a wrong key, a wrong
 * address, a model that does not exist, a timeout, a rate limit and an answer in another protocol.
 */

type App = Awaited<ReturnType<typeof startApp>>;
type Call = Awaited<ReturnType<App["app"]["call"]>>;
type Mode = NonNullable<Parameters<typeof startMockProvider>[0]>["mode"];
let counter = 0;
const apps: App[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (apps.length) apps.pop()!.app.close();
  while (closers.length) await closers.pop()!();
});

async function boot() {
  const ctx = await startApp();
  apps.push(ctx);
  return ctx;
}

async function run(ctx: App, commandId: string, input: Record<string, unknown>): Promise<Call> {
  counter += 1;
  return ctx.app.call(ctx.actor, { commandId, idempotencyKey: `profile-${counter}`, input }, ctx.grant.handle);
}
function ok<T = Record<string, any>>(result: Call): T {
  expect(result.status, JSON.stringify(result)).toBe("ok");
  return result.value as T;
}

type Seen = { url: string; body: Record<string, any> };
async function provider(options: Parameters<typeof startMockProvider>[0] = {}) {
  const seen: Seen[] = [];
  const server = await startMockProvider({ ...options, onRequest: (request) => { seen.push(request as Seen); } });
  closers.push(server.close);
  return { url: server.url, seen };
}

const SECRET = "credential-profile-secret-value";
async function connect(ctx: App, url: string, extra: Record<string, unknown> = {}, withKey = true) {
  counter += 1;
  const created = ok<{ id: string }>(await run(ctx, "connections.upsert", {
    label: `model-${counter}`, protocol: "openai-chat-completions", baseUrl: url, modelId: "model-text", purpose: "text",
    ...(withKey ? { credentialHandle: ctx.app.stashSecret(`${SECRET}-${counter}`) } : {}),
    ...extra,
  }));
  return created.id;
}

const listed = async (ctx: App, id: string) => ok<Array<Record<string, any>>>(await run(ctx, "connections.list", {})).find((item) => item.id === id)!;

describe("the profile of a model", () => {
  it("starts from the default and keeps what the person sets, refusing numbers that do not hold together", async () => {
    const ctx = await boot();
    const { url } = await provider();
    const id = await connect(ctx, url);
    expect((await listed(ctx, id)).profile).toEqual(DEFAULT_MODEL_PROFILE);
    expect((await listed(ctx, id)).lastTest).toBeNull();

    const set = ok<{ profile: Record<string, any> }>(await run(ctx, "connections.setProfile", { connectionId: id, profile: { contextWindow: 32_000, maxOutput: 4_000, inputTypes: ["image"], capabilities: ["tools", "reasoning"], reasoningEffort: "low" } }));
    expect(set.profile).toMatchObject({ contextWindow: 32_000, maxOutput: 4_000, reasoningEffort: "low", source: { contextWindow: "user", maxOutput: "user" } });
    // Text is always an input.
    expect(set.profile.inputTypes).toEqual(["text", "image"]);
    expect((await listed(ctx, id)).profile.contextWindow).toBe(32_000);

    // An answer as long as the whole window leaves no room for anything: refused, with the reason, and nothing changes.
    const tooLong = await run(ctx, "connections.setProfile", { connectionId: id, profile: { maxOutput: 40_000 } });
    expect(tooLong.status).toBe("error");
    expect(tooLong.error?.message).toContain("最大输出");
    expect((await listed(ctx, id)).profile.maxOutput).toBe(4_000);
    // A number outside what any model has is refused before it is looked at.
    expect((await run(ctx, "connections.setProfile", { connectionId: id, profile: { contextWindow: 100 } })).status).toBe("error");
    expect((await run(ctx, "connections.setProfile", { connectionId: "conn_missing", profile: { maxOutput: 500 } })).status).toBe("error");
  });

  it("is kept when the connection is saved again, and what a test found about another model is forgotten when the model changes", async () => {
    const ctx = await boot();
    const { url } = await provider({ models: [{ id: "model-text", context_length: 32_768, max_output_tokens: 4_096 }] });
    const id = await connect(ctx, url, { profile: { maxOutput: 2_000 } });
    expect((await listed(ctx, id)).profile).toMatchObject({ maxOutput: 2_000, source: { maxOutput: "user" } });
    ok(await run(ctx, "connections.probe", { connectionId: id }));
    const probed = await listed(ctx, id);
    expect(probed.lastTest).toMatchObject({ ok: true });
    // The window was found; the answer length the person typed was not overwritten.
    expect(probed.profile).toMatchObject({ contextWindow: 32_768, maxOutput: 2_000, source: { contextWindow: "detected", maxOutput: "user" } });

    // The same model under a new label: nothing about it changed.
    ok(await run(ctx, "connections.upsert", { id, label: "renamed", protocol: "openai-chat-completions", baseUrl: url, modelId: "model-text", purpose: "text" }));
    const same = await listed(ctx, id);
    expect(same.label).toBe("renamed");
    expect(same.profile).toMatchObject({ contextWindow: 32_768, source: { contextWindow: "detected" } });
    expect(same.lastTest).toMatchObject({ ok: true });

    // Another model: the window that was found belonged to the old one, the length the person set stays, the old test no longer says anything.
    ok(await run(ctx, "connections.upsert", { id, label: "renamed", protocol: "openai-chat-completions", baseUrl: url, modelId: "other-model", purpose: "text" }));
    const other = await listed(ctx, id);
    expect(other.lastTest).toBeNull();
    expect(other.profile).toMatchObject({ contextWindow: DEFAULT_MODEL_PROFILE.contextWindow, maxOutput: 2_000, source: { contextWindow: "default", maxOutput: "user" } });
  });

  it("is saved with the connection in one command: numbers that do not hold together leave the stored key and the connection as they were (A-90)", async () => {
    const ctx = await boot();
    const { url } = await provider();
    const id = await connect(ctx, url, { profile: { contextWindow: 32_000, maxOutput: 4_000 } });
    const before = await listed(ctx, id);
    expect(before.credentialConfigured).toBe(true);

    const handle = ctx.app.stashSecret(`${SECRET}-replacement`);
    const refused = await run(ctx, "connections.upsert", { id, label: "changed", protocol: "openai-chat-completions", baseUrl: url, modelId: "model-text", purpose: "text", credentialHandle: handle, profile: { contextWindow: 8_000, maxOutput: 9_000 } });
    expect(refused.status).toBe("error");
    expect(refused.error?.message).toContain("最大输出");
    // Nothing changed: not the label, not the numbers, and the key is still there and still works.
    const after = await listed(ctx, id);
    expect(after.label).toBe(before.label);
    expect(after.profile).toEqual(before.profile);
    expect(after.credentialConfigured).toBe(true);
    expect(ok<{ ok: boolean }>(await run(ctx, "connections.probe", { connectionId: id })).ok).toBe(true);

    // The new key was not spent by the refusal: the same handle saves the corrected numbers together with the new key.
    ok(await run(ctx, "connections.upsert", { id, label: "changed", protocol: "openai-chat-completions", baseUrl: url, modelId: "model-text", purpose: "text", credentialHandle: handle, profile: { contextWindow: 8_000, maxOutput: 2_000 } }));
    const saved = await listed(ctx, id);
    expect(saved.label).toBe("changed");
    expect(saved.profile).toMatchObject({ contextWindow: 8_000, maxOutput: 2_000, source: { contextWindow: "user", maxOutput: "user" } });
  });
});

describe.each(["native", "pi"] as const)("the test of a connection under the %s runtime", (runtime) => {
  it("asks a question, looks at what the model can do and keeps the result", async () => {
    const ctx = await boot();
    const { url, seen } = await provider({ models: [{ id: "model-text", context_length: 65_536, max_completion_tokens: 8_192 }] });
    const id = await connect(ctx, url, { runtime });
    const result = ok<Record<string, any>>(await run(ctx, "connections.probe", { connectionId: id }));
    expect(result.ok).toBe(true);
    expect(typeof result.latencyMs).toBe("number");
    expect(result.reply).toContain("hello");
    expect(result.capabilities).toEqual(expect.arrayContaining(["streaming", "tools", "vision"]));
    expect(result.detected).toEqual({ contextWindow: 65_536, maxOutput: 8_192 });
    // What was found went into the profile: the picture was accepted, so the model takes images.
    expect(result.profile).toMatchObject({ contextWindow: 65_536, maxOutput: 8_192, source: { contextWindow: "detected", maxOutput: "detected" } });
    expect(result.profile.inputTypes).toContain("image");
    const item = await listed(ctx, id);
    expect(item.lastTest).toMatchObject({ ok: true, capabilities: expect.arrayContaining(["vision"]) });
    expect(item.verifiedCapabilities).toEqual(expect.arrayContaining(["text", "streaming", "tools", "vision"]));
    // The three requests that were made: the question, the tool and the picture.
    const bodies = seen.map((request) => JSON.stringify(request.body));
    expect(bodies.some((body) => body.includes("image_url"))).toBe(true);
    expect(bodies.some((body) => body.includes('"tools"'))).toBe(true);
  });

  it("shows the model a picture large enough for the vision models that refuse small ones", async () => {
    const ctx = await boot();
    // Like a service in front of Qwen's vision models: a picture with a side of 28 pixels or less is a bad request, not a picture the model cannot see.
    const sides: number[] = [];
    const { url } = await provider({
      respond: ({ body }) => {
        const data = /data:image\/png;base64,([A-Za-z0-9+/=]+)/.exec(JSON.stringify(body))?.[1];
        if (!data) return undefined;
        const png = Buffer.from(data, "base64");
        const side = Math.min(png.readUInt32BE(16), png.readUInt32BE(20));
        sides.push(side);
        return side <= 28 ? { status: 400, message: `height(${side}) or width(${side}) must be larger than 28` } : { text: "red" };
      },
    });
    const id = await connect(ctx, url, { runtime });
    const result = ok<Record<string, any>>(await run(ctx, "connections.probe", { connectionId: id }));
    expect(sides.length).toBeGreaterThan(0);
    expect(Math.min(...sides)).toBeGreaterThan(28);
    expect(result.capabilities).toContain("vision");
    expect(result.profile.inputTypes).toContain("image");
    // The test of one capability sends the same picture.
    expect(ok<Record<string, any>>(await run(ctx, "connections.test", { connectionId: id, capability: "vision" })).ok).toBe(true);
  });

  it("says what is wrong when it fails, in a category the person can act on, and keeps neither the key nor the service's words", async () => {
    const cases: Array<{ mode: Mode; category: string; status?: number; timeoutMs?: number }> = [
      { mode: "unauthorized", category: "auth", status: 401 },
      { mode: "forbidden", category: "auth", status: 403 },
      { mode: "rate-limited", category: "rate_limit", status: 429 },
      { mode: "model-missing", category: "model", status: 404 },
      { mode: "server-error", category: "other", status: 503 },
      { mode: "protocol-mismatch", category: "protocol" },
      { mode: "wrong-shape", category: "protocol" },
      { mode: "timeout", category: "timeout", timeoutMs: 700 },
    ];
    const ctx = await boot();
    for (const item of cases) {
      const { url } = await provider({ mode: item.mode });
      const id = await connect(ctx, url, { runtime, ...(item.timeoutMs ? { timeoutMs: item.timeoutMs } : {}) });
      const result = ok<Record<string, any>>(await run(ctx, "connections.probe", { connectionId: id }));
      expect(result.ok, `${item.mode}: ${JSON.stringify(result)}`).toBe(false);
      expect(result.failure.category, `${item.mode}: ${JSON.stringify(result.failure)}`).toBe(item.category);
      if (item.status) expect(result.failure.status, item.mode).toBe(item.status);
      const text = JSON.stringify((await listed(ctx, id)).lastTest);
      expect(text).toContain('"ok":false');
      expect(text).not.toContain(SECRET);
      for (const words of ["invalid api key", "overloaded", "Sign in to continue", "may not use this model", "does not exist or you do not have access"]) expect(text).not.toContain(words);
    }
  }, 60_000);

  it("tells an address with nothing behind it from a wrong key, and a missing key from both", async () => {
    const ctx = await boot();
    const dead = await provider();
    const id = await connect(ctx, dead.url, { runtime });
    await closers.pop()!();
    const refused = ok<Record<string, any>>(await run(ctx, "connections.probe", { connectionId: id }));
    expect(refused.failure.category).toBe("address");
    const keyless = await connect(ctx, dead.url, { runtime }, false);
    const none = ok<Record<string, any>>(await run(ctx, "connections.probe", { connectionId: keyless }));
    expect(none.failure.category).toBe("auth");
    expect((await run(ctx, "connections.probe", { connectionId: "conn_missing" })).status).toBe("error");
  });
});

describe("the profile as the service is asked", () => {
  async function asked(options: { protocol: "openai-chat-completions" | "openai-responses"; runtime: "native" | "pi"; profile?: Record<string, unknown> }) {
    const ctx = await boot();
    // A task runs under the runtime that is set when it is sent; the connection's own setting is for its test.
    ok(await run(ctx, "settings.setRuntime", { runtime: options.runtime }));
    const { url, seen } = await provider();
    const id = await connect(ctx, url, { protocol: options.protocol, runtime: options.runtime, ...(options.profile ? { profile: options.profile } : {}) });
    const session = ok<{ id: string }>(await run(ctx, "agent.createSession", { title: "t" }));
    const sent = ok<Record<string, any>>(await run(ctx, "agent.send", { sessionId: session.id, text: "你好" }));
    const finished = await waitForRun(ctx.app, ctx.actor, ctx.grant.handle, String(sent.runId));
    expect(finished.value?.status, JSON.stringify(finished.value)).toBe("succeeded");
    expect(id).toBeTruthy();
    return seen.filter((request) => /chat\/completions|responses/.test(request.url)).map((request) => request.body);
  }

  it("leaves the length of the answer to the service until the person or a test has set it", async () => {
    for (const runtime of ["native", "pi"] as const) {
      const bodies = await asked({ protocol: "openai-chat-completions", runtime });
      expect(bodies.length).toBeGreaterThan(0);
      for (const body of bodies) {
        expect(body.max_tokens, runtime).toBeUndefined();
        expect(body.max_completion_tokens, runtime).toBeUndefined();
      }
    }
  });

  it.each([
    ["openai-chat-completions", "native"],
    ["openai-chat-completions", "pi"],
    ["openai-responses", "native"],
    ["openai-responses", "pi"],
  ] as const)("sends the longest answer and, for a model that reasons, the effort (%s, %s)", async (protocol, runtime) => {
    const profile = { maxOutput: 1_000, capabilities: ["tools", "reasoning"], reasoningEffort: "high" };
    const [first] = await asked({ protocol, runtime, profile });
    expect(first, "a request was made").toBeDefined();
    const text = JSON.stringify(first);
    if (protocol === "openai-responses") {
      expect(first!.max_output_tokens).toBe(1_000);
      expect(first!.reasoning?.effort).toBe("high");
    } else {
      // A model that reasons counts its thinking in the same limit, under the name the services give it.
      expect(first!.max_completion_tokens ?? first!.max_tokens, text).toBe(1_000);
      expect(first!.reasoning_effort, text).toBe("high");
    }
    // A model that does not reason is not sent an effort.
    const [plain] = await asked({ protocol, runtime, profile: { maxOutput: 1_000, capabilities: ["tools"], reasoningEffort: null } });
    expect(JSON.stringify(plain)).not.toContain("reasoning");
    if (protocol === "openai-chat-completions") expect(plain!.max_tokens).toBe(1_000);
  });

  it("talks to a model that does not call tools without offering any", async () => {
    for (const runtime of ["native", "pi"] as const) {
      const bodies = await asked({ protocol: "openai-chat-completions", runtime, profile: { capabilities: [] } });
      for (const body of bodies) expect(body.tools, runtime).toBeUndefined();
      const withTools = await asked({ protocol: "openai-chat-completions", runtime });
      expect(withTools.some((body) => Array.isArray(body.tools) && body.tools.length > 0), runtime).toBe(true);
    }
  });
});
