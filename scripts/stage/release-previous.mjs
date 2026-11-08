import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { verifyReleasePublishArtifacts } from "./release-publish-verify.mjs";

async function download(rawUrl, destination, fetchFn, allowLoopbackHttp) {
  let url = new URL(rawUrl);
  for (let count = 0; count <= 10; count += 1) {
    if (url.protocol !== "https:" && !(allowLoopbackHttp && url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) {
      throw new Error("previous release download must use HTTPS");
    }
    const response = await fetchFn(url.href, { redirect: "manual", signal: AbortSignal.timeout(120_000), headers: { "User-Agent": "MANGA-release-rehearsal", "Cache-Control": "no-cache" } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("previous release redirect is missing a location");
      url = new URL(location, url); continue;
    }
    if (!response.ok) throw new Error(`previous release download failed (HTTP ${response.status})`);
    const temporary = `${destination}.part`;
    const file = fs.openSync(temporary, "w");
    let bytes = 0;
    try {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 2 * 1024 * 1024 * 1024) { await reader.cancel(); throw new Error("previous release artifact exceeds the size budget"); }
        fs.writeSync(file, value);
      }
    } finally { fs.closeSync(file); }
    if (!bytes) throw new Error("previous release artifact is empty");
    fs.renameSync(temporary, destination);
    return;
  }
  throw new Error("previous release has too many redirects");
}

/** Extract only after the original released NSIS file passed SHA256SUMS and Ed25519 verification. */
export async function extractVerifiedNsis(installer, destination) {
  const require = createRequire(import.meta.url);
  const builderRequire = createRequire(require.resolve("electron-builder"));
  // The pinned builder uses its checksum-verified toolset, not the removed 7zip-bin dependency.
  const { getPath7za } = builderRequire("app-builder-lib/out/toolsets/7zip");
  const sevenZip = await getPath7za();
  const appDir = path.join(destination, "application");
  fs.mkdirSync(appDir, { recursive: true });
  const run = (args) => {
    const result = spawnSync(sevenZip, args, { windowsHide: true, encoding: "utf8", timeout: 180_000 });
    if (result.status !== 0) throw new Error("unable to extract verified previous NSIS release");
  };
  // Current NSIS packages expose their embedded application 7z directly. Older
  // packages may expose the outer NSIS container with a separate plugin payload.
  run(["x", installer, `-o${appDir}`, "-y"]);
  if (!fs.existsSync(path.join(appDir, "resources/build.json"))) {
    const payload = path.join(appDir, "$PLUGINSDIR", "app-64.7z");
    if (!fs.existsSync(payload)) throw new Error("verified previous release has no x64 application payload");
    run(["x", payload, `-o${appDir}`, "-y"]);
  }
  return appDir;
}

/** A tag with missing or invalid artifacts never falls back to a package from the current source. */
export async function loadPreviousRelease({
  tag, destination, publicKeyBase64, fetchFn = fetch,
  baseUrl = "https://github.com/chialecode/manga/releases/download", allowLoopbackHttp = false,
  extractFn = extractVerifiedNsis, source = fetchFn === fetch ? "published-release" : "controlled-release-source",
} = {}) {
  if (!/^v0\.1\.\d+$/.test(tag ?? "")) throw new Error("invalid previous release tag");
  const version = tag.slice(1);
  const installer = `manga-setup-${version}.exe`;
  const files = ["SHA256SUMS", `${installer}.sig`, "release.json", "latest.yml", "RELEASE-NOTES.md", `${installer}.blockmap`, installer];
  const artifacts = path.join(destination, "artifacts");
  fs.mkdirSync(artifacts, { recursive: true });
  for (const name of files) await download(`${baseUrl.replace(/\/$/, "")}/${tag}/${name}`, path.join(artifacts, name), fetchFn, allowLoopbackHttp);
  const verified = verifyReleasePublishArtifacts({ dir: artifacts, version, publicKeyBase64 });
  const appDir = await extractFn(path.join(artifacts, installer), path.join(destination, "extracted"));
  const build = JSON.parse(fs.readFileSync(path.join(appDir, "resources/build.json"), "utf8"));
  if (build.version !== version || build.channel !== "release" || build.schemaVersion !== verified.schemaVersion || !fs.existsSync(path.join(appDir, "manga.exe"))) {
    throw new Error("previous release package version/channel differs from its signed manifest");
  }
  return { appDir, version, schemaVersion: build.schemaVersion, evidence: {
    kind: source, tag, version, signatureVerified: true, checksumsVerified: true, originalInstallerSha512: verified.sha512,
    targetSha: verified.targetSha, schemaVersion: build.schemaVersion, repackagedWithTestIdentity: true,
  } };
}
