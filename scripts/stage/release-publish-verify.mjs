import { spawnSync } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BUILTIN_RELEASE_UPDATE_PUBLIC_KEY = "/QcvJ88lzHM5/JLVgAfn12mVRJrWBwR0vJVXwkyQY1Y=";
const UPDATE_SIGNATURE_FORMAT = "manga.update.signature.v1";
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function sha256HexFile(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function sha512Base64File(filePath) {
  return createHash("sha512").update(fs.readFileSync(filePath)).digest("base64");
}

function parsePublicKeyBase64(base64Text) {
  const raw = Buffer.from(String(base64Text).trim(), "base64");
  if (raw.length !== 32) throw new Error("invalid Ed25519 public key length");
  const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });
  const keyId = createHash("sha256").update(raw).digest("hex").slice(0, 16);
  return { key, keyId };
}

function updateSigningMessage({ version, fileName, sha512 }) {
  return Buffer.from(
    `${UPDATE_SIGNATURE_FORMAT}\nversion ${version.trim()}\nfileName ${fileName.trim()}\nsha512 ${sha512.trim()}\n`,
    "utf8",
  );
}

/** Only one Windows installer is allowed in MANGA's generated manifest; comments and notes cannot supply fields. */
export function verifyReleaseManifest(text, { version, installerName, sha512, size }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const top = new Map();
  const file = new Map();
  let inFiles = false;
  let inNotes = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (inNotes && line.startsWith("  ")) continue;
    inNotes = false;
    if (line === "releaseNotes: |-" || line === "releaseNotes: |") {
      if (top.has("releaseNotes")) throw new Error("latest.yml has duplicate releaseNotes");
      top.set("releaseNotes", "block"); inNotes = true; inFiles = false; continue;
    }
    if (line === "files:") {
      if (top.has("files")) throw new Error("latest.yml has duplicate files");
      top.set("files", "list"); inFiles = true; continue;
    }
    const entry = inFiles && /^  - url:\s*(\S+)\s*$|^    (sha512|size):\s*(\S+)\s*$/.exec(line);
    if (entry) {
      const key = entry[1] ? "url" : entry[2];
      if (file.has(key)) throw new Error(`latest.yml has duplicate installer ${key}`);
      file.set(key, entry[1] ?? entry[3]); continue;
    }
    inFiles = false;
    const scalar = /^(version|path|sha512|releaseDate|schemaVersion):\s*(.+?)\s*$/.exec(line);
    if (!scalar || top.has(scalar[1])) throw new Error("latest.yml has unknown, duplicate or malformed fields");
    top.set(scalar[1], scalar[2].replace(/^(['"])(.*)\1$/, "$2"));
  }
  if (top.get("version") !== version || top.get("path") !== installerName || top.get("sha512") !== sha512
    || file.get("url") !== installerName || file.get("sha512") !== sha512 || file.get("size") !== String(size)) {
    throw new Error("latest.yml does not match verified installer version/fileName/sha512/size");
  }
  const schemaVersion = Number(top.get("schemaVersion"));
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion <= 0 || !Number.isFinite(Date.parse(top.get("releaseDate")))) {
    throw new Error("latest.yml has invalid schemaVersion or releaseDate");
  }
  return { schemaVersion, releaseDate: top.get("releaseDate") };
}

/**
 * Zero-dependency verifier for the `publish` job in `.github/workflows/release.yml` (计划 4.9, AT-163).
 * Verifies:
 * 1. All required release artifacts exist in `dir`.
 * 2. Every entry in `SHA256SUMS` matches the file on disk.
 * 3. `manga-setup-<version>.exe.sig` is valid under the built-in Ed25519 release public key, and matches `version`, `fileName`, `size`, and `sha512`.
 */
export function verifyReleasePublishArtifacts({
  dir,
  version,
  publicKeyBase64 = BUILTIN_RELEASE_UPDATE_PUBLIC_KEY,
  targetSha,
} = {}) {
  if (!dir || !fs.existsSync(dir)) {
    throw new Error(`release directory does not exist: ${String(dir)}`);
  }
  const cleanVersion = String(version ?? "").trim().replace(/^v/, "");
  if (!/^0\.1\.\d+$/.test(cleanVersion)) {
    throw new Error(`invalid release version: ${String(version)}`);
  }

  const installerName = `manga-setup-${cleanVersion}.exe`;
  const requiredFiles = [
    installerName,
    `${installerName}.blockmap`,
    `${installerName}.sig`,
    "latest.yml",
    "RELEASE-NOTES.md",
    "SHA256SUMS",
    "release.json",
  ];
  for (const name of requiredFiles) {
    const filePath = path.join(dir, name);
    if (!fs.existsSync(filePath) || !fs.lstatSync(filePath).isFile() || fs.statSync(filePath).size <= 0) {
      throw new Error(`missing or empty release artifact: ${name}`);
    }
  }

  // Verify SHA256SUMS
  const sumsText = fs.readFileSync(path.join(dir, "SHA256SUMS"), "utf8");
  const sumLines = sumsText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const requiredHashes = requiredFiles.filter((name) => !["SHA256SUMS", "release.json"].includes(name));
  if (sumLines.length !== requiredHashes.length) throw new Error("SHA256SUMS must list every required payload exactly once");
  const verifiedFiles = [];
  const seen = new Set();
  for (const line of sumLines) {
    const match = /^([0-9a-f]{64})\s+\*?([^\s/\\]+)$/i.exec(line);
    if (!match) throw new Error(`malformed SHA256SUMS line: ${line}`);
    const [, expectedSha256, fileName] = match;
    if (!requiredHashes.includes(fileName) || seen.has(fileName)) throw new Error(`SHA256SUMS has unexpected or duplicate file: ${fileName}`);
    seen.add(fileName);
    const targetPath = path.join(dir, fileName);
    if (!fs.existsSync(targetPath)) {
      throw new Error(`file listed in SHA256SUMS is missing: ${fileName}`);
    }
    const actualSha256 = sha256HexFile(targetPath);
    if (actualSha256 !== expectedSha256.toLowerCase()) {
      throw new Error(`SHA-256 mismatch for ${fileName}: expected ${expectedSha256}, got ${actualSha256}`);
    }
    verifiedFiles.push({ fileName, sha256: actualSha256, bytes: fs.statSync(targetPath).size });
  }
  if (requiredHashes.some((name) => !seen.has(name))) throw new Error("SHA256SUMS omits a required release payload");

  // Verify detached Ed25519 signature `.sig`
  const installerPath = path.join(dir, installerName);
  const installerStat = fs.statSync(installerPath);
  const actualSha512 = sha512Base64File(installerPath);
  const sigRaw = JSON.parse(fs.readFileSync(path.join(dir, `${installerName}.sig`), "utf8"));
  const signatureFields = ["format", "algorithm", "keyId", "version", "fileName", "sha512", "size", "signedAt", "signature"];
  if (Object.keys(sigRaw).length !== signatureFields.length || signatureFields.some((name) => !(name in sigRaw))
    || !Number.isFinite(Date.parse(sigRaw.signedAt))) throw new Error("invalid signature fields");
  if (sigRaw.format !== UPDATE_SIGNATURE_FORMAT || sigRaw.algorithm !== "ed25519") {
    throw new Error("invalid signature format or algorithm");
  }
  if (sigRaw.version !== cleanVersion) {
    throw new Error(`signature version mismatch: expected ${cleanVersion}, got ${String(sigRaw.version)}`);
  }
  if (sigRaw.fileName !== installerName) {
    throw new Error(`signature fileName mismatch: expected ${installerName}, got ${String(sigRaw.fileName)}`);
  }
  if (sigRaw.size !== installerStat.size) {
    throw new Error(`signature size mismatch: expected ${installerStat.size}, got ${String(sigRaw.size)}`);
  }
  if (sigRaw.sha512 !== actualSha512) {
    throw new Error("signature sha512 mismatch against installer");
  }

  const { key, keyId } = parsePublicKeyBase64(publicKeyBase64);
  if (sigRaw.keyId !== keyId) {
    throw new Error(`signature keyId (${sigRaw.keyId}) does not match trusted public key (${keyId})`);
  }
  const message = updateSigningMessage({
    version: cleanVersion,
    fileName: installerName,
    sha512: actualSha512,
  });
  const sigBytes = Buffer.from(String(sigRaw.signature ?? ""), "base64");
  if (sigBytes.length !== 64 || !verify(null, message, key, sigBytes)) {
    throw new Error("Ed25519 signature verification failed");
  }

  // Verify the actual fields, not text occurrences in comments, notes or another file entry.
  const latestYaml = fs.readFileSync(path.join(dir, "latest.yml"), "utf8");
  const manifest = verifyReleaseManifest(latestYaml, { version: cleanVersion, installerName, sha512: actualSha512, size: installerStat.size });

  const record = JSON.parse(fs.readFileSync(path.join(dir, "release.json"), "utf8"));
  if (record.status !== "passed" || record.version !== cleanVersion || record.tag !== `v${cleanVersion}`
    || record.schemaVersion !== manifest.schemaVersion || record.at !== manifest.releaseDate
    || !/^[0-9a-f]{40}$/.test(record.targetSha ?? "") || (targetSha && targetSha !== record.targetSha)
    || !/^[0-9a-f]{64}$/.test(record.sourceFingerprint ?? "")
    || !/^[0-9a-f]{64}$/.test(record.lockFingerprint ?? "")
    || !/^[0-9a-f]{64}$/.test(record.buildScriptFingerprint ?? "")) {
    throw new Error("release.json does not match release version, target, schema or build provenance");
  }
  const expectedFiles = [...verifiedFiles, { fileName: "SHA256SUMS", sha256: sha256HexFile(path.join(dir, "SHA256SUMS")), bytes: fs.statSync(path.join(dir, "SHA256SUMS")).size }];
  const recorded = record.files;
  if (!Array.isArray(recorded) || recorded.length !== expectedFiles.length
    || new Set(recorded.map((item) => item.fileName)).size !== expectedFiles.length
    || expectedFiles.some((expected) => !recorded.some((item) => item.fileName === expected.fileName && item.sha256 === expected.sha256 && item.bytes === expected.bytes))) {
    throw new Error("release.json file inventory does not match verified payload");
  }
  if (!record.rehearsal?.ok || record.rehearsal.upgradedVersion !== cleanVersion
    || ["dataIntact", "backupCreated", "tamperedRejected", "realInstallationsUntouched"].some((name) => record.rehearsal[name] !== true)) {
    throw new Error("release.json upgrade rehearsal is missing or incomplete");
  }

  return {
    ok: true,
    version: cleanVersion,
    tag: `v${cleanVersion}`,
    installerName,
    sha512: actualSha512,
    keyId,
    files: verifiedFiles,
    targetSha: record.targetSha,
    rehearsalKind: record.rehearsal.kind,
    schemaVersion: record.schemaVersion,
  };
}

export function publishVerifiedRelease({
  dir,
  version,
  targetSha,
  publicKeyBase64 = BUILTIN_RELEASE_UPDATE_PUBLIC_KEY,
  cwd = process.cwd(),
  execFn = (cmd, args) => spawnSync(cmd, args, { cwd, encoding: "utf8", windowsHide: true }),
} = {}) {
  const verified = verifyReleasePublishArtifacts({ dir, version, publicKeyBase64, targetSha });
  if (verified.rehearsalKind !== "electron-nsis") throw new Error("a real Electron/NSIS upgrade rehearsal is required before publication");
  const tag = verified.tag;

  const tagCheck = execFn("git", ["tag", "--list", tag]);
  if (tagCheck.status !== 0) throw new Error("unable to check release tag; refusing publication");
  if (tagCheck.status === 0 && (tagCheck.stdout ?? "").split(/\r?\n/).map((s) => s.trim()).includes(tag)) {
    throw new Error(`git tag ${tag} already exists; refusing to overwrite existing release`);
  }

  const releaseCheck = execFn("gh", ["release", "view", tag]);
  if (releaseCheck.status === 0) {
    throw new Error(`GitHub Release ${tag} already exists; refusing to overwrite`);
  }
  const releaseCheckError = `${releaseCheck.stderr ?? ""}\n${releaseCheck.stdout ?? ""}`.trim();
  if (releaseCheck.status !== 1 || !/^(?:release not found|HTTP 404: Not Found(?:\s|\(|$))/im.test(releaseCheckError)) {
    throw new Error("unable to confirm GitHub Release is absent; refusing publication");
  }

  const uploadAssets = [
    path.join(dir, verified.installerName),
    path.join(dir, `${verified.installerName}.blockmap`),
    path.join(dir, `${verified.installerName}.sig`),
    path.join(dir, "latest.yml"),
    path.join(dir, "SHA256SUMS"),
    path.join(dir, "RELEASE-NOTES.md"),
    path.join(dir, "release.json"),
  ];
  const createArgs = [
    "release",
    "create",
    tag,
    ...uploadAssets,
    "--title",
    `MANGA ${tag}`,
    "--notes-file",
    path.join(dir, "RELEASE-NOTES.md"),
    "--target", verified.targetSha,
  ];
  const createRes = execFn("gh", createArgs);
  if (createRes.status !== 0) {
    throw new Error(`gh release create failed: ${(createRes.stderr || createRes.stdout || "").trim()}`);
  }
  const releaseUrl = (createRes.stdout ?? "").trim() || null;
  return {
    ...verified,
    published: true,
    releaseUrl,
  };
}

function parseArg(args, flag) {
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  const eq = args.find((a) => a.startsWith(`${flag}=`));
  return eq ? eq.slice(flag.length + 1) : null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const version = parseArg(args, "--version");
  const dir = parseArg(args, "--dir") ?? (version ? path.resolve(`dist/release/v${version.replace(/^v/, "")}`) : null);
  const targetSha = parseArg(args, "--target") ?? process.env.GITHUB_SHA ?? null;
  const shouldPublish = args.includes("--publish");

  if (!version || !dir) {
    console.error("usage: node scripts/stage/release-publish-verify.mjs --version <0.1.x> [--dir <path>] [--target <sha>] [--publish]");
    process.exit(2);
  }

  if (shouldPublish) {
    const published = publishVerifiedRelease({ dir, version, targetSha });
    console.log(JSON.stringify({ check: "release-publish", status: "passed", ...published }));
  } else {
    const verified = verifyReleasePublishArtifacts({ dir, version, targetSha });
    console.log(JSON.stringify({ check: "release-publish-verify", status: "passed", ...verified }));
  }
}
