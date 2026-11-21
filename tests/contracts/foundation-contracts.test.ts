import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  PLUGIN_FORMAT,
  PLUGIN_REFUSALS,
  PluginManifestSchema,
  ProviderFileSchema,
  DEFAULT_RECORDING_SETTINGS as ROOT_RECORDING_DEFAULTS,
  parseBangumiRef as rootParseBangumiRef,
} from "@manga/contracts";
import {
  BANGUMI_PAGE_HOSTS,
  REF_FAILURE_REASONS,
  classifySearchInput,
  parseBangumiRef,
} from "@manga/contracts/bangumi-ref";
import {
  KeyActionIdSchema,
  KeyOverridesSchema,
  conflictsWith,
  findConflicts,
  resolveKeys,
} from "@manga/contracts/keys";
import { DEFAULT_MODEL_PROFILE, ModelProfileSchema, forgetDetected } from "@manga/contracts/models";
import {
  DEFAULT_RECORDING_SETTINGS,
  type RecordingOverlay,
  type RecordingSettings,
  type RecordingSettingsPatch,
} from "@manga/contracts/recording";
import { catalogs } from "@manga/i18n";
import { LOGGED_COMMANDS } from "../../packages/app-core/src/ops/operation-log.ts";
import {
  errorMessage,
  escapeLike,
  findWorkspaceRoot,
  sha256File,
  sha512File,
  writeFileAtomic,
} from "../../packages/app-core/src/shared/utils.ts";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe("contracts: keys, recording, bangumi-ref, models, plugins & providers", () => {
  it("allows numbered global action ids in KeyOverridesSchema and checks dictationHoldKey conflicts (F-10)", () => {
    expect(KeyActionIdSchema.safeParse("global.column1").success).toBe(true);
    expect(KeyActionIdSchema.safeParse("global.dictationHold").success).toBe(true);
    expect(KeyActionIdSchema.safeParse("bad-id").success).toBe(false);
    expect(KeyOverridesSchema.safeParse({ "global.column1": ["Ctrl+1"] }).success).toBe(true);

    const base = resolveKeys(null);
    // Default recording keys + default dictationHoldKey (AltRight -> RightAlt) have no false conflict with global.dictationHold.
    expect(findConflicts(base, { holdKey: "F9", toggleKey: "F8", dictationHoldKey: "AltRight" })).toEqual([]);
    // Identical holdKey and toggleKey collide.
    expect(findConflicts(base, { holdKey: "F9", toggleKey: "F9" })).toEqual(
      expect.arrayContaining([expect.objectContaining({ chord: "F9" })]),
    );
    // dictationHoldKey colliding with a non-dictation action (e.g., `KeyW` -> `W` for `global.windowFullscreen`) is reported.
    expect(findConflicts(base, { holdKey: "F9", toggleKey: "F8", dictationHoldKey: "KeyW" })).toEqual(
      expect.arrayContaining([expect.objectContaining({ chord: "W" })]),
    );
    expect(conflictsWith(base, "video.fullscreen", "RightAlt", { holdKey: "F9", toggleKey: "F8", dictationHoldKey: "AltRight" }))
      .toContain("recording.dictationHoldKey");
  });

  it("exports hoisted RecordingSettings defaults & types from root and subpath (V-20, V-23)", () => {
    const settings: RecordingSettings = DEFAULT_RECORDING_SETTINGS;
    const overlay: RecordingOverlay = settings.overlay;
    const patch: RecordingSettingsPatch = { dictationHoldKey: "RightAlt", overlay: { x: 10, y: null } };
    expect(ROOT_RECORDING_DEFAULTS).toBe(DEFAULT_RECORDING_SETTINGS);
    expect(settings.holdKey).toBe("F9");
    expect(settings.dictationHoldKey).toBe("RightAlt");
    expect(overlay).toEqual({});
    expect(patch.dictationHoldKey).toBe("RightAlt");
  });

  it("parses Bangumi references & classifies search inputs with structured codes only (UP-18)", () => {
    expect(rootParseBangumiRef).toBe(parseBangumiRef);
    expect(BANGUMI_PAGE_HOSTS).toContain("bgm.tv");
    expect(REF_FAILURE_REASONS).toContain("foreign-host");
    expect(parseBangumiRef("https://bgm.tv/subject/464376")).toEqual({ ok: true, externalId: "464376", form: "url" });
    expect(parseBangumiRef("subject/12345")).toEqual({ ok: true, externalId: "12345", form: "path" });
    expect(parseBangumiRef("https://example.com/subject/1")).toEqual({ ok: false, reason: "foreign-host" });
    expect(parseBangumiRef("https://bgm.tv/character/1")).toEqual({ ok: false, reason: "character-page" });
    expect(parseBangumiRef(["http://", "user:pass", "@bgm.tv/subject/1"].join(""))).toEqual({ ok: false, reason: "foreign-host" });
    expect(classifySearchInput("464376")).toEqual({ type: "number", externalId: "464376", query: "464376" });
    expect(classifySearchInput("https://chii.in/subject/42")).toEqual({ type: "entry", externalId: "42" });
    expect(classifySearchInput("葬送的芙莉莲")).toEqual({ type: "name", query: "葬送的芙莉莲" });
    expect(classifySearchInput("   ")).toEqual({ type: "empty" });
  });

  it("clamps maxOutput below contextWindow in forgetDetected (F-21)", () => {
    const clamped = forgetDetected({
      ...DEFAULT_MODEL_PROFILE,
      contextWindow: 128_000,
      maxOutput: 16_384,
      source: { ...DEFAULT_MODEL_PROFILE.source, contextWindow: "detected", maxOutput: "user" },
    });
    expect(clamped.contextWindow).toBe(DEFAULT_MODEL_PROFILE.contextWindow);
    expect(clamped.maxOutput).toBeLessThan(clamped.contextWindow);

    const extreme = forgetDetected({
      ...DEFAULT_MODEL_PROFILE,
      contextWindow: 1_048_576,
      maxOutput: 200_000,
      source: { ...DEFAULT_MODEL_PROFILE.source, contextWindow: "detected", maxOutput: "user" },
    });
    expect(extreme.contextWindow).toBe(DEFAULT_MODEL_PROFILE.contextWindow);
    expect(extreme.maxOutput).toBe(DEFAULT_MODEL_PROFILE.maxOutput);
    expect(extreme.maxOutput).toBeLessThan(extreme.contextWindow);
    expect(extreme.source.maxOutput).toBe("default");
    expect(ModelProfileSchema.safeParse(extreme).success).toBe(true);
  });

  it("rejects path traversal in PluginManifestSchema and credentials/local hosts in ProviderFileSchema (F-23)", () => {
    const baseManifest = {
      format: PLUGIN_FORMAT,
      id: "com.example.test",
      name: "Test",
      version: "1.0.0",
      publisher: { id: "example", name: "Example" },
      description: "Test plugin",
      host: { min: "0.0.0" },
      permissions: [],
      provides: [],
      facets: [],
    };
    expect(PluginManifestSchema.safeParse({ ...baseManifest, entry: "../escape.mjs" }).success).toBe(false);
    expect(PluginManifestSchema.safeParse({ ...baseManifest, entry: "a/../b.mjs" }).success).toBe(false);
    expect(PluginManifestSchema.safeParse({
      ...baseManifest,
      entry: null,
      provides: [{ slot: "model.provider", id: "demo" }],
      provider: "./provider.json",
    }).success).toBe(false);
    expect(PluginManifestSchema.safeParse({ ...baseManifest, entry: "src/main.mjs" }).success).toBe(true);

    const baseProvider = {
      format: "manga-provider-v1",
      id: "demo",
      name: "Demo",
      baseUrl: "https://api.example.com",
      hosts: ["api.example.com"],
      models: [],
      services: [],
    };
    expect(ProviderFileSchema.safeParse(baseProvider).success).toBe(true);
    expect(ProviderFileSchema.safeParse({ ...baseProvider, baseUrl: ["https://", "user:pass", "@api.example.com"].join("") }).success).toBe(false);
    expect(ProviderFileSchema.safeParse({ ...baseProvider, hosts: ["api.localhost"] }).success).toBe(false);
    expect(ProviderFileSchema.safeParse({ ...baseProvider, hosts: ["box.local"] }).success).toBe(false);
    expect(ProviderFileSchema.safeParse({ ...baseProvider, hosts: ["svc.internal"] }).success).toBe(false);
  });

  it("covers every PLUGIN_REFUSALS reason and every LOGGED_COMMANDS entry in zh-CN i18n (F-20)", () => {
    const dict = catalogs["zh-CN"] as Record<string, string>;
    for (const reason of PLUGIN_REFUSALS) {
      expect(dict[`plugins.reason.${reason}`], `missing plugins.reason.${reason}`).toBeTruthy();
    }
    for (const [action, category] of Object.entries(LOGGED_COMMANDS)) {
      expect(dict[`log.${action}`], `missing log.${action}`).toBeTruthy();
      expect(dict[`log.category.${category}`], `missing log.category.${category}`).toBeTruthy();
    }
  });
});

describe("shared/utils", () => {
  it("formats errors, escapes LIKE wildcards, writes atomically, hashes files, and finds workspace root", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("plain")).toBe("plain");
    expect(escapeLike("100%_a\\b")).toBe("100\\%\\_a\\\\b");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manga-utils-"));
    tmpDirs.push(dir);
    const file = path.join(dir, "sub", "sample.txt");
    writeFileAtomic(file, "hello atomic");
    expect(fs.readFileSync(file, "utf8")).toBe("hello atomic");
    expect(sha256File(file)).toHaveLength(64);
    expect(sha512File(file, "hex")).toHaveLength(128);
    expect(Buffer.from(sha512File(file, "base64"), "base64")).toHaveLength(64);

    const root = findWorkspaceRoot(pathToFileURL(path.resolve("packages/app-core/src/shared/utils.ts")).href);
    expect(root).toBe(path.resolve("."));
  });
});
