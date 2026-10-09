import { strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { MangaError } from "@manga/contracts";
import { PLUGIN_LIMITS, buildPluginPackage, compareVersions, fileHashes, publicKeyFromBase64, readPluginPackage, safePayloadName, signatureHolds } from "../../packages/app-core/src/plugins/package.ts";
import { makeKey, manifestOf, packageBytes } from "../helpers/plugin-fixtures.ts";
import { DRIVE } from "../helpers/hostile-input.ts";

const key = makeKey();
const reason = (run: () => unknown): string | undefined => {
  try { run(); } catch (error) { return (error as MangaError).details?.reason as string; }
  return undefined;
};
const rezip = (bytes: Uint8Array, change: (files: Record<string, Uint8Array>) => Record<string, Uint8Array>) => zipSync(change(unzipSync(bytes)));

describe("the plugin package", () => {
  it("is read back as it was signed: manifest, files and a signature the key verifies", () => {
    const parts = readPluginPackage(packageBytes({ key, files: { "lib/a.js": "a", "data.json": "{}" } }));
    expect(parts.manifest.id).toBe("demo.tool");
    expect([...parts.files.keys()].sort()).toEqual(["data.json", "lib/a.js", "main.mjs"]);
    expect(signatureHolds(parts, publicKeyFromBase64(key.publicKey).key)).toBe(true);
    expect(parts.signature.keyId).toBe(publicKeyFromBase64(key.publicKey).keyId);
    expect(fileHashes(parts.files).map((item) => item.path)).toEqual(["data.json", "lib/a.js", "main.mjs"]);
  });

  it("does not verify under another key, and not after any byte changes", () => {
    const other = publicKeyFromBase64(makeKey().publicKey).key;
    const bytes = packageBytes({ key });
    const parts = readPluginPackage(bytes);
    expect(signatureHolds(parts, other)).toBe(false);
    const changedFile = readPluginPackage(rezip(bytes, (files) => ({ ...files, "payload/main.mjs": strToU8("process.exit(0)") })));
    expect(signatureHolds(changedFile, publicKeyFromBase64(key.publicKey).key)).toBe(false);
    const extraFile = readPluginPackage(rezip(bytes, (files) => ({ ...files, "payload/extra.js": strToU8("1") })));
    expect(signatureHolds(extraFile, publicKeyFromBase64(key.publicKey).key)).toBe(false);
  });

  it("does not verify when the manifest is edited to claim another identity or more permissions", () => {
    const bytes = packageBytes({ key });
    const forged = readPluginPackage(rezip(bytes, (files) => {
      const manifest = JSON.parse(Buffer.from(files["manifest.json"]!).toString("utf8"));
      return { ...files, "manifest.json": strToU8(JSON.stringify({ ...manifest, publisher: { id: "manga", name: "MANGA（第一方）" }, permissions: ["network", "files"] })) };
    }));
    expect(forged.manifest.publisher.id).toBe("manga");
    expect(signatureHolds(forged, publicKeyFromBase64(key.publicKey).key)).toBe(false);
  });

  it("refuses what is not a package, with the reason", () => {
    expect(reason(() => readPluginPackage(Buffer.from("not a zip at all")))).toBe("format");
    expect(reason(() => readPluginPackage(zipSync({ "readme.txt": strToU8("hello") })))).toBe("unsafe");
    expect(reason(() => readPluginPackage(zipSync({ "payload/main.mjs": strToU8("1") })))).toBe("format");
    const bytes = packageBytes({ key });
    expect(reason(() => readPluginPackage(rezip(bytes, (files) => { const { "signature.json": _gone, ...rest } = files; return rest; })))).toBe("unsigned");
    expect(reason(() => readPluginPackage(rezip(bytes, (files) => ({ ...files, "signature.json": strToU8("{}") }))))).toBe("signature");
    expect(reason(() => readPluginPackage(rezip(bytes, (files) => ({ ...files, "manifest.json": strToU8("{\"id\":1}") }))))).toBe("manifest");
    expect(reason(() => readPluginPackage(rezip(bytes, (files) => { const { "payload/main.mjs": _gone, ...rest } = files; return rest; })))).toBe("entry");
  });

  it("refuses names that would land outside the plugin's folder (zip slip) and names a system cannot hold", () => {
    const base = packageBytes({ key });
    for (const name of ["payload/../evil.mjs", "payload/a/../../evil.mjs", "../evil.mjs", "/etc/evil", "payload//x.js", "payload/a\\b.js", `payload/${DRIVE}:/x.js`, "payload/con.js", "payload/dots..", "payload/trail ", "payload/.."]) {
      expect(reason(() => readPluginPackage(rezip(base, (files) => ({ ...files, [name]: strToU8("x") })))), name).toBe("unsafe");
    }
    expect(safePayloadName("payload/ok/file-1.js")).toBe(true);
    expect(safePayloadName("payload/ok/../file.js")).toBe(false);
    expect(safePayloadName(`payload/${"a".repeat(PLUGIN_LIMITS.nameChars)}`)).toBe(false);
    // The same name twice in different letter case would be one file on some systems.
    expect(reason(() => readPluginPackage(rezip(base, (files) => ({ ...files, "payload/Main.mjs": strToU8("x") }))))).toBe("unsafe");
  });

  it("refuses a package that is too large, holds too many files, or has a manifest that is too large", () => {
    const bytes = packageBytes({ key });
    expect(reason(() => readPluginPackage(Buffer.alloc(PLUGIN_LIMITS.fileBytes + 1)))).toBe("size");
    const many: Record<string, Uint8Array> = {};
    for (let i = 0; i <= PLUGIN_LIMITS.entries; i += 1) many[`payload/f${i}.js`] = strToU8("1");
    expect(reason(() => readPluginPackage(rezip(bytes, (files) => ({ ...files, ...many }))))).toBe("size");
    expect(reason(() => readPluginPackage(rezip(bytes, (files) => ({ ...files, "manifest.json": new Uint8Array(PLUGIN_LIMITS.manifestBytes + 1).fill(32) }))))).toBe("size");
  });

  it("only accepts a manifest that says what it is", () => {
    const good = manifestOf({ key });
    const build = (change: Record<string, unknown>) => () => buildPluginPackage({ manifest: { ...good, ...change }, files: { "main.mjs": "1" }, privateKeyPem: key.privateKeyPem });
    expect(build({ version: "1.0" })).toThrow();
    expect(build({ id: "Bad Id" })).toThrow();
    expect(build({ permissions: ["network", "network"] })).toThrow();
    expect(build({ permissions: ["root"] })).toThrow();
    expect(build({ entry: "../main.mjs" })).toThrow();
    expect(build({ entry: "main.exe" })).toThrow();
    expect(build({ entry: null, provides: [{ slot: "acquisition.engine", id: "x" }] })).toThrow();
    expect(build({ extra: 1 })).toThrow();
    expect(() => buildPluginPackage({ manifest: good, files: {}, privateKeyPem: key.privateKeyPem })).toThrow(MangaError);
  });

  it("compares versions as three numbers", () => {
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.10.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareVersions("0.9.9", "1.0.0")).toBeLessThan(0);
  });

  it("takes a public key only as 32 bytes in base64", () => {
    expect(() => publicKeyFromBase64("abc")).toThrow();
    expect(() => publicKeyFromBase64(Buffer.alloc(31).toString("base64"))).toThrow();
    expect(publicKeyFromBase64(key.publicKey).keyId).toMatch(/^[a-f0-9]{16}$/);
  });
});
