import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { rawPublicKey } from "@manga/app-core";
import { runStageRelease } from "../../scripts/stage/release.mjs";
import { loadPreviousRelease } from "../../scripts/stage/release-previous.mjs";
import { publishVerifiedRelease, verifyReleasePublishArtifacts } from "../../scripts/stage/release-publish-verify.mjs";

const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const sha256 = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const targetSha = "a".repeat(40);

async function releaseFixture(options: Record<string, unknown> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "manga-release-integrity-"));
  scratch.push(root);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keyPath = path.join(root, "synthetic-update-key.pem");
  fs.writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }));
  const publicKeyBase64 = rawPublicKey(publicKey).toString("base64");
  const result = await runStageRelease({
    ci: true, version: "0.1.2", gitStatusFn: () => "", signingKeyPath: keyPath,
    gitInputs: { tags: ["v0.1.1"], commitsSinceTag: ["aaaaaaa\tfix: controlled release (#10)"], headSha: targetSha },
    publicKeys: [{ publicKey: publicKeyBase64, label: "Synthetic Release Key" }],
    releaseRootDir: path.join(root, "release"), evidenceDir: path.join(root, "evidence"),
    writeEvidenceReleaseJson: false,
    snapshotOptions: { registryEntries: [], localAppDataDir: path.join(root, "local"), roamingAppDataDir: path.join(root, "roaming"), desktopDir: path.join(root, "desktop") },
    buildReleaseInstallerFn: async ({ installerOutPath }: { installerOutPath: string }) => fs.writeFileSync(installerOutPath, Buffer.alloc(32_768, 7)),
    ...options,
  });
  return { root, dir: path.join(root, "release/v0.1.2"), publicKeyBase64, result };
}

// This is a controlled script result, used only to exercise publication order with a
// mocked command runner. It is never copied to the repository's gate evidence.
const syntheticPackagedResult = async ({ version }: { version: string }) => ({
  ok: true, kind: "electron-nsis", upgradedVersion: version, previousVersion: "0.1.1",
  dataIntact: true, backupCreated: true, tamperedRejected: true, realInstallationsUntouched: true,
});

function refreshInventory(dir: string) {
  const recordPath = path.join(dir, "release.json");
  const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  const payloads = record.files.filter((item: { fileName: string }) => item.fileName !== "SHA256SUMS");
  fs.writeFileSync(path.join(dir, "SHA256SUMS"), `${payloads.map((item: { fileName: string }) => `${sha256(path.join(dir, item.fileName))}  ${item.fileName}`).join("\n")}\n`);
  for (const item of record.files) { item.bytes = fs.statSync(path.join(dir, item.fileName)).size; item.sha256 = sha256(path.join(dir, item.fileName)); }
  fs.writeFileSync(recordPath, JSON.stringify(record));
}

describe("Release integrity review (AT-161, AT-163)", () => {
  it("rejects incomplete or duplicate checksums, misleading manifest text and mismatched release target (AT-160, AT-161)", async () => {
    const { dir, publicKeyBase64 } = await releaseFixture();
    const originals = new Map(fs.readdirSync(dir).map((name) => [name, fs.readFileSync(path.join(dir, name))]));
    const verify = () => verifyReleasePublishArtifacts({ dir, version: "0.1.2", publicKeyBase64, targetSha });
    for (const mutate of [
      () => { const file = path.join(dir, "SHA256SUMS"); fs.writeFileSync(file, fs.readFileSync(file, "utf8").split("\n").slice(1).join("\n")); },
      () => { const file = path.join(dir, "SHA256SUMS"); const lines = fs.readFileSync(file, "utf8").trim().split("\n"); lines[1] = lines[0]; fs.writeFileSync(file, lines.join("\n")); },
      () => { const file = path.join(dir, "latest.yml"); fs.appendFileSync(file, "version: 0.1.9\n"); refreshInventory(dir); },
      () => { const file = path.join(dir, "latest.yml"); fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("path: manga-setup-0.1.2.exe", "path: wrong.exe")); refreshInventory(dir); },
      () => { const file = path.join(dir, "latest.yml"); fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("files:\n", "files:\n  - url: other.exe\n")); refreshInventory(dir); },
      () => { const file = path.join(dir, "release.json"); const record = JSON.parse(fs.readFileSync(file, "utf8")); record.targetSha = "b".repeat(40); fs.writeFileSync(file, JSON.stringify(record)); },
    ]) {
      mutate();
      expect(verify).toThrow();
      for (const [name, bytes] of originals) fs.writeFileSync(path.join(dir, name), bytes);
      expect(verify().ok).toBe(true);
    }
  });

  it("writes and verifies the complete release record before any mocked publication command (AT-161, AT-163)", async () => {
    const commands: string[] = [];
    let fixtureDir = "";
    const fixture = await releaseFixture({ publish: true, runRehearsalFn: async (input: { version: string; outDir: string }) => {
      fixtureDir = input.outDir;
      return syntheticPackagedResult(input);
    }, execFn: (command: string, args: string[]) => {
      const record = JSON.parse(fs.readFileSync(path.join(fixtureDir, "release.json"), "utf8"));
      expect(record.targetSha).toBe(targetSha);
      expect(record.files).toHaveLength(6);
      commands.push(`${command} ${args.slice(0, 2).join(" ")}`);
      if (command === "gh" && args[1] === "view") return { status: 1, stderr: "release not found", stdout: "" };
      if (command === "gh" && args[1] === "create") {
        expect(args).toContain(path.join(fixtureDir, "release.json"));
        expect(args.slice(-2)).toEqual(["--target", targetSha]);
        return { status: 0, stdout: "https://example.invalid/release/v0.1.2", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    } });
    expect(fixture.result.published).toBe(true);
    expect(commands).toEqual(["git tag --list", "gh release view", "gh release create"]);
  });

  it("stops publication on authentication, network, rate-limit and tag-check failures (AT-163)", async () => {
    const { dir, publicKeyBase64 } = await releaseFixture({ runRehearsalFn: syntheticPackagedResult });
    for (const error of ["HTTP 401: Bad credentials", "HTTP 403: API rate limit exceeded", "HTTP 429: Too Many Requests", "dial tcp: connection failed"]) {
      const commands: string[] = [];
      expect(() => publishVerifiedRelease({ dir, version: "0.1.2", publicKeyBase64, targetSha, execFn: (command: string, args: string[]) => {
        commands.push(`${command} ${args[1]}`);
        return command === "git" ? { status: 0, stdout: "", stderr: "" } : { status: 1, stdout: "", stderr: error };
      } })).toThrow(/unable to confirm/);
      expect(commands).toEqual(["git --list", "gh view"]);
    }
    expect(() => publishVerifiedRelease({ dir, version: "0.1.2", publicKeyBase64, execFn: () => ({ status: 1, stdout: "", stderr: "git failed" }) })).toThrow(/unable to check release tag/);
  });

  it("verifies every previous release artifact before extraction and never falls back after a failed download (AT-161, AT-163)", async () => {
    const { root, dir, publicKeyBase64 } = await releaseFixture();
    const requested: string[] = [];
    let missing: string | null = null;
    let tamper = false;
    let extracted = 0;
    const fetchFn = async (url: string) => {
      const name = path.basename(new URL(url).pathname);
      requested.push(name);
      if (name === missing) return new Response(null, { status: 404 });
      const bytes = Buffer.from(fs.readFileSync(path.join(dir, name)));
      if (tamper && name.endsWith(".exe")) bytes[0] ^= 0xff;
      return new Response(new Uint8Array(bytes));
    };
    const extractFn = async (_installer: string, destination: string) => {
      extracted += 1;
      fs.mkdirSync(path.join(destination, "resources"), { recursive: true });
      fs.writeFileSync(path.join(destination, "manga.exe"), "synthetic extracted executable");
      fs.writeFileSync(path.join(destination, "resources/build.json"), JSON.stringify({ version: "0.1.2", channel: "release", schemaVersion: 14 }));
      return destination;
    };
    const load = (name: string) => loadPreviousRelease({ tag: "v0.1.2", destination: path.join(root, name), publicKeyBase64, fetchFn, extractFn });
    const previous = await load("verified");
    expect(previous.evidence.kind).toBe("controlled-release-source");
    expect(previous.evidence.signatureVerified).toBe(true);
    expect(new Set(requested).size).toBe(7);
    expect(extracted).toBe(1);
    missing = "manga-setup-0.1.2.exe.sig";
    await expect(load("missing")).rejects.toThrow(/HTTP 404/);
    missing = null; tamper = true;
    await expect(load("tampered")).rejects.toThrow(/SHA-256 mismatch/);
    expect(extracted).toBe(1);
    let redirects = 0;
    await expect(loadPreviousRelease({ tag: "v0.1.2", destination: path.join(root, "redirect"), publicKeyBase64,
      fetchFn: async () => { redirects += 1; return new Response(null, { status: 302, headers: { location: "http://192.0.2.1/artifact" } }); }, extractFn,
    })).rejects.toThrow(/must use HTTPS/);
    expect(redirects).toBe(1);
    expect(extracted).toBe(1);
  });
});
