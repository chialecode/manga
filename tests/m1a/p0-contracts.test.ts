import { describe, expect, it } from "vitest";
import { CommandEnvelopeSchema, ProfileConfigSchema, UntrustedCommandSchema, validateCommandInput } from "@manga/contracts";
import { createTranslator } from "@manga/i18n";

describe("P0 contracts and i18n", () => {
  it("accepts previous Zod 3 command envelopes after Zod 4 upgrade", () => {
    const untrusted = UntrustedCommandSchema.parse({
      commandId: "notes.create",
      idempotencyKey: "k1",
      input: { title: "hello", text: "world" },
      actor: { kind: "agent", id: "forged" },
      scopeHandle: "library",
    });
    expect("actor" in untrusted).toBe(false);
    expect("scopeHandle" in untrusted).toBe(false);
    const envelope = CommandEnvelopeSchema.parse({
      protocolVersion: 1,
      requestId: "req_1",
      commandId: "notes.create",
      commandVersion: 1,
      actor: { kind: "user", id: "u1" },
      scopeHandle: "grant_1",
      registryGeneration: 1,
      idempotencyKey: "k1",
      expectedRevisions: [],
      input: untrusted.input,
    });
    expect(envelope.actor.kind).toBe("user");
    expect(validateCommandInput("notes.create", { title: "hello", text: "world" })).toMatchObject({ title: "hello" });
  });

  it("parses profile config records with string keys", () => {
    const profile = ProfileConfigSchema.parse({
      profileId: "m1a",
      revision: 1,
      enabledFeatures: ["library"],
      disabledFeatures: [],
      preferredProviders: { "manga.library": ["manga.library"] },
    });
    expect(profile.preferredProviders["manga.library"]).toEqual(["manga.library"]);
  });

  it("interpolates Chinese messages and a test locale", () => {
    const zh = createTranslator("zh-CN");
    expect(zh.t("library.count", { count: 3 })).toBe("3 项");
    expect(zh.formatNumber(1250)).toMatch(/1/);
    const testLocale = createTranslator("qps-ploc");
    expect(testLocale.t("nav.agent")).toBe("[[Agent]]");
  });
});
