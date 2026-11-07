import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MANIFEST_NAME, PACKAGED_PLUGIN_ASSETS, REQUIRED_ASSETS, verifyBundledAssets, type AssetManifest } from "../../apps/desktop/src/main/bundled-assets.ts";
import { makeKey, tmpDir } from "../helpers/plugin-fixtures.ts";
import { startApp, tempProfile } from "../helpers/app.ts";

/** The plugins that come with the application, built the way packaging builds them, but signed with a key made for the test. */
const key = makeKey("MANGA（第一方，测试）");
let resources = "";
let manifest: AssetManifest;
let stage: typeof import("../../scripts/desktop-plugins.ts");

beforeAll(async () => {
  // Loaded when needed: the bundler does not run in the DOM environment some other files use.
  stage = await import("../../scripts/desktop-plugins.ts");
  resources = tmpDir();
  // What `stageBundledAssets` leaves behind; the plugins are added to it.
  fs.writeFileSync(path.join(resources, MANIFEST_NAME), JSON.stringify({ version: 1, notices: [{ name: "FFmpeg", version: "8", license: "LGPL", source: "https://example.test", files: [] }], assets: [] }));
  manifest = await stage.stageBundledPlugins(resources, { privateKeyPem: key.privateKeyPem });
}, 60_000);

afterAll(() => { fs.rmSync(resources, { recursive: true, force: true }); });

describe("the plugins a package carries", () => {
  it("stages the BitTorrent package with its notices, and lists both in the manifest with sizes and hashes", () => {
    const entry = manifest.assets.find((asset) => asset.id === "plugin:manga.acquisition-bt");
    expect(entry?.path).toBe("plugins/manga.acquisition-bt-1.0.0.manga-plugin");
    expect(entry?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.statSync(path.join(resources, entry!.path)).size).toBe(entry!.bytes);
    const notice = manifest.notices.find((item) => item.name.endsWith("(bundled libraries)"));
    expect(notice?.files).toEqual(["plugins/manga.acquisition-bt.NOTICES.txt"]);
    // Notices already in the manifest stay.
    expect(manifest.notices.some((item) => item.name === "FFmpeg")).toBe(true);
    const text = fs.readFileSync(path.join(resources, notice!.files[0]!), "utf8");
    expect(text).toContain("webtorrent");
    expect(text).toMatch(/MIT/);
  });

  it("names every library the bundle took in with a permissive licence: nothing copyleft rides along", () => {
    const notice = manifest.notices.find((item) => item.name.endsWith("(bundled libraries)"))!;
    const licences = notice.license.split(", ");
    expect(licences.length).toBeGreaterThan(0);
    for (const licence of licences) expect(licence, licence).toMatch(/^(MIT|ISC|Apache-2\.0|BSD(-[23]-Clause)?|BlueOak-1\.0\.0|0BSD|CC0-1\.0|Unlicense)$/);
  });

  it("checks out against the manifest, deeply, and the packaged application requires the plugin", async () => {
    // The manifest has no media assets here, so only the plugin is required.
    expect(verifyBundledAssets(resources, { deep: true, required: PACKAGED_PLUGIN_ASSETS })).toEqual({ ok: true, problems: [] });
    expect(verifyBundledAssets(resources, { required: [...REQUIRED_ASSETS, ...PACKAGED_PLUGIN_ASSETS] }).problems).toContain("the package does not list ffmpeg");
    const file = path.join(resources, "plugins", "manga.acquisition-bt-1.0.0.manga-plugin");
    fs.appendFileSync(file, "x");
    expect(verifyBundledAssets(resources, { required: PACKAGED_PLUGIN_ASSETS }).problems).toEqual(["plugins/manga.acquisition-bt-1.0.0.manga-plugin has the wrong size"]);
    manifest = await stage.stageBundledPlugins(resources, { privateKeyPem: key.privateKeyPem });
    expect(verifyBundledAssets(resources, { deep: true, required: PACKAGED_PLUGIN_ASSETS }).ok).toBe(true);
  });

  it("is offered by the application as first-party, and is not installed until someone installs it", async () => {
    const ctx = await startApp({
      profileRoot: tempProfile(),
      options: { appVersion: "0.1.0", plugins: { firstPartyKeys: [{ publicKey: key.publicKey, label: key.label }], bundledDir: path.join(resources, "plugins") } },
    });
    try {
      const listed = await ctx.app.call(ctx.actor, { commandId: "plugin.bundled", idempotencyKey: "bundled-1", input: {} }, ctx.grant.handle);
      expect(listed.status).toBe("ok");
      const items = (listed.value as { bundled: Array<{ id: string; installed: boolean; trust: string }> }).bundled;
      expect(items).toEqual([expect.objectContaining({ id: "manga.acquisition-bt", installed: false, trust: "first-party" })]);
    } finally {
      ctx.app.close();
    }
  });

  it("reads the signing key from the variable, as the key's text or as the file that holds it", () => {
    const saved = process.env.MANGA_PLUGIN_SIGNING_KEY;
    try {
      process.env.MANGA_PLUGIN_SIGNING_KEY = key.privateKeyPem;
      expect(stage.signingKey().trim()).toBe(key.privateKeyPem.trim());
      const file = path.join(tmpDir(), "key.pem");
      fs.writeFileSync(file, key.privateKeyPem);
      process.env.MANGA_PLUGIN_SIGNING_KEY = file;
      expect(stage.signingKey().trim()).toBe(key.privateKeyPem.trim());
    } finally {
      if (saved === undefined) delete process.env.MANGA_PLUGIN_SIGNING_KEY; else process.env.MANGA_PLUGIN_SIGNING_KEY = saved;
    }
  });
});
