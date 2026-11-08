import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { z } from "zod";
import { MangaError, UPDATE_ERROR_MESSAGES } from "@manga/contracts";
import { keyIdOf, publicKeyFromBase64, rawPublicKey } from "../plugins/package.ts";

export { rawPublicKey };

/**
 * Built-in Ed25519 public key for MANGA release installer updates (计划 4.4, AT-160).
 * Separate from plugin `FIRST_PARTY_KEYS` so compromise of one key never affects the other.
 */
export const RELEASE_UPDATE_PUBLIC_KEYS: ReadonlyArray<{ publicKey: string; label: string }> = [
  { publicKey: "/QcvJ88lzHM5/JLVgAfn12mVRJrWBwR0vJVXwkyQY1Y=", label: "MANGA Release Update" },
];

export const UPDATE_SIGNATURE_FORMAT = "manga.update.signature.v1";

export const ReleaseInstallerSignatureSchema = z.object({
  format: z.literal(UPDATE_SIGNATURE_FORMAT),
  algorithm: z.literal("ed25519"),
  keyId: z.string().min(1),
  version: z.string().min(1),
  fileName: z.string().min(1),
  sha512: z.string().min(1),
  size: z.number().int().positive(),
  signedAt: z.string().min(1),
  signature: z.string().min(1),
}).strict();

export type ReleaseInstallerSignature = z.infer<typeof ReleaseInstallerSignatureSchema>;

export type VerifiedUpdateReceipt = {
  installerPath: string;
  sha512: string;
  version: string;
  fileName: string;
  keyId: string;
  size: number;
  verifiedAt: string;
};

export type VerifyReleaseInstallerResult =
  | { ok: true; receipt: VerifiedUpdateReceipt }
  | { ok: false; reason: string; message: string };

export function sha512BytesBase64(bytes: Uint8Array): string {
  return createHash("sha512").update(bytes).digest("base64");
}

export function sha512FileBase64(filePath: string): string {
  return sha512BytesBase64(fs.readFileSync(filePath));
}

/**
 * Canonical signed message for a release installer (计划 4.4):
 * Covers format, exact version, installer fileName (`manga-setup-<version>.exe`), and SHA-512,
 * preventing an older version's valid installer from being replayed as a newer version.
 */
export function updateSigningMessage(input: { version: string; fileName: string; sha512: string }): Buffer {
  return Buffer.from(
    `${UPDATE_SIGNATURE_FORMAT}\nversion ${input.version.trim()}\nfileName ${input.fileName.trim()}\nsha512 ${input.sha512.trim()}\n`,
    "utf8",
  );
}

/**
 * Sign a release installer `.exe` and optionally write the detached `<installerPath>.sig` file (计划 4.4, W4).
 */
export function signReleaseInstaller(options: {
  installerPath: string;
  version: string;
  fileName?: string;
  privateKeyPem: string;
  outputSigPath?: string | null;
  signedAt?: string;
}): { sigPath: string | null; signature: ReleaseInstallerSignature; sigText: string } {
  if (!fs.existsSync(options.installerPath)) {
    throw new Error(`installer file does not exist: ${options.installerPath}`);
  }
  const stat = fs.statSync(options.installerPath);
  if (!stat.isFile() || stat.size <= 0) {
    throw new Error(`installer file is empty: ${options.installerPath}`);
  }
  const version = options.version.trim();
  if (!version) throw new Error("version is required to sign release installer");
  const fileName = (options.fileName ?? path.basename(options.installerPath)).trim();
  if (!fileName || path.basename(fileName) !== fileName || !fileName.toLowerCase().endsWith(".exe")) {
    throw new Error(`invalid installer fileName: ${fileName}`);
  }
  const sha512 = sha512FileBase64(options.installerPath);
  const privateKey = createPrivateKey(options.privateKeyPem);
  const publicKey = createPublicKey(privateKey);
  const raw = rawPublicKey(publicKey);
  const message = updateSigningMessage({ version, fileName, sha512 });
  const signatureObj: ReleaseInstallerSignature = ReleaseInstallerSignatureSchema.parse({
    format: UPDATE_SIGNATURE_FORMAT,
    algorithm: "ed25519",
    keyId: keyIdOf(raw),
    version,
    fileName,
    sha512,
    size: stat.size,
    signedAt: options.signedAt ?? new Date().toISOString(),
    signature: sign(null, message, privateKey).toString("base64"),
  });
  const sigText = `${JSON.stringify(signatureObj, null, 2)}\n`;
  const sigPath = options.outputSigPath === null ? null : (options.outputSigPath ?? `${options.installerPath}.sig`);
  if (sigPath) {
    fs.mkdirSync(path.dirname(sigPath), { recursive: true });
    fs.writeFileSync(sigPath, sigText, "utf8");
  }
  return { sigPath, signature: signatureObj, sigText };
}

/**
 * Verify a downloaded release installer against its detached `.sig` and built-in Ed25519 public keys (计划 4.4, AT-160).
 */
export function verifyReleaseInstaller(options: {
  installerPath: string;
  expectedVersion: string;
  expectedFileName?: string;
  sigText?: string | null;
  sigPath?: string;
  publicKeys?: ReadonlyArray<{ publicKey: string; label: string }>;
}): VerifyReleaseInstallerResult {
  const fail = (reason: string): VerifyReleaseInstallerResult => ({
    ok: false,
    reason,
    message: UPDATE_ERROR_MESSAGES.UPDATE_VERIFY_FAILED,
  });

  if (!options.installerPath || !fs.existsSync(options.installerPath)) {
    return fail("installer-missing");
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(options.installerPath);
  } catch {
    return fail("installer-missing");
  }
  if (!stat.isFile() || stat.size <= 0) {
    return fail("installer-empty");
  }

  let rawSig = options.sigText ?? null;
  if (rawSig === null || rawSig === undefined) {
    const candidatePath = options.sigPath ?? `${options.installerPath}.sig`;
    if (!fs.existsSync(candidatePath)) {
      return fail("signature-missing");
    }
    try {
      rawSig = fs.readFileSync(candidatePath, "utf8");
    } catch {
      return fail("signature-missing");
    }
  }
  if (typeof rawSig !== "string" || !rawSig.trim()) {
    return fail("signature-missing");
  }

  let parsedSig: ReleaseInstallerSignature;
  try {
    parsedSig = ReleaseInstallerSignatureSchema.parse(JSON.parse(rawSig));
  } catch {
    return fail("signature-invalid");
  }

  const expectedVersion = options.expectedVersion.trim();
  if (!expectedVersion || parsedSig.version !== expectedVersion) {
    return fail("version-mismatch");
  }

  const expectedFileName = (options.expectedFileName ?? path.basename(options.installerPath)).trim();
  if (!expectedFileName || parsedSig.fileName !== expectedFileName) {
    return fail("filename-mismatch");
  }

  if (parsedSig.size !== stat.size) {
    return fail("size-mismatch");
  }

  const actualSha512 = sha512FileBase64(options.installerPath);
  if (actualSha512 !== parsedSig.sha512) {
    return fail("sha512-mismatch");
  }

  const keys = options.publicKeys ?? RELEASE_UPDATE_PUBLIC_KEYS;
  if (!keys.length) {
    return fail("no-trusted-keys");
  }
  const message = updateSigningMessage({
    version: parsedSig.version,
    fileName: parsedSig.fileName,
    sha512: parsedSig.sha512,
  });
  let sigBytes: Buffer;
  try {
    sigBytes = Buffer.from(parsedSig.signature, "base64");
    if (sigBytes.length !== 64) return fail("signature-invalid");
  } catch {
    return fail("signature-invalid");
  }

  let verifiedKeyId: string | null = null;
  for (const entry of keys) {
    try {
      const parsedKey = publicKeyFromBase64(entry.publicKey);
      if (parsedSig.keyId && parsedKey.keyId !== parsedSig.keyId) continue;
      if (verify(null, message, parsedKey.key, sigBytes)) {
        verifiedKeyId = parsedKey.keyId;
        break;
      }
    } catch {
      continue;
    }
  }
  if (!verifiedKeyId) {
    return fail("signature-mismatch");
  }

  return {
    ok: true,
    receipt: {
      installerPath: path.resolve(options.installerPath),
      sha512: actualSha512,
      version: parsedSig.version,
      fileName: parsedSig.fileName,
      keyId: verifiedKeyId,
      size: stat.size,
      verifiedAt: new Date().toISOString(),
    },
  };
}

/**
 * Verify a release installer or delete it and throw `UPDATE_VERIFY_FAILED`.
 */
export function assertReleaseInstallerVerified(options: Parameters<typeof verifyReleaseInstaller>[0]): VerifiedUpdateReceipt {
  const result = verifyReleaseInstaller(options);
  if (!result.ok) {
    try {
      if (options.installerPath && fs.existsSync(options.installerPath)) {
        fs.rmSync(options.installerPath, { force: true });
      }
    } catch {
      // ignore cleanup error
    }
    throw new MangaError("UPDATE_VERIFY_FAILED", result.message, {
      details: { reason: result.reason },
    });
  }
  return result.receipt;
}

/**
 * Check that `app-update.yml` has `provider: github`, `owner: chialecode`, `repo: manga`, and `publisherName` including `chialecode` (计划 3.1, 4.4).
 */
export function checkAppUpdateConfig(yamlText: string | null | undefined): string[] {
  const problems: string[] = [];
  if (typeof yamlText !== "string" || !yamlText.trim()) {
    return ["app-update.yml missing"];
  }
  if (!/^provider:\s*github\s*$/m.test(yamlText)) problems.push("provider is not github");
  if (!/^owner:\s*chialecode\s*$/m.test(yamlText)) problems.push("owner is not chialecode");
  if (!/^repo:\s*manga\s*$/m.test(yamlText)) problems.push("repo is not manga");
  if (!/^updaterCacheDirName:[ \t]*updater[ \t]*$/m.test(yamlText)) problems.push("invalid updater cache directory");
  for (const field of ["provider", "owner", "repo", "updaterCacheDirName", "publisherName"]) {
    if ([...yamlText.matchAll(new RegExp(`^${field}:`, "gm"))].length > 1) problems.push(`duplicate ${field}`);
  }
  const hasPublisherList = /^publisherName:\s*\r?\n(?:\s*-\s*\S+\s*\r?\n?)*\s*-\s*chialecode\s*$/m.test(yamlText);
  const hasPublisherScalar = /^publisherName:\s*chialecode\s*$/m.test(yamlText);
  if (!hasPublisherList && !hasPublisherScalar) {
    problems.push("missing publisherName chialecode");
  }
  return problems;
}

const RELEASE_SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * Compare two `X.Y.Z` release versions. Returns `< 0` when `a < b`, `0` when equal, `> 0` when `a > b`.
 * Throws if either version is not a plain `X.Y.Z` release version.
 */
export function compareReleaseVersions(a: string, b: string): number {
  const ma = RELEASE_SEMVER_RE.exec(a.trim().replace(/^v/, ""));
  const mb = RELEASE_SEMVER_RE.exec(b.trim().replace(/^v/, ""));
  if (!ma || !mb) {
    throw new Error(`invalid release version comparison: "${a}" vs "${b}"`);
  }
  for (let i = 1; i <= 3; i += 1) {
    const diff = Number.parseInt(ma[i]!, 10) - Number.parseInt(mb[i]!, 10);
    if (diff !== 0) return diff;
  }
  return 0;
}

export type LatestManifest = {
  version: string;
  fileName: string;
  sha512: string;
  size: number;
  releaseDate: string;
  releaseNotes: string;
  schemaVersion: number | null;
  draft: boolean;
  prerelease: boolean;
};

/**
 * Format a `latest.yml` manifest for a release installer (计划 4.3, 4.5).
 */
export function formatLatestYaml(input: {
  version: string;
  fileName: string;
  sha512: string;
  size: number;
  releaseDate?: string;
  releaseNotes?: string;
  schemaVersion?: number;
}): string {
  const releaseDate = input.releaseDate ?? new Date().toISOString();
  const lines = [
    `version: ${input.version.trim()}`,
    "files:",
    `  - url: ${input.fileName.trim()}`,
    `    sha512: ${input.sha512.trim()}`,
    `    size: ${input.size}`,
    `path: ${input.fileName.trim()}`,
    `sha512: ${input.sha512.trim()}`,
    `releaseDate: '${releaseDate}'`,
  ];
  if (typeof input.schemaVersion === "number" && Number.isInteger(input.schemaVersion) && input.schemaVersion > 0) {
    lines.push(`schemaVersion: ${input.schemaVersion}`);
  }
  if (input.releaseNotes !== undefined && input.releaseNotes.trim().length > 0) {
    lines.push("releaseNotes: |-");
    for (const line of input.releaseNotes.replace(/\r\n/g, "\n").split("\n")) {
      lines.push(`  ${line}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Parse and validate a `latest.yml` manifest (计划 4.3, 4.4).
 */
export function parseLatestYaml(yamlText: string): LatestManifest {
  if (typeof yamlText !== "string" || !yamlText.trim()) {
    throw new Error("latest.yml is empty");
  }
  const normalized = yamlText.replace(/\r\n/g, "\n");
  const fields = normalized.replace(/^releaseNotes:[ \t]*\|[-+]?[ \t]*\n(?: {2}.*\n?|\n)*/m, "");
  const scalar = (key: string): string | null => {
    const matches = [...fields.matchAll(new RegExp(`^${key}:[ \\t]*(.+?)[ \\t]*$`, "gm"))];
    if (matches.length > 1) throw new Error(`latest.yml duplicate ${key}`);
    const match = matches[0];
    if (!match) return null;
    return match[1]!.replace(/^['"]|['"]$/g, "").trim();
  };

  const version = scalar("version");
  if (!version) throw new Error("latest.yml missing version");
  const draft = scalar("draft") === "true";
  const prerelease = scalar("prerelease") === "true" || version.includes("-");
  if (!prerelease && !RELEASE_SEMVER_RE.test(version)) {
    throw new Error(`latest.yml invalid version: ${version}`);
  }

  const fileUrls = [...fields.matchAll(/^ {2}- url:[ \t]*(.+?)[ \t]*$/gm)];
  if (fileUrls.length !== 1) throw new Error("latest.yml must contain one installer");
  const fileUrlMatch = fileUrls[0];
  const pathVal = scalar("path") ?? (fileUrlMatch ? fileUrlMatch[1]!.replace(/^['"]|['"]$/g, "").trim() : null);
  if (!pathVal) throw new Error("latest.yml missing path/url");
  if (pathVal !== fileUrlMatch![1]!.replace(/^['"]|['"]$/g, "").trim()) throw new Error("latest.yml path/url mismatch");
  // Note: pathVal may be a filename (`manga-setup-0.1.2.exe`) or a URL in malicious manifests (checked by caller).
  const fileHashes = [...fields.matchAll(/^ {4}sha512:[ \t]*(.+?)[ \t]*$/gm)];
  if (fileHashes.length !== 1) throw new Error("latest.yml must contain one installer checksum");
  const fileHash = fileHashes[0]![1]!.replace(/^['"]|['"]$/g, "").trim();
  const sha512 = scalar("sha512") ?? fileHash;
  if (sha512 !== fileHash || Buffer.from(sha512, "base64").length !== 64) throw new Error("latest.yml invalid or inconsistent sha512");

  const sizes = [...fields.matchAll(/^ {4}size:[ \t]*(\d+)[ \t]*$/gm)];
  if (sizes.length !== 1) throw new Error("latest.yml must contain one installer size");
  const sizeMatch = sizes[0];
  const size = sizeMatch ? Number.parseInt(sizeMatch[1]!, 10) : 0;
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new Error("latest.yml missing valid size");
  }

  const releaseDate = scalar("releaseDate") ?? new Date().toISOString();
  const schemaRaw = scalar("schemaVersion");
  const schemaVersion = schemaRaw && /^\d+$/.test(schemaRaw) ? Number.parseInt(schemaRaw, 10) : null;
  if (schemaRaw !== null && (!Number.isSafeInteger(schemaVersion) || !schemaVersion || schemaVersion <= 0)) throw new Error("latest.yml invalid schemaVersion");

  let releaseNotes = "";
  const blockMatch = /^releaseNotes:\s*\|[-+]?\s*\n((?: {2}.*\n?|\n)*)/m.exec(normalized);
  if (blockMatch) {
    releaseNotes = blockMatch[1]!
      .split("\n")
      .map((line) => (line.startsWith("  ") ? line.slice(2) : line))
      .join("\n")
      .trim();
  } else {
    const inlineNotes = scalar("releaseNotes");
    if (inlineNotes && !inlineNotes.startsWith("|")) releaseNotes = inlineNotes;
  }

  return {
    version,
    fileName: pathVal,
    sha512,
    size,
    releaseDate,
    releaseNotes,
    schemaVersion,
    draft,
    prerelease,
  };
}

export type BlockMapFileEntry = {
  name: string;
  offset: number;
  checksums: string[];
  sizes: number[];
};

export type BlockMapData = {
  version: "2";
  files: BlockMapFileEntry[];
};

const BlockMapSchema = z.object({
  version: z.literal("2"),
  files: z.array(
    z.object({
      name: z.string().min(1),
      offset: z.number().int().nonnegative(),
      checksums: z.array(z.string().min(1)),
      sizes: z.array(z.number().int().positive()),
    }),
  ).min(1),
});

/**
 * Build an electron-builder-compatible v2 blockmap from installer bytes.
 */
export function buildBlockMap(bytes: Uint8Array, blockSize = 65536): BlockMapData {
  if (blockSize <= 0) throw new Error("blockSize must be positive");
  const checksums: string[] = [];
  const sizes: number[] = [];
  for (let offset = 0; offset < bytes.length; offset += blockSize) {
    const slice = bytes.subarray(offset, Math.min(offset + blockSize, bytes.length));
    checksums.push(createHash("sha256").update(slice).digest("base64url"));
    sizes.push(slice.length);
  }
  return {
    version: "2",
    files: [
      {
        name: "file",
        offset: 0,
        checksums,
        sizes,
      },
    ],
  };
}

export function serializeBlockMapGzip(blockMap: BlockMapData): Buffer {
  return zlib.gzipSync(Buffer.from(JSON.stringify(blockMap), "utf8"));
}

export function parseBlockMapBytes(raw: Uint8Array): BlockMapData {
  let text: string;
  if (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b) {
    text = zlib.gunzipSync(raw).toString("utf8");
  } else {
    text = Buffer.from(raw).toString("utf8");
  }
  return BlockMapSchema.parse(JSON.parse(text));
}

export type DifferentialOperation = {
  kind: "copy" | "download";
  start: number;
  end: number;
};

/**
 * Compute COPY (from old installer) and DOWNLOAD (HTTP Range from new installer) operations between two blockmaps.
 */
export function computeBlockMapPlan(oldBlockMap: BlockMapData, newBlockMap: BlockMapData): {
  operations: DifferentialOperation[];
  downloadBytes: number;
  copyBytes: number;
  totalBytes: number;
} {
  if (oldBlockMap.version !== "2" || newBlockMap.version !== "2") {
    throw new Error("unsupported blockmap version");
  }
  const oldFile = oldBlockMap.files[0];
  const newFile = newBlockMap.files[0];
  if (!oldFile || !newFile || oldFile.checksums.length !== oldFile.sizes.length || newFile.checksums.length !== newFile.sizes.length) {
    throw new Error("invalid blockmap file entries");
  }
  const oldOffsets = new Map<string, { offset: number; size: number }>();
  let cursor = oldFile.offset;
  for (let i = 0; i < oldFile.checksums.length; i += 1) {
    const checksum = oldFile.checksums[i]!;
    const size = oldFile.sizes[i]!;
    if (!oldOffsets.has(checksum)) {
      oldOffsets.set(checksum, { offset: cursor, size });
    }
    cursor += size;
  }

  const operations: DifferentialOperation[] = [];
  let downloadBytes = 0;
  let copyBytes = 0;
  let newOffset = newFile.offset;

  for (let i = 0; i < newFile.checksums.length; i += 1) {
    const checksum = newFile.checksums[i]!;
    const size = newFile.sizes[i]!;
    const match = oldOffsets.get(checksum);
    if (match && match.size === size) {
      copyBytes += size;
      const prev = operations[operations.length - 1];
      if (prev && prev.kind === "copy" && prev.end === match.offset) {
        prev.end += size;
      } else {
        operations.push({ kind: "copy", start: match.offset, end: match.offset + size });
      }
    } else {
      downloadBytes += size;
      const prev = operations[operations.length - 1];
      if (prev && prev.kind === "download" && prev.end === newOffset) {
        prev.end += size;
      } else {
        operations.push({ kind: "download", start: newOffset, end: newOffset + size });
      }
    }
    newOffset += size;
  }

  return {
    operations,
    downloadBytes,
    copyBytes,
    totalBytes: downloadBytes + copyBytes,
  };
}
