import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { MangaError, PLUGIN_FORMAT, PLUGIN_SIGNATURE_FORMAT, PluginManifestSchema, PluginSignatureSchema, type PluginManifest, type PluginRefusal, type PluginSignature } from "@manga/contracts";

/**
 * The plugin package (PLUG-04): a zip of `manifest.json`, `signature.json` and a `payload/` of files. The signature covers the manifest bytes and
 * the name, size and SHA-256 of every payload file, so nothing in the package can change without the signature failing. Reading a package never
 * runs anything in it and never writes anything: it unpacks into memory under hard limits, checks names and the signature file's shape, and
 * hands the parts back. Whether the signing key is trusted is the caller's decision.
 */
export const PLUGIN_LIMITS = { fileBytes: 256 * 1024 * 1024, entryBytes: 128 * 1024 * 1024, totalBytes: 512 * 1024 * 1024, entries: 4096, manifestBytes: 64 * 1024, nameChars: 200 } as const;

const PAYLOAD_NAME = /^payload\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export const refuse = (reason: PluginRefusal, message: string, extra: Record<string, unknown> = {}, code: "VALIDATION_ERROR" | "FORBIDDEN" | "API_INCOMPATIBLE" | "NOT_FOUND" = "VALIDATION_ERROR") =>
  new MangaError(code, message, { details: { reason, ...extra } });

export const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

// ------------------------------------------------------------------------------------------------------------------ keys

/** The DER prefix of an Ed25519 public key (SubjectPublicKeyInfo); the 32 raw bytes follow it. */
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** A public key as publishers hand it out: the 32 raw bytes, base64. */
export function publicKeyFromBase64(text: string): { key: KeyObject; raw: Buffer; keyId: string } {
  const raw = Buffer.from(text.trim(), "base64");
  if (raw.length !== 32 || raw.toString("base64") !== text.trim()) throw refuse("key", "a public key is 32 bytes in base64");
  const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });
  return { key, raw, keyId: keyIdOf(raw) };
}

export const keyIdOf = (raw: Uint8Array): string => createHash("sha256").update(raw).digest("hex").slice(0, 16);

export function rawPublicKey(key: KeyObject): Buffer {
  const der = key.export({ type: "spki", format: "der" });
  return Buffer.from(der.subarray(der.length - 32));
}

/** The words a person compares to be sure a key is the one the publisher gave them: groups of four hex digits. */
export const fingerprintOf = (raw: Uint8Array): string => (createHash("sha256").update(raw).digest("hex").slice(0, 32).match(/.{4}/g) ?? []).join(" ");

// ------------------------------------------------------------------------------------------------------------- signing

/** What is signed: the manifest by hash, then every payload file by name, size and hash, in name order. The text is fixed so both sides rebuild it exactly. */
export function signingMessage(manifestBytes: Uint8Array, files: ReadonlyMap<string, Uint8Array>): Buffer {
  const lines = [PLUGIN_FORMAT, `manifest ${sha256Hex(manifestBytes)}`];
  for (const name of [...files.keys()].sort()) lines.push(`payload/${name} ${files.get(name)!.length} ${sha256Hex(files.get(name)!)}`);
  return Buffer.from(`${lines.join("\n")}\n`, "utf8");
}

export type PluginParts = {
  manifest: PluginManifest;
  manifestBytes: Uint8Array;
  /** The payload files by their path under `payload/`. */
  files: Map<string, Uint8Array>;
  signature: PluginSignature;
};

/** Makes a package. Used by the tool that builds the application's own plugins and by tests; the host itself only reads packages. */
export function buildPluginPackage(input: { manifest: unknown; files: Record<string, Uint8Array | string>; privateKeyPem: string; signedAt?: string }): Buffer {
  const manifest = PluginManifestSchema.parse(input.manifest);
  const manifestBytes = strToU8(`${JSON.stringify(manifest, null, 2)}\n`);
  const files = new Map<string, Uint8Array>(Object.entries(input.files).map(([name, data]) => [name, typeof data === "string" ? strToU8(data) : data]));
  if (manifest.entry !== null && !files.has(manifest.entry)) throw refuse("entry", "the entry is not in the payload");
  const privateKey = createPrivateKey(input.privateKeyPem);
  const publicKey = createPublicKey(privateKey);
  const raw = rawPublicKey(publicKey);
  const signature: PluginSignature = {
    format: PLUGIN_SIGNATURE_FORMAT, algorithm: "ed25519", keyId: keyIdOf(raw), signedAt: input.signedAt ?? new Date().toISOString(),
    signature: sign(null, signingMessage(manifestBytes, files), privateKey).toString("base64"),
  };
  const entries: Record<string, Uint8Array> = { "manifest.json": manifestBytes, "signature.json": strToU8(`${JSON.stringify(signature, null, 2)}\n`) };
  for (const [name, data] of files) entries[`payload/${name}`] = data;
  return Buffer.from(zipSync(entries, { level: 6 }));
}

// ------------------------------------------------------------------------------------------------------------- reading

/** Whether a payload path is safe on every system the package may be unpacked on. */
export function safePayloadName(name: string): boolean {
  if (name.length > PLUGIN_LIMITS.nameChars || !PAYLOAD_NAME.test(name)) return false;
  return name.split("/").every((part) => part !== "." && part !== ".." && !/[. ]$/.test(part) && !RESERVED.test(part));
}

/** Unpacks into memory under the limits and checks the shape of everything; the signature itself is checked by `signatureHolds`. */
export function readPluginPackage(data: Uint8Array): PluginParts {
  if (data.length > PLUGIN_LIMITS.fileBytes) throw refuse("size", "the package is too large");
  let files: Record<string, Uint8Array>;
  let count = 0;
  let total = 0;
  const names = new Set<string>();
  try {
    files = unzipSync(data, {
      filter: (file) => {
        count += 1;
        if (count > PLUGIN_LIMITS.entries) throw refuse("size", "the package holds too many files");
        if (file.name.endsWith("/")) return false;
        const lower = file.name.toLowerCase();
        if (names.has(lower)) throw refuse("unsafe", "the package holds a file twice");
        names.add(lower);
        if (file.name !== "manifest.json" && file.name !== "signature.json" && !(file.name.startsWith("payload/") && safePayloadName(file.name))) throw refuse("unsafe", "the package holds a file with a name that is not allowed");
        if (file.originalSize > PLUGIN_LIMITS.entryBytes) throw refuse("size", "a file in the package is too large");
        total += file.originalSize;
        if (total > PLUGIN_LIMITS.totalBytes) throw refuse("size", "the package is too large once unpacked");
        return true;
      },
    });
  } catch (error) {
    if (error instanceof MangaError) throw error;
    throw refuse("format", "this is not a readable zip file");
  }
  const manifestBytes = files["manifest.json"];
  if (!manifestBytes) throw refuse("format", "the package has no manifest");
  if (manifestBytes.length > PLUGIN_LIMITS.manifestBytes) throw refuse("size", "the manifest is too large");
  const signatureBytes = files["signature.json"];
  if (!signatureBytes) throw refuse("unsigned", "the package is not signed");
  let manifest: PluginManifest;
  try { manifest = PluginManifestSchema.parse(JSON.parse(strFromU8(manifestBytes))); } catch (error) {
    throw refuse("manifest", "the manifest is not valid", { problem: error instanceof Error ? error.message.slice(0, 300) : "" });
  }
  let signature: PluginSignature;
  try { signature = PluginSignatureSchema.parse(JSON.parse(strFromU8(signatureBytes))); } catch { throw refuse("signature", "the signature file is not valid"); }
  const payload = new Map<string, Uint8Array>();
  for (const [name, bytes] of Object.entries(files)) if (name.startsWith("payload/")) payload.set(name.slice("payload/".length), bytes);
  if (manifest.entry !== null && !payload.has(manifest.entry)) throw refuse("entry", "the entry is not in the payload");
  return { manifest, manifestBytes, files: payload, signature };
}

/** Whether the signature is a signature of exactly these bytes by this key. */
export function signatureHolds(parts: PluginParts, publicKey: KeyObject): boolean {
  try {
    return verify(null, signingMessage(parts.manifestBytes, parts.files), publicKey, Buffer.from(parts.signature.signature, "base64"));
  } catch { return false; }
}

/** The hashes an installed copy is checked against each time it is started. */
export function fileHashes(files: ReadonlyMap<string, Uint8Array>): Array<{ path: string; bytes: number; sha256: string }> {
  return [...files.keys()].sort().map((name) => ({ path: name, bytes: files.get(name)!.length, sha256: sha256Hex(files.get(name)!) }));
}

/** Compares two versions of three numbers; negative when `a` is older. */
export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) if (left[i] !== right[i]) return (left[i] ?? 0) - (right[i] ?? 0);
  return 0;
}
