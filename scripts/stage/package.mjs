import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { startSwarm } from "../../tests/helpers/bt-swarm.ts";
import { FakeDandan } from "../../tests/helpers/fake-dandan.ts";
import { seedV11 } from "../../tests/helpers/legacy-v11.ts";
import { seedV12 } from "../../tests/helpers/legacy-v12.ts";
import { startFakeBangumi } from "../../tests/helpers/fake-bangumi.ts";
import { LEGACY_CREDENTIALS } from "../../tests/helpers/legacy-credentials.ts";
import { startMockProvider } from "../../packages/model-protocol/src/index.ts";
import { frozenImageHashes } from "../../packages/storage-drizzle/src/migrate-agent-media.ts";
import { PRODUCT_SCHEMA_VERSION } from "../../packages/storage-drizzle/src/sql.ts";
import Database from "better-sqlite3";
import sharp from "sharp";
import * as resedit from "resedit";
import { MangaProductApp, TestVault, pngSize } from "../../packages/app-core/src/index.ts";
import { desktopPackageDir, latestDesktopPackage, pluginSigningKeyFile } from "../desktop-paths.ts";
import { validateWorkflows } from "../check-workflows.mjs";
import {
  CHANNEL_INSTALL,
  DEFAULT_ICON_ICO,
  DEFAULT_ICON_PNG,
  DEFAULT_ICON_SVG,
  ICON_SIZES,
  INSTALLER_META,
  TEST_CHANNEL_INSTALL,
  buildInstaller,
  checkInstallerConfig,
  compareRealInstallations,
  installerConfig,
  installerInclude,
  inspectIco,
  removeTestInstallations, snapshotRealInstallations,
} from "./installer-lib.mjs";
import { runInstallDev } from "./install-dev.mjs";
import { decideWeeklyRelease } from "./release-decide.mjs";
import { runStageRelease } from "./release.mjs";
import { rawPublicKey, writeBuildInfo } from "./version-lib.mjs";
import { watchGateTemp } from "./temp-dirs.mjs";
import { checkLightBoundary, observeLightUpdate, observeLightOpen } from "./light-open.mjs";
import { currentStage, fingerprintKeysOf, loadGate, optionalSamplesMissing, packagedFingerprintKeys, readJson as readEvidence, repoRoot as root, runDir, stageFingerprints } from "./lib.mjs";
import { loadManifest } from "../samples/media-manifest.mjs";

const stage = currentStage();
const config = loadGate();
// Taken before anything is built: an edit made while the run goes on leaves its results stale instead of passing them off as the edited state's.
const fingerprints = stageFingerprints(root, config);
if (process.platform !== "win32") throw new Error("package verification targets Windows x64");
const sqlite = spawnSync(process.execPath, ["scripts/verify-electron-sqlite.mjs"], { cwd: root, stdio: "inherit" });
if (sqlite.status !== 0) process.exit(sqlite.status ?? 1);
// Iterating on one walk: MANGA_PACKAGE_PHASES=window-walk,workspace-restart runs only those phases (in the order of the gate) and writes no evidence;
// MANGA_PACKAGE_REUSE_BUILD=1 also skips building the package again when nothing under src changed. Neither is used for the gate's run.
const onlyPhases = process.env.MANGA_PACKAGE_PHASES ? process.env.MANGA_PACKAGE_PHASES.split(",").map((name) => name.trim()).filter(Boolean) : null;
// LOOP-27: the gate asks for consecutive full passes on the same inputs. A full run counts on from the result before it when that one passed on the
// same inputs, and removes it first, so a run that fails leaves no result and the count starts again.
let passStreak = 1;
if (!onlyPhases) {
  const before = readEvidence(runDir(), "package.json");
  if (before?.status === "passed" && fingerprintKeysOf(config, "package.json").every((key) => before[key] === fingerprints[key])) passStreak = (before.passStreak ?? 1) + 1;
  for (const name of ["package.json", "scenarios.json"]) fs.rmSync(path.join(runDir(), name), { force: true });
}
const outDir = desktopPackageDir;
let smokePluginPublicKey = process.env.MANGA_SMOKE_PLUGIN_PUBLIC_KEY?.trim() || "";
const ephemeralPluginKey = process.env.MANGA_BUILD_CHANNEL !== "release"
  && !process.env.MANGA_PLUGIN_SIGNING_KEY
  && !fs.existsSync(pluginSigningKeyFile);
// The gate's second and third runs (and a run again after a failure that changed nothing) package exactly the inputs the run before did. The build
// stamp written after a build names those inputs (every fingerprint that goes into the package, the build's environment and the plugin signing key)
// and the digest of every file of the packaged directory; when all of them are unchanged the directory is the build this run would make, and it is
// used as it is. A key made for one run cannot be made again, so a build signed with one is never reused.
const buildStamp = path.join(outDir, "build-stamp.json");
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const buildEnvDigest = () => {
  const keyFile = process.env.MANGA_PLUGIN_SIGNING_KEY || pluginSigningKeyFile;
  const envLocal = path.join(root, ".env.local");
  return sha256(JSON.stringify({
    env: Object.entries(process.env).filter(([name]) => name.startsWith("MANGA_") && !name.startsWith("MANGA_PACKAGE_")).sort(([a], [b]) => a.localeCompare(b)),
    envLocal: fs.existsSync(envLocal) ? sha256(fs.readFileSync(envLocal)) : null,
    pluginKey: fs.existsSync(keyFile) ? sha256(fs.readFileSync(keyFile)) : null,
  }));
};
const directoryDigest = (dir) => {
  const hash = crypto.createHash("sha256");
  const visit = (relative) => {
    const file = path.join(dir, relative);
    if (fs.statSync(file).isDirectory()) { for (const name of fs.readdirSync(file).sort()) visit(path.join(relative, name)); return; }
    hash.update(relative.replaceAll("\\", "/"));
    hash.update(fs.readFileSync(file));
  };
  visit("");
  return hash.digest("hex");
};
const packagedApp = () => {
  const name = fs.existsSync(outDir) ? fs.readdirSync(outDir).find((entry) => entry.startsWith("manga")) : undefined;
  return name ? path.join(outDir, name) : null;
};
const reuseBuild = (() => {
  if (onlyPhases || ephemeralPluginKey) return false;
  const stamp = readEvidence(outDir, "build-stamp.json");
  const app = packagedApp();
  return Boolean(stamp && app && packagedFingerprintKeys(config).every((key) => stamp[key] === fingerprints[key])
    && stamp.buildEnv === buildEnvDigest() && stamp.appDigest === directoryDigest(app));
})();
if (reuseBuild) console.log("[package] the packaged directory was built from these inputs and is unchanged: used as it is");
if (!reuseBuild && (process.env.MANGA_PACKAGE_REUSE_BUILD !== "1" || !onlyPhases)) {
  fs.rmSync(buildStamp, { force: true });
  if (fs.existsSync(outDir)) {
    for (const entry of fs.readdirSync(outDir)) if (entry.toLowerCase().startsWith("manga")) fs.rmSync(path.join(outDir, entry), { recursive: true, force: true });
  }
  const forgeEnv = { ...process.env };
  let ephemeralKeyDir = null;
  if (ephemeralPluginKey) {
    ephemeralKeyDir = fs.mkdtempSync(path.join(os.tmpdir(), "manga-smoke-key-"));
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const keyFile = path.join(ephemeralKeyDir, "plugin-smoke.pem");
    fs.writeFileSync(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }).toString(), "utf8");
    forgeEnv.MANGA_PLUGIN_SIGNING_KEY = keyFile;
    smokePluginPublicKey = rawPublicKey(publicKey).toString("base64");
  }
  try {
    const pnpm = spawnSync("pnpm", ["exec", "electron-forge", "package", "--platform", "win32", "--arch", "x64"], {
      cwd: path.join(root, "apps/desktop"),
      stdio: "inherit",
      shell: true,
      env: forgeEnv,
    });
    if (pnpm.status !== 0) process.exit(pnpm.status ?? 1);
  } finally {
    if (ephemeralKeyDir) fs.rmSync(ephemeralKeyDir, { recursive: true, force: true });
  }
  const app = packagedApp();
  if (app && !ephemeralPluginKey) {
    const stamped = Object.fromEntries(packagedFingerprintKeys(config).map((key) => [key, fingerprints[key]]));
    fs.writeFileSync(buildStamp, `${JSON.stringify({ ...stamped, buildEnv: buildEnvDigest(), appDigest: directoryDigest(app) }, null, 2)}\n`);
  }
}
const appPath = packagedApp();
if (!appPath) throw new Error("electron-forge package output missing");
// The digest of the directory as this run starts on it: the installer the run before made is reused only for this same directory (below).
const appDigestAtStart = readEvidence(outDir, "build-stamp.json")?.appDigest ?? null;
const evidence = runDir();
// What this run makes in the system's temporary folder is removed when it passes and kept, by name in the log, when it fails (LOOP-26).
const tempWatch = watchGateTemp("stage-package");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "manga-package-"));
const selectedPhases = onlyPhases ? config.package.smoke.filter((name) => onlyPhases.includes(name)) : config.package.smoke;
// The window walk starts from an empty library (the app must open on the library paths), so it gets a Profile of its own; the creative walk and
// the plugin walk make their own projects, library path and plugin, and do not share a Profile with the phases before them.
const OWN_PROFILE = new Set(["window-walk", "creative", "plugins", "trace", "workspace-migrated", "loop", "credentials-async", "migrate-v13", "update"]);
// The restart of the workspace is the next start of the Profile the window walk used (it left two contexts in a known shape); the upgrade check starts on a
// synthetic v11 library made here, before the application has seen it.
const SAME_PROFILE_AS = { "workspace-restart": "window-walk", "workspace-closed": "window-walk", "credentials-async-restart": "credentials-async", "migrate-v13-restart": "migrate-v13" };
// The Profile an Electron 44 build saved three credentials into (计划 4.1), made by node scripts/samples/build-legacy-credentials.mjs.
const legacyCredentials = path.join(root, "dist/samples/legacy-e44-credentials");
// The model key this build saves in the credentials phase, opened again after the restart.
const RENEWED_MODEL_KEY = "saved-by-e45-synthetic-model-key";
const v12Seeds = {};
const homes = {};
// The media and recording phases drive the real window with synthetic samples; they have to exist for the gate to mean anything.
const samplesRoot = path.join(root, "dist/samples/media");
const speechClip = path.join(samplesRoot, "voice/tts-clips/zh-CN-1.wav");
// The release workflow's check (`--ci`): a phase gate.json `optionalSamplePhases` ties to optional samples this runner could not make is left out
// and named with the reason in package.json; any other phase still has to pass. Stage evidence never passes `--ci`.
const ciRun = process.argv.includes("--ci");
const sampleManifest = loadManifest(samplesRoot);
const excusedPhases = selectedPhases
  .filter((phase) => ciRun && optionalSamplesMissing(config.optionalSamplePhases?.[phase], sampleManifest))
  .map((phase) => ({ phase, reason: `optional samples not generated on this machine: ${config.optionalSamplePhases[phase].join(", ")}` }));
const phases = selectedPhases.filter((phase) => !excusedPhases.some((entry) => entry.phase === phase));
for (const entry of excusedPhases) console.log(JSON.stringify({ check: "stage-package", excused: entry.phase, reason: entry.reason }));
for (const phase of phases) {
  if (phase === "credentials-async" && !fs.existsSync(path.join(legacyCredentials, "legacy.json"))) throw new Error("the legacy credentials Profile is missing; run: node --experimental-strip-types scripts/samples/build-legacy-credentials.mjs");
  if ((phase === "media" || phase === "voice" || phase === "window-walk" || phase === "creative" || phase === "loop") && !fs.existsSync(path.join(samplesRoot, "manifest.json"))) throw new Error("synthetic samples are missing; run: node scripts/samples/generate-media-samples.mjs");
}
if (phases.includes("voice") && !fs.existsSync(speechClip)) throw new Error("the synthetic speech clip is missing; run: node scripts/samples/generate-media-samples.mjs");
const electronVersion = fs.readFileSync(path.join(appPath, "version"), "utf8").trim();
// The plugin walk downloads from a seed and a tracker on the loopback address, run here in a process of their own; the tracker's address in the
// magnet carries a made-up secret that must never reach the page or the logs. Nothing reaches a public tracker, the DHT or the LAN.
async function prepareBt(home) {
  const swarm = await startSwarm();
  const chapter = (title) => `${title}

${"这是用于 BitTorrent 下载测试的一段合成文字。".repeat(300)}
`;
  const secret = `S${crypto.randomBytes(9).toString("hex")}`;
  const seeded = await swarm.seed({ id: "window", root: path.join(home, "seed"), name: "季卷", files: [{ path: "第1话.txt", text: chapter("第一话") }, { path: "第2话.txt", text: chapter("第二话") }, { path: "第3话.txt", text: chapter("第三话") }], pieceLength: 16 * 1024 });
  const magnet = `magnet:?xt=urn:btih:${seeded.infoHash}&dn=${encodeURIComponent("季卷")}&tr=${encodeURIComponent(`${swarm.announce}?passkey=${secret}`)}`;
  const specFile = path.join(home, "bt-spec.json");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(specFile, JSON.stringify({ magnet, secret, libraryDir: path.join(home, "downloads"), subdir: "下载", files: seeded.files }));
  return { swarm, env: { MANGA_SMOKE_BT_SPEC: specFile, MANGA_SMOKE_BT_LOOPBACK: "1" } };
}
// The window walk's fake service answers from this process, so the application runs without blocking it.
function spawnAsync(command, args, options) {
  return new Promise((resolve) => {
    const env = { ...options.env };
    // A terminal may use Electron as a Node runner; the packaged window must start Electron normally.
    for (const name of Object.keys(env)) if (name.toUpperCase() === "ELECTRON_RUN_AS_NODE") delete env[name];
    const child = spawn(command, args, { cwd: options.cwd, env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill(), options.timeout);
    child.on("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    child.on("error", () => { clearTimeout(timer); resolve({ status: null, stdout, stderr }); });
  });
}
// What the stand-in service saw during the window walk: everything signed with the smoke credentials, nothing about the file sent after the answer "no",
// the search and the chosen episode's comments fetched, and no local path anywhere in what was asked.
function dandanTraffic(fake) {
  const problems = [];
  const all = fake.requests;
  if (all.length === 0) problems.push("the application never reached the service");
  if (all.some((request) => !request.signed)) problems.push("a request was not signed with the credentials of a smoke run");
  if (fake.hits("/api/v2/match").length > 0) problems.push("the file's details were sent although the answer was no");
  if (fake.hits("/api/v2/search/episodes").length === 0) problems.push("the search never reached the service");
  if (fake.hits(/^\/api\/v2\/comment\/900102$/).length === 0) problems.push("the comments of the chosen episode were not fetched");
  const text = (request) => { try { return decodeURIComponent(`${request.path}?${request.query.toString()}`) + request.body; } catch { return request.path + request.body; } };
  if (all.some((request) => /(^|[^A-Za-z])[A-Za-z]:[\\/]/.test(text(request)))) problems.push("a request carried a local path");
  if (all.some((request) => request.body !== "")) problems.push("a request carried a body");
  return { status: problems.length === 0 ? "passed" : "failed", detail: { requests: all.length, paths: [...new Set(all.map((request) => request.path))], problems } };
}
// The stand-ins the legacy credentials are checked against: one model that takes only the legacy key, one that takes only the key saved now, the
// DanDanPlay service accepting only the legacy credentials, and Bangumi recording the token it is sent.
async function startCredentialServices() {
  const legacy = await startMockProvider({ expectKey: LEGACY_CREDENTIALS.modelKey });
  const renewed = await startMockProvider({ expectKey: RENEWED_MODEL_KEY });
  const dandan = await new FakeDandan().start();
  dandan.accepts = { ...LEGACY_CREDENTIALS.dandan };
  const bangumi = await startFakeBangumi();
  return {
    dandan, bangumi,
    env: { MANGA_SMOKE_MODEL_ORIGIN: legacy.url, MANGA_SMOKE_MODEL_ORIGIN_RENEWED: renewed.url, MANGA_SMOKE_BANGUMI_ORIGIN: bangumi.origin },
    stop: async () => { await legacy.close(); await renewed.close(); await bangumi.stop(); },
  };
}
function credentialTraffic(services, phase) {
  const problems = [];
  const signed = services.dandan.requests;
  if (signed.length === 0) problems.push("the DanDanPlay stand-in was never asked");
  if (signed.some((request) => !request.signed)) problems.push("a DanDanPlay request was not signed with the legacy credentials");
  const api = services.bangumi.requests.filter((request) => request.path.startsWith("/v0/"));
  if (phase === "credentials-async") {
    if (api.length === 0) problems.push("the Bangumi stand-in was never asked");
    if (api.some((request) => request.headers.authorization !== `Bearer ${LEGACY_CREDENTIALS.bangumiToken}`)) problems.push("a Bangumi request did not carry the legacy token");
  }
  return { status: problems.length === 0 ? "passed" : "failed", detail: { dandan: signed.length, bangumi: api.length, problems } };
}
// A synthetic v12 library (计划 4.4): 300 runs with their pictures inline, one real JPEG shared by every third run; its runs dated yesterday so the
// retention clean-up of this start leaves them alone. What was seeded is written for the walk; the size and hashes stay here for the checks after it.
async function seedMigration(home) {
  const bytes = await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 70, g: 110, b: 150 } } }).jpeg({ quality: 80 }).toBuffer();
  const seeded = seedV12({ root: path.join(home, "root"), runs: 300, image: { bytes, mediaType: "image/jpeg", width: 640, height: 480, origin: { kind: "video_frame", resourceId: "res-v12", resourceRevisionId: "rev-v12", timeMs: 4000 } } });
  const db = new Database(path.join(seeded.data, "manga.sqlite"));
  const yesterday = new Date(Date.now() - 86_400_000).toISOString();
  db.prepare("UPDATE agent_runs SET created_at = ?, updated_at = ?").run(yesterday, yesterday);
  db.prepare("UPDATE agent_sessions SET created_at = ?, updated_at = ?").run(yesterday, yesterday);
  db.close();
  const shared = crypto.createHash("sha256").update(bytes).digest("hex");
  fs.writeFileSync(path.join(home, "v12-spec.json"), JSON.stringify({ hashes: seeded.hashes, shared }));
  return { data: seeded.data, hashes: seeded.hashes, images: seeded.images, unique: seeded.unique, bytesBefore: fs.statSync(path.join(seeded.data, "manga.sqlite")).size };
}
// The backup the move left is the v12 library as it was, with every picture inline; the sizes before and after go into the evidence.
function migrationFiles(seed) {
  const backup = path.join(seed.data, "manga.sqlite.premigrate-v12");
  const out = { backup: fs.existsSync(backup), backupHashesEqual: false, bytesBefore: seed.bytesBefore, bytesAfter: fs.statSync(path.join(seed.data, "manga.sqlite")).size, images: seed.images, unique: seed.unique };
  if (out.backup) {
    const old = new Database(backup, { readonly: true, fileMustExist: true });
    try { out.backupHashesEqual = JSON.stringify(frozenImageHashes(old)) === JSON.stringify(seed.hashes); } finally { old.close(); }
    for (const suffix of ["-wal", "-shm"]) fs.rmSync(`${backup}${suffix}`, { force: true });
  }
  if (!out.backup || !out.backupHashesEqual) throw new Error(`the v13 move left no faithful backup: ${JSON.stringify(out)}`);
  return out;
}
async function smoke(phase) {
  const sameAs = SAME_PROFILE_AS[phase];
  if (sameAs && !homes[sameAs]) throw new Error(`smoke ${phase} needs the Profile of ${sameAs}, which was not a phase of this run`);
  const home = sameAs ? homes[sameAs] : OWN_PROFILE.has(phase) ? fs.mkdtempSync(path.join(os.tmpdir(), `manga-package-${phase}-`)) : profile;
  homes[phase] = home;
  if (phase === "workspace-migrated") seedV11(path.join(home, "root"));
  if (phase === "credentials-async") {
    // A copy of the legacy Profile (the browser runtime's Local State holds the key its ciphertexts depend on), its pointer naming the copy.
    fs.cpSync(path.join(legacyCredentials, "root"), path.join(home, "root"), { recursive: true });
    fs.mkdirSync(path.join(home, "launcher"), { recursive: true });
    fs.writeFileSync(path.join(home, "launcher", "pointer.json"), JSON.stringify({ profileRoot: path.join(home, "root"), channel: "test", revision: 1 }));
  }
  if (phase === "migrate-v13") v12Seeds[phase] = await seedMigration(home);
  const credentialServices = phase.startsWith("credentials-async") ? await startCredentialServices() : null;
  const bt = phase === "plugins" ? await prepareBt(home) : null;
  // The window walk's danmaku step talks to a stand-in for the DanDanPlay service on the loopback address; it accepts only the credentials a smoke run uses.
  const dandan = phase === "window-walk" ? await new FakeDandan().start() : credentialServices?.dandan ?? null;
  if (phase === "window-walk") dandan.accepts = { appId: "smokeapp01", secret: "smoke-secret-for-the-local-fake-server" };
  let result;
  let traffic = null;
  try {
    result = await spawnAsync(path.join(appPath, "manga.exe"), ["--manga-smoke"], {
      cwd: home,
      env: {
        ...process.env,
        MANGA_CHANNEL: "test",
        MANGA_PROFILE_ROOT: path.join(home, "root"),
        MANGA_DOCUMENTS_DIR: path.join(home, "documents"),
        MANGA_POINTER_FILE: path.join(home, "launcher", "pointer.json"),
        MANGA_SMOKE_PHASE: phase,
        MANGA_SMOKE_EVIDENCE_DIR: evidence,
        MANGA_SMOKE_SAMPLES: samplesRoot,
        MANGA_SMOKE_AUDIO: speechClip,
        ELECTRON_ENABLE_LOGGING: "1",
        ...(smokePluginPublicKey ? { MANGA_SMOKE_PLUGIN_PUBLIC_KEY: smokePluginPublicKey } : {}),
        ...(bt?.env ?? {}),
        ...(dandan ? { MANGA_SMOKE_DANDAN_ORIGIN: dandan.origin } : {}),
        ...(credentialServices?.env ?? {}),
        ...(phase.startsWith("migrate-v13") ? { MANGA_SMOKE_V12_SPEC: path.join(home, "v12-spec.json") } : {}),
      },
      timeout: phase === "loop" ? 900_000 : phase === "update" ? 240_000 : phase.startsWith("credentials-async") || phase.startsWith("migrate-v13") ? 180_000 : phase.startsWith("agent") ? 90_000 : phase === "media" ? 600_000 : phase === "voice" ? 240_000 : phase === "window-walk" ? 900_000 : phase === "creative" ? 300_000 : phase === "workspace-restart" || phase === "workspace-closed" || phase === "workspace-migrated" ? 120_000 : phase === "plugins" ? 420_000 : phase === "reading-loop" || phase === "reading-loop-restart" || phase === "formats" || phase === "trace" ? 120_000 : 60_000,
    });
  } finally {
    await bt?.swarm.close();
    if (dandan && phase === "window-walk") traffic = dandanTraffic(dandan);
    if (credentialServices) traffic = credentialTraffic(credentialServices, phase);
    await dandan?.stop();
    await credentialServices?.stop();
  }
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
  const smokeLog = path.join(home, "root", "logs", `smoke-${phase}.json`);
  if (fs.existsSync(smokeLog)) process.stdout.write(`${fs.readFileSync(smokeLog, "utf8")}\n`);
  if (result.status !== 0) throw new Error(`smoke ${phase} failed status=${result.status}`);
  const report = fs.existsSync(smokeLog) ? JSON.parse(fs.readFileSync(smokeLog, "utf8")) : undefined;
  if (!report || report.status !== "passed") throw new Error(`smoke ${phase} did not report passed`);
  if (traffic && phase === "window-walk") report.danmakuNetwork = traffic;
  if (traffic && credentialServices) {
    report.credentialNetwork = traffic;
    if (traffic.status !== "passed") throw new Error(`smoke ${phase}: ${traffic.detail.problems.join("; ")}`);
  }
  if (phase === "migrate-v13" || phase === "migrate-v13-restart") report.migrationFiles = migrationFiles(v12Seeds["migrate-v13"]);
  if (phase === "loop" || phase === "update" || phase.startsWith("credentials-async") || phase.startsWith("migrate-v13")) {
    if (report.notRun) throw new Error(`${phase} smoke did not run`);
    if (report.ok !== true) throw new Error(`${phase} smoke failed: ${(report.observations ?? []).filter((row) => row.status !== "passed").map((row) => row.name).join(", ")}`);
  }
  if (phase === "restart" && report.markerRestored !== true) throw new Error("restart did not restore the marker note");
  if (phase === "agent") {
    if (report.revoked !== true) throw new Error("agent smoke did not revoke the module");
    if (report.runningShown !== true || report.stoppedShown !== true) throw new Error("agent smoke did not show the stop control while the run was going and send again after it");
  }
  if (phase === "agent-restart") {
    if (!String(report.inputText ?? "").includes("slow-smoke-prompt")) throw new Error("agent restart did not restore the prompt");
    if (report.conversationShown !== true) throw new Error("agent restart did not show the conversation that was left");
  }
  if (phase === "reading" && report.readingNav !== true) throw new Error("reading smoke did not open the reading page");
  if (phase === "reading-loop") {
    if (report.readLastChapter !== true) throw new Error("reading-loop smoke did not read the last chapter");
    if (report.recordedNote !== true) throw new Error("reading-loop smoke did not record a note from the selection");
    if (report.selectionAccurate !== true) throw new Error("reading-loop smoke recorded a range that is not the selection");
    if (report.materialsFrozen !== true || report.materialsFromUi !== true) throw new Error("reading-loop smoke did not freeze the task materials from the composer");
    if (report.uiTailVisible !== true || report.progressAtTail !== true || report.progressStillAtTail !== true) throw new Error("reading-loop smoke did not read the tail in the window and keep that position");
    if (report.sourceCardOk !== true) throw new Error("reading-loop smoke did not open a source card from the note");
    if (report.styleReachable !== true || report.theme !== "green") throw new Error("reading-loop smoke did not apply the reader style");
    if (report.bookmarkHighlighted !== true) throw new Error("reading-loop smoke did not highlight a bookmark range");
    if (report.bookmarkRemoved !== true) throw new Error("reading-loop smoke did not remove a bookmark");
  }
  if (phase === "media") {
    if (report.notRun) throw new Error("media smoke did not run");
    if (!Array.isArray(report.steps) || report.steps.length < 10) throw new Error("media smoke covered too few samples");
    if (report.ok !== true) throw new Error(`media smoke steps failed: ${(report.failed ?? []).join(", ")}`);
    // AT-84: the picture of a video whose fonts nobody has shows letters, and the debug panel says how the picture is made.
    // AT-89: the episode and audio menus, which the window walk's single file does not have, are hit-tested in the window and in screen full screen.
    const ran = new Set(report.steps.filter((step) => step.ok && !step.detail?.skipped).map((step) => step.id));
    // AT-109: a screenshot carries the subtitles on the picture (an ASS subtitle at the size of the file, and text subtitles) and not when the setting is off.
    for (const id of ["picture:missing-font-glyphs", "picture:debug-facts", "subtitles:menus-hit-testable", "menus:episodes-audio", "subtitles:shot-text", "subtitles:shot-setting-off", "picture:shot-ass-subtitles"]) if (!ran.has(id)) throw new Error(`media smoke did not run ${id}`);
  }
  if (phase === "voice") {
    if (report.notRun) throw new Error("voice smoke did not run");
    if (report.ok !== true) throw new Error(`voice smoke steps failed: ${(report.failed ?? []).join(", ")}`);
  }
  if (phase === "formats") {
    if (report.pages !== true || report.contexts !== true || report.failureVisible !== true) throw new Error("formats smoke did not show four format pages, the switch of context and the failed import");
    // LOOP-06: the PDF page is painted once at its opening width and not again once the width has held still; the selection survives.
    const loop = report.loop06 ?? {};
    if (loop.settled?.stable !== true || loop.tagged !== true || loop.repainted !== false || loop.atEnd?.nodeConnected !== true) throw new Error(`formats smoke lost the PDF selection to a repaint: ${JSON.stringify(loop)}`);
  }
  if (phase === "window-walk") {
    if (report.notRun) throw new Error("window-walk smoke did not run");
    if (report.ok !== true) throw new Error(`window-walk smoke failed: ${(report.failed ?? []).concat(report.missing ?? []).join(", ")}`);
  }
  if (phase === "workspace-restart" || phase === "workspace-closed" || phase === "workspace-migrated") {
    if (report.notRun) throw new Error(`${phase} smoke did not run`);
    if (report.ok !== true) throw new Error(`${phase} smoke failed: ${(report.observations ?? []).filter((row) => row.status !== "passed").map((row) => row.name).join(", ")}`);
  }
  if (phase === "creative") {
    if (report.notRun) throw new Error("creative smoke did not run");
    if (report.ok !== true) throw new Error(`creative smoke failed: ${(report.failed ?? []).join(", ")}`);
  }
  if (phase === "trace") {
    if (report.notRun) throw new Error("trace smoke did not run");
    if (report.ok !== true) throw new Error(`trace smoke failed: ${(report.failed ?? []).join(", ")}`);
  }
  if (phase === "plugins") {
    if (report.notRun) throw new Error("plugins smoke did not run");
    if (report.ok !== true) throw new Error(`plugins smoke steps failed: ${(report.failed ?? []).join(", ")}`);
  }
  if (phase === "reading-loop-restart") {
    if (report.restoredNote !== true || report.restoredResource !== true) throw new Error("reading-loop restart did not restore the note and resource");
    if (report.restoredProgress !== true || report.uiRestoredTail !== true) throw new Error("reading-loop restart did not restore the reading position in the window");
    if (report.restoredSource !== true) throw new Error("reading-loop restart lost the note's source link");
    if (report.restoredMaterials !== true) throw new Error("reading-loop restart lost the frozen task materials");
  }
  return report;
}
// Starts of the packaged application that the harness drives from outside: on a library newer than this build, and with the system folders of a
// machine replaced by temporary ones (计划 4.9, 4.10). The packaged build is started with the variables a person's machine would give it.
function packagedEnv(extra) {
  const env = { ...process.env, ELECTRON_ENABLE_LOGGING: "1", ...extra };
  for (const name of Object.keys(env)) if (name.toUpperCase() === "ELECTRON_RUN_AS_NODE") delete env[name];
  for (const name of ["MANGA_PROFILE_ROOT", "MANGA_POINTER_FILE", "MANGA_DOCUMENTS_DIR", "MANGA_DOWNLOADS_DIR", "MANGA_UPGRADE_CRASH_AT", "MANGA_SMOKE_EVIDENCE_DIR"]) if (!(name in extra)) delete env[name];
  for (const name of Object.keys(env)) if (name.startsWith("MANGA_DIR_")) delete env[name];
  return env;
}
const launch = (cwd, env, timeout = 180_000) => spawnAsync(path.join(appPath, "manga.exe"), ["--manga-smoke"], { cwd, env, timeout });
const readJson = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null);
const under = (child, parent) => { const rel = path.relative(parent, child); return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)); };
const filesIn = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String).filter((name) => fs.statSync(path.join(dir, name)).isFile()) : []);

// AT-145: a build older than the library refuses to open it (the library of the migration phase, its version raised past this build's).
async function migrateNewer() {
  const home = homes["migrate-v13"];
  if (!home) throw new Error("migrate-v13-newer needs the Profile of migrate-v13");
  const newerVersion = String(PRODUCT_SCHEMA_VERSION + 1);
  const file = path.join(home, "root", "data", "manga.sqlite");
  const db = new Database(file);
  db.prepare("UPDATE schema_meta SET value = ? WHERE key = 'schemaVersion'").run(newerVersion);
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();
  const result = await launch(home, packagedEnv({ MANGA_CHANNEL: "test", MANGA_PROFILE_ROOT: path.join(home, "root"), MANGA_POINTER_FILE: path.join(home, "launcher", "pointer.json"), MANGA_DOCUMENTS_DIR: path.join(home, "documents"), MANGA_SMOKE_PHASE: "migrate-v13-newer" }), 90_000);
  const report = readJson(path.join(home, "root", "logs", "smoke-migrate-v13-newer.json")) ?? {};
  const after = new Database(file, { readonly: true });
  const version = after.prepare("SELECT value FROM schema_meta WHERE key = 'schemaVersion'").get()?.value;
  after.close();
  const refused = result.status !== 0 && /newer than this application/.test(String(report.error ?? "")) && version === newerVersion;
  const observation = { name: "migrate-v13-newer", status: refused ? "passed" : "failed", detail: { exitStatus: result.status, refused, versionAfter: version } };
  if (!refused) throw new Error(`a library newer than the build was not refused: ${JSON.stringify(observation.detail)}`);
  return { ok: true, observations: [observation] };
}

/** A temporary machine: LocalAppData, the roaming profile, the home folder, Documents and Downloads. The release one sits on a drive root so its screenshot names no account. */
function tempMachine(name, onDriveRoot) {
  let base;
  if (onDriveRoot) {
    try { base = fs.mkdtempSync(path.join(path.parse(os.tmpdir()).root, `manga-gate-`)); } catch { base = undefined; }
  }
  base ??= fs.mkdtempSync(path.join(os.tmpdir(), `manga-package-${name}-`));
  const machine = { base, local: path.join(base, "AppData", "Local"), roaming: path.join(base, "AppData", "Roaming"), home: path.join(base, "home"), documents: path.join(base, "Docs"), downloads: path.join(base, "Downloads"), onDriveRoot: Boolean(onDriveRoot && !under(base, os.tmpdir())) };
  for (const dir of [machine.local, machine.roaming, machine.home, machine.documents, machine.downloads]) fs.mkdirSync(dir, { recursive: true });
  return machine;
}
const machineEnv = (machine, channel, extra = {}) => packagedEnv({ MANGA_CHANNEL: channel, LOCALAPPDATA: machine.local, APPDATA: machine.roaming, USERPROFILE: machine.home, HOME: machine.home, MANGA_DOCUMENTS_DIR: machine.documents, MANGA_DOWNLOADS_DIR: machine.downloads, MANGA_SMOKE_SAMPLES: samplesRoot, ...extra });

// AT-148: a fresh release and a fresh development build put the application's data under LocalAppData, the person's files under Documents and downloads under Downloads.
async function dataLocationsFresh() {
  const observations = [];
  for (const channel of ["release", "development"]) {
    const machine = tempMachine(`fresh-${channel}`, channel === "release");
    try {
      const shot = channel === "release" && machine.onDriveRoot;
      const result = await launch(machine.base, machineEnv(machine, channel, { MANGA_SMOKE_PHASE: "locations", ...(shot ? { MANGA_SMOKE_EVIDENCE_DIR: evidence, MANGA_SMOKE_LOCATIONS_SHOT: "1" } : {}) }));
      const appRoot = path.join(machine.local, channel === "release" ? "manga" : "manga-dev");
      const files = path.join(machine.documents, channel === "release" ? "manga" : "manga-dev");
      const downloads = path.join(machine.downloads, channel === "release" ? "manga" : "manga-dev");
      const report = readJson(path.join(appRoot, "logs", "smoke-locations.json")) ?? {};
      const parts = report.locations?.partitions ?? {};
      const problems = [];
      if (result.status !== 0 || report.status !== "passed") problems.push(`the start did not pass (status ${result.status})`);
      for (const name of ["data", "cache", "logs", "backups", "runtime"]) if (!parts[name] || !under(parts[name], appRoot)) problems.push(`${name} is not under LocalAppData`);
      for (const name of ["works", "projects", "attachments", "resources", "exports"]) if (!parts[name] || !under(parts[name], files)) problems.push(`${name} is not under Documents`);
      if (!parts.downloads || !under(parts.downloads, downloads)) problems.push("downloads are not under Downloads");
      // The Downloads folder is the person's: a start makes nothing there (download staging is in the application's cache).
      if (fs.readdirSync(machine.downloads).length) problems.push("a first start made something in the Downloads folder");
      if (!fs.existsSync(path.join(appRoot, "cache", "acquisition"))) problems.push("download staging is not in the application's cache");
      for (const file of [path.join("data", "manga.sqlite"), path.join("launcher", "pointer.json")]) if (!fs.existsSync(path.join(appRoot, file))) problems.push(`${file.replaceAll("\\", "/")} is not in the application's folder`);
      if (!fs.existsSync(path.join(appRoot, "runtime"))) problems.push("the browser runtime is not in the application's folder");
      // The Windows D3D11 user-mode driver (e.g. nvwgf2umx.dll) resolves its DirectX shader cache from %USERPROFILE%\appdata\local\NVIDIA\DXCache
      // even when LOCALAPPDATA points outside USERPROFILE; that driver cache is not application data written to Roaming or the home folder.
      const driverCache = (name) => /^appdata[\\/]+local[\\/]+(nvidia|amd|intel)[\\/]/i.test(name);
      const strays = [...filesIn(machine.roaming), ...filesIn(machine.home).filter((name) => !driverCache(name))];
      if (strays.length) problems.push(`${strays.length} files were written to the roaming profile or the home folder`);
      if (report.locations?.groups !== true) problems.push("the settings did not show three groups");
      observations.push({ name: `data-locations-fresh-${channel}`, status: problems.length ? "failed" : "passed", detail: { channel, screenshot: shot, strays: strays.length, problems } });
    } finally {
      fs.rmSync(machine.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    }
  }
  return { ok: observations.every((row) => row.status === "passed"), observations };
}

// AT-149: an installation of the version before the split, moved on the first start; a start cut short during the copy; a second start; an older build.
async function dataLocationsUpgrade() {
  const machine = tempMachine("upgrade", false);
  const problems = [];
  const detail = {};
  try {
    const oldRoot = path.join(machine.documents, "manga", "release");
    const oldPointer = path.join(oldRoot, "launcher", "pointer.json");
    const kept = path.join(machine.base, "E", "Downloads-kept");
    fs.mkdirSync(kept, { recursive: true });
    const seed = await launch(machine.base, machineEnv(machine, "release", { MANGA_PROFILE_ROOT: oldRoot, MANGA_POINTER_FILE: oldPointer, MANGA_SMOKE_PHASE: "locations-seed", MANGA_SMOKE_LIBRARY_DIR: path.join(machine.base, "library") }));
    const seeded = readJson(path.join(oldRoot, "logs", "smoke-locations-seed.json")) ?? {};
    if (seed.status !== 0 || seeded.status !== "passed") throw new Error(`the old installation was not made (status ${seed.status}): ${JSON.stringify(seeded.observations ?? seeded.error ?? null).slice(0, 400)}`);
    const noteFile = seeded.locations?.noteFile;
    const screenshot = seeded.locations?.screenshot;
    if (!noteFile || !fs.existsSync(noteFile) || !screenshot || !fs.existsSync(screenshot)) throw new Error("the old installation has no note file or screenshot");
    // The person had moved downloads elsewhere.
    fs.writeFileSync(oldPointer, JSON.stringify({ ...readJson(oldPointer), partitions: { downloads: kept } }));
    const before = filesIn(oldRoot).filter((name) => !/-(wal|shm)$/.test(name)).sort();
    const appRoot = path.join(machine.local, "manga");
    const newPointer = path.join(appRoot, "launcher", "pointer.json");

    // Cut short during the copy: the old place stays as it was and no new pointer is written.
    const cut = await launch(machine.base, machineEnv(machine, "release", { MANGA_SMOKE_PHASE: "locations", MANGA_UPGRADE_CRASH_AT: "upgrade-copy" }));
    detail.cut = { exitStatus: cut.status, newPointer: fs.existsSync(newPointer), marker: fs.existsSync(path.join(oldRoot, "RELOCATED.json")) };
    if (cut.status !== 99 || detail.cut.newPointer || detail.cut.marker) problems.push(`the start cut during the copy changed the old place or wrote a pointer (${JSON.stringify(detail.cut)})`);

    // The next start finishes the move.
    const moved = await launch(machine.base, machineEnv(machine, "release", { MANGA_SMOKE_PHASE: "locations" }));
    const report = readJson(path.join(appRoot, "logs", "smoke-locations.json")) ?? {};
    const loc = report.locations ?? {};
    detail.move = { exitStatus: moved.status, state: loc.upgrade?.state ?? null, files: loc.upgrade?.files ?? 0, carried: loc.upgrade?.carried ?? [] };
    if (moved.status !== 0 || report.status !== "passed") problems.push(`the start after the cut did not pass (status ${moved.status})`);
    if (loc.upgrade?.state !== "migrated") problems.push("the application's data was not moved");
    if (!loc.partitions?.data || !under(loc.partitions.data, appRoot)) problems.push("the database is not in the new place");
    if (loc.partitions?.works !== path.join(oldRoot, "works")) problems.push("the works folder did not stay where it was");
    if (loc.partitions?.downloads !== kept) problems.push("the download override was not kept");
    if (loc.noteFile !== noteFile || loc.noteOpens !== true) problems.push("the note file is not opened from where it was");
    if (loc.screenshot !== screenshot || !fs.existsSync(screenshot)) problems.push("the screenshot is not where it was");
    if (!fs.existsSync(path.join(oldRoot, "RELOCATED.json"))) problems.push("the old root has no RELOCATED.json");
    const after = filesIn(oldRoot);
    const lost = before.filter((name) => !after.includes(name));
    if (lost.length) problems.push(`${lost.length} files went from the old place`);
    if (loc.groups !== true) problems.push("the settings did not show three groups");

    // A second start moves nothing.
    const again = await launch(machine.base, machineEnv(machine, "release", { MANGA_SMOKE_PHASE: "locations" }));
    const second = readJson(path.join(appRoot, "logs", "smoke-locations.json")) ?? {};
    detail.second = { exitStatus: again.status, upgrade: second.locations?.upgrade ?? null };
    if (again.status !== 0 || second.locations?.upgrade) problems.push("the second start moved again");

    // An older build follows its own pointer to the old root, finds the marker and opens the new place (the current build started on the old
    // pointer, the code path the earlier release shares; no earlier package is kept to start).
    // Only the application data is checked: the user files stay where the new pointer says, which an older build never reads, and an older
    // build refuses the v13 library anyway (migrate-v13-newer).
    const olderStarted = Date.now();
    const older = await launch(machine.base, machineEnv(machine, "release", { MANGA_POINTER_FILE: oldPointer, MANGA_SMOKE_PHASE: "locations" }));
    const followed = readJson(path.join(appRoot, "logs", "smoke-locations.json")) ?? {};
    detail.older = { exitStatus: older.status, ms: Date.now() - olderStarted, data: followed.locations?.partitions?.data ? under(followed.locations.partitions.data, appRoot) : false, emulated: true, ...(older.status === 0 ? {} : { stderr: String(older.stderr).slice(-1500) }) };
    if (older.status !== 0 || detail.older.data !== true) problems.push("a start on the old pointer did not follow the marker");
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  } finally {
    fs.rmSync(machine.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
  return { ok: problems.length === 0, observations: [{ name: "data-locations-upgrade", status: problems.length ? "failed" : "passed", detail: { ...detail, problems } }] };
}
// AT-158: install-dev observation in an isolated temporary machine with testIdentity: true.
async function observeInstallDev() {
  const problems = [];
  const detail = {};
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "manga-package-install-dev-"));
  let devApp = null;
  let holdApp = null;
  try {
    const snapOpts = {
      localAppDataDir: path.join(temp, "fake-real-local"),
      roamingAppDataDir: path.join(temp, "fake-real-roaming"),
      startMenuDir: path.join(temp, "fake-real-roaming", "StartMenu"),
      desktopDir: path.join(temp, "fake-real-desktop"),
      programsDir: path.join(temp, "fake-real-local", "Programs"),
      registryEntries: [],
    };
    for (const d of [snapOpts.localAppDataDir, snapOpts.roamingAppDataDir, snapOpts.startMenuDir, snapOpts.desktopDir, snapOpts.programsDir]) {
      fs.mkdirSync(d, { recursive: true });
    }
    const places = {
      programs: path.join(temp, "Programs"),
      local: path.join(temp, "local"),
      documents: path.join(temp, "documents"),
      downloads: path.join(temp, "downloads"),
    };
    for (const d of Object.values(places)) fs.mkdirSync(d, { recursive: true });

    // Set up isolated `MANGA Test` (release) installation + running instance + SQLite data.
    const relInstallDir = path.join(places.programs, "manga-test");
    const relResourcesDir = path.join(relInstallDir, "resources");
    fs.mkdirSync(relResourcesDir, { recursive: true });
    fs.writeFileSync(path.join(relInstallDir, "manga-test.exe"), "release-binary-v0.1.1");
    writeBuildInfo(relResourcesDir, {
      version: "0.1.1",
      channel: "release",
      commit: "c79f49a",
      builtAt: "2026-11-08T00:00:00.000Z",
      schemaVersion: 14,
    });
    const relDataDir = path.join(places.local, "manga-test", "data");
    const relRuntimeDir = path.join(places.local, "manga-test", "runtime");
    fs.mkdirSync(relDataDir, { recursive: true });
    fs.mkdirSync(relRuntimeDir, { recursive: true });
    fs.writeFileSync(path.join(relDataDir, "manga.sqlite"), "release-sqlite-bytes");
    fs.writeFileSync(
      path.join(relRuntimeDir, "running-instance.json"),
      JSON.stringify({ pid: process.pid, state: "ready", version: "0.1.1", channel: "release" }),
    );

    // Set up isolated `MANGA Dev Test` (development) installation + running MangaProductApp with unsaved note draft.
    const devInstallDir = path.join(places.programs, "manga-dev-test");
    const devResourcesDir = path.join(devInstallDir, "resources");
    fs.mkdirSync(devResourcesDir, { recursive: true });
    fs.writeFileSync(path.join(devInstallDir, "manga-dev-test.exe"), "dev-binary-old");
    writeBuildInfo(devResourcesDir, {
      version: "0.1.1-dev.202611080900",
      channel: "development",
      commit: "1111111",
      builtAt: "2026-11-08T09:00:00.000Z",
      schemaVersion: 14,
    });

    devApp = new MangaProductApp({
      profileRoot: path.join(places.local, "manga-dev-test"),
      localAppDataDir: places.local,
      documentsDir: path.join(places.documents, "manga-dev-test"),
      downloadsDir: path.join(places.downloads, "manga-dev-test"),
      channel: "development",
      testIdentity: true,
      resourcesPath: devResourcesDir,
      vault: new TestVault(),
      ffmpegTools: null,
      buildInfo: {
        version: "0.1.1-dev.202611080900",
        channel: "development",
        commit: "1111111",
        builtAt: "2026-11-08T09:00:00.000Z",
        schemaVersion: 14,
      },
    });
    await devApp.start();

    const fakeNewInstaller = path.join(temp, "manga-dev-test-setup-0.1.1-dev.202611081530.exe");
    fs.writeFileSync(fakeNewInstaller, "fake-installer-binary");

    let devAlive = true;
    let draftSavedOnQuit = false;
    const updatedRes = await runInstallDev({
      env: { ...process.env, MANGA_DEV_AUTO_INSTALL: "1", CI: "", GITHUB_ACTIONS: "" },
      testIdentity: true,
      places,
      installDir: devInstallDir,
      installerPath: fakeNewInstaller,
      newVersion: "0.1.1-dev.202611081530",
      runningPid: 424242,
      isProcessAliveFn: (pid) => (pid === 424242 ? devAlive : pid === process.pid),
      requestQuitFn: async () => {
        draftSavedOnQuit = true;
        await devApp.prepareQuitForUpdate();
        devApp.close();
        devApp = null;
        devAlive = false;
      },
      spawnInstallerFn: async (_installer, _args, targetDir) => {
        writeBuildInfo(path.join(targetDir, "resources"), {
          version: "0.1.1-dev.202611081530",
          channel: "development",
          commit: "2222222",
          builtAt: "2026-11-08T15:30:00.000Z",
          schemaVersion: 14,
        });
        return { status: 0 };
      },
      relaunchFn: async () => ({
        relaunched: true,
        pid: 434343,
        draftPreserved: draftSavedOnQuit,
      }),
      outputFile: path.join(temp, "evidence", "install-dev-run.json"),
      snapshotOptions: snapOpts,
    });
    detail.updated = {
      status: updatedRes.status,
      installed: updatedRes.installed,
      wasRunning: updatedRes.wasRunning,
      relaunched: updatedRes.relaunched,
      previousVersion: updatedRes.previousVersion,
      newVersion: updatedRes.newVersion,
      draftPreserved: updatedRes.draftPreserved,
      releaseUntouched: updatedRes.releaseUntouched,
    };
    if (
      updatedRes.status !== "passed"
      || !updatedRes.installed
      || !updatedRes.wasRunning
      || !updatedRes.relaunched
      || updatedRes.draftPreserved !== true
      || !updatedRes.releaseUntouched
    ) {
      problems.push(`install-dev update failed: ${JSON.stringify(detail.updated)}`);
    }

    // 2. 60-second non-cancellable write abort case (no force-kill)
    holdApp = new MangaProductApp({
      profileRoot: path.join(places.local, "manga-dev-test"),
      localAppDataDir: places.local,
      documentsDir: path.join(places.documents, "manga-dev-test"),
      downloadsDir: path.join(places.downloads, "manga-dev-test"),
      channel: "development",
      testIdentity: true,
      resourcesPath: devResourcesDir,
      vault: new TestVault(),
      ffmpegTools: null,
      holdWriteMs: 60_000,
    });
    await holdApp.start();
    let holdExited = false;
    const abortRes = await runInstallDev({
      env: { ...process.env, MANGA_DEV_AUTO_INSTALL: "1", CI: "", GITHUB_ACTIONS: "" },
      testIdentity: true,
      places,
      installDir: devInstallDir,
      installerPath: fakeNewInstaller,
      newVersion: "0.1.1-dev.202611081800",
      quitTimeoutMs: 250,
      runningPid: 515151,
      isProcessAliveFn: (pid) => (pid === 515151 ? !holdExited : pid === process.pid),
      requestQuitFn: () => {
        void holdApp.prepareQuitForUpdate().then(() => { holdExited = true; });
      },
      outputFile: path.join(temp, "evidence", "install-dev-abort.json"),
      snapshotOptions: snapOpts,
    });
    holdApp.releaseBlockingWrites();
    await holdApp.waitForBlockingWrites();
    holdApp.close();
    holdApp = null;
    detail.aborted = {
      status: abortRes.status,
      installed: abortRes.installed,
      abortedPidStillAlive: abortRes.abortedPidStillAlive,
      releaseUntouched: abortRes.releaseUntouched,
    };
    if (abortRes.status !== "aborted" || abortRes.installed || !abortRes.abortedPidStillAlive || !abortRes.releaseUntouched) {
      problems.push(`install-dev 60s write abort failed: ${JSON.stringify(detail.aborted)}`);
    }

    // 3. Not-installed skip case & MANGA_DEV_AUTO_INSTALL=0 skip case
    const notInstRes = await runInstallDev({
      env: { ...process.env, MANGA_DEV_AUTO_INSTALL: "1", CI: "", GITHUB_ACTIONS: "" },
      registryEntries: [],
      outputFile: path.join(temp, "evidence", "install-dev-not-installed.json"),
      snapshotOptions: snapOpts,
    });
    const disabledRes = await runInstallDev({
      env: { ...process.env, MANGA_DEV_AUTO_INSTALL: "0", CI: "", GITHUB_ACTIONS: "" },
      outputFile: path.join(temp, "evidence", "install-dev-disabled.json"),
      snapshotOptions: snapOpts,
    });
    detail.skipped = {
      notInstalled: { status: notInstRes.status, skipReason: notInstRes.skipReason },
      disabled: { status: disabledRes.status, skipReason: disabledRes.skipReason },
    };
    if (notInstRes.status !== "skipped" || disabledRes.status !== "skipped") {
      problems.push(`install-dev skip cases failed: ${JSON.stringify(detail.skipped)}`);
    }
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  } finally {
    try { devApp?.close(); } catch { /* ignore */ }
    try { holdApp?.close(); } catch { /* ignore */ }
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
  return { name: "install-dev", status: problems.length === 0 ? "passed" : "failed", detail: { kind: "service-fixtures", ...detail, problems } };
}

// AT-163: release-workflow static validation, decideWeeklyRelease 3 scenarios, and missing-key guard.
async function observeReleaseWorkflow() {
  const problems = [];
  const detail = {};
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "manga-package-release-wf-"));
  try {
    const wf = validateWorkflows();
    detail.workflowValidation = { ok: wf.ok, errors: wf.errors };
    if (!wf.ok) problems.push(`release.yml validation failed: ${wf.errors.join("; ")}`);

    const caseNoTags = decideWeeklyRelease({
      tags: [],
      commitsSinceTag: ["c79f49a\tfeat: 待审操作与门禁提速 (#9)"],
      headSha: "c79f49a",
    });
    const caseNoCommits = decideWeeklyRelease({
      tags: ["v0.1.1", "v0.1.3"],
      commitsSinceTag: [],
      headSha: "c79f49a",
    });
    const caseTwoPrs = decideWeeklyRelease({
      tags: ["v0.1.1", "v0.1.3"],
      commitsSinceTag: [
        "1111111\tfeat: 安装与自动更新 (#10)",
        "2222222\tchore(deps): 升级 electron-updater (#11)",
      ],
      headSha: "2222222",
      schemaVersion: 15,
      previousSchemaVersion: 14,
      willUpgradeSchema: true,
    });
    detail.decide = {
      noTags: { shouldRelease: caseNoTags.shouldRelease, version: caseNoTags.version },
      noCommits: { shouldRelease: caseNoCommits.shouldRelease, reason: caseNoCommits.reason },
      twoPrs: {
        shouldRelease: caseTwoPrs.shouldRelease,
        version: caseTwoPrs.version,
        prCount: caseTwoPrs.pullRequests.length,
        listsBothPrs: caseTwoPrs.notesMarkdown.includes("PR #10") && caseTwoPrs.notesMarkdown.includes("PR #11"),
      },
    };
    if (!caseNoTags.shouldRelease || caseNoTags.version !== "0.1.1") problems.push("decide no-tags did not return 0.1.1");
    if (caseNoCommits.shouldRelease || caseNoCommits.reason !== "本周没有新的合并") problems.push("decide no-commits did not skip");
    if (!caseTwoPrs.shouldRelease || caseTwoPrs.version !== "0.1.4" || !detail.decide.twoPrs.listsBothPrs) {
      problems.push("decide two-PRs did not produce 0.1.4 with both PRs");
    }

    const releaseRootDir = path.join(temp, "dist-release");
    let missingKeyFailed = false;
    try {
      await runStageRelease({
        ci: true,
        version: "0.1.2",
        gitStatusFn: () => "",
        signingKeyPath: path.join(temp, "missing-key.pem"),
        releaseRootDir,
      });
    } catch (error) {
      missingKeyFailed = /update signing private key is missing/.test(error instanceof Error ? error.message : String(error));
    }
    const noUnsignedLeft = !fs.existsSync(path.join(releaseRootDir, "v0.1.2"));
    detail.missingKey = { missingKeyFailed, noUnsignedLeft };
    if (!missingKeyFailed || !noUnsignedLeft) {
      problems.push(`stage release --ci without key did not fail cleanly: ${JSON.stringify(detail.missingKey)}`);
    }
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  return { name: "release-workflow", status: problems.length === 0 ? "passed" : "failed", detail: { kind: "service-fixtures", ...detail, problems } };
}

// AT-162: installer-info observation (Simplified Chinese NSIS UI, multi-res .ico icon, PE metadata, and Windows Uninstall entry).
async function observeInstallerInfo() {
  const problems = [];
  const detail = {};
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "manga-package-installer-info-"));
  const realBefore = snapshotRealInstallations();
  const UNINSTALL_KEY = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall";
  const ps = (cmd) => (spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${cmd}`], { encoding: "utf8", windowsHide: true }).stdout ?? "").trim();
  const cleanupTestRelease = () => removeTestInstallations(["release"]);
  try {
    const svgExists = fs.existsSync(DEFAULT_ICON_SVG);
    const pngDims = fs.existsSync(DEFAULT_ICON_PNG) ? pngSize(fs.readFileSync(DEFAULT_ICON_PNG)) : null;
    const icoInspection = fs.existsSync(DEFAULT_ICON_ICO) ? inspectIco(fs.readFileSync(DEFAULT_ICON_ICO)) : { valid: false, sizes: [], problems: ["missing ico"] };
    detail.icons = { svgExists, pngDims, icoValid: icoInspection.valid, icoSizes: icoInspection.sizes };
    if (!svgExists || pngDims?.width !== 512 || pngDims?.height !== 512 || !icoInspection.valid || icoInspection.sizes.length !== ICON_SIZES.length) {
      problems.push(`icon verification failed: ${JSON.stringify(detail.icons)}`);
    }

    const cfg = installerConfig("release", { output: "out", include: "inc.nsh", version: "0.1.1", testIdentity: true });
    const cfgProblems = checkInstallerConfig("release", cfg, installerInclude("release", { testIdentity: true }), { testIdentity: true });
    detail.config = {
      language: cfg.nsis.language,
      installerLanguages: cfg.nsis.installerLanguages,
      runAfterFinish: cfg.nsis.runAfterFinish,
      publisherName: cfg.win.signtoolOptions.publisherName,
      problems: cfgProblems,
    };
    if (cfgProblems.length > 0 || cfg.nsis.language !== "2052" || !cfg.nsis.installerLanguages.includes("zh_CN") || cfg.nsis.runAfterFinish !== true) {
      problems.push(`installer config check failed: ${JSON.stringify(detail.config)}`);
    }

    await cleanupTestRelease();
    const workDir = path.join(temp, "build");
    const installTargetDir = path.join(temp, "Programs", TEST_CHANNEL_INSTALL.release.dirName);
    fs.mkdirSync(workDir, { recursive: true });
    fs.mkdirSync(installTargetDir, { recursive: true });

    const builtInstaller = await buildInstaller({
      appDir: appPath,
      channel: "release",
      workDir,
      version: "0.1.1",
      testIdentity: true,
    });
    const instRes = spawnSync(builtInstaller.installer, ["/S", `/D=${installTargetDir}`], { windowsHide: true, timeout: 300_000 });
    const regText = ps(`Get-ChildItem '${UNINSTALL_KEY}' -ErrorAction SilentlyContinue | ForEach-Object { $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue; if ($p -and $p.DisplayName -eq 'MANGA Test') { [pscustomobject]@{ DisplayName = [string]$p.DisplayName; DisplayVersion = [string]$p.DisplayVersion; Publisher = [string]$p.Publisher; DisplayIcon = [string]$p.DisplayIcon } } } | ConvertTo-Json -Compress`);
    const regEntry = regText ? (Array.isArray(JSON.parse(regText)) ? JSON.parse(regText)[0] : JSON.parse(regText)) : null;

    const installedExe = path.join(installTargetDir, `${TEST_CHANNEL_INSTALL.release.executableName}.exe`);
    let exeIconsCount = 0;
    let exeCompany = "";
    if (fs.existsSync(installedExe)) {
      const pe = resedit.NtExecutable.from(fs.readFileSync(installedExe), { ignoreCert: true });
      const res = resedit.NtExecutableResource.from(pe);
      const groups = resedit.Resource.IconGroupEntry.fromEntries(res.entries);
      if (groups[0]) {
        exeIconsCount = groups[0].icons.length;
      }
      const vi = resedit.Resource.VersionInfo.fromEntries(res.entries)[0];
      const lang = vi?.getAllLanguagesForStringValues()[0];
      if (vi && lang) {
        exeCompany = vi.getStringValues(lang).CompanyName ?? "";
      }
    }

    detail.installed = {
      exitStatus: instRes.status,
      displayName: regEntry?.DisplayName ?? null,
      displayVersion: regEntry?.DisplayVersion ?? null,
      publisher: regEntry?.Publisher ?? null,
      hasDisplayIcon: Boolean(regEntry?.DisplayIcon),
      exeIconsCount,
      exeCompany,
    };
    if (
      instRes.status !== 0
      || regEntry?.DisplayName !== "MANGA Test"
      || regEntry?.DisplayVersion !== "0.1.1"
      || regEntry?.Publisher !== INSTALLER_META.author
      || !regEntry?.DisplayIcon
      || exeIconsCount < ICON_SIZES.length
      || exeCompany !== INSTALLER_META.author
    ) {
      problems.push(`installed registry or PE metadata mismatch: ${JSON.stringify(detail.installed)}`);
    }
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  } finally {
    await cleanupTestRelease();
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
  const realAfter = snapshotRealInstallations();
  const realDiff = compareRealInstallations(realBefore, realAfter);
  detail.realInstallationsUntouched = realDiff.ok;
  if (!realDiff.ok) problems.push(`real installations changed: ${realDiff.changes.join("; ")}`);
  return { name: "installer-info", status: problems.length === 0 ? "passed" : "failed", detail: { ...detail, problems } };
}

async function runUpdatePhase() {
  const windowReport = await smoke("update");
  const extraObservations = [
    await observeInstallDev(),
    await observeReleaseWorkflow(),
    await observeInstallerInfo(),
    // Light open leaves before install-dev installs, or nothing is installed (4.6).
    ...await observeLightUpdate({ appPath, samplesRoot, runInstallDev }),
  ];
  const combined = [...(windowReport.observations ?? []), ...extraObservations];
  const ok = windowReport.ok === true && combined.every((row) => row.status === "passed");
  return { ...windowReport, ok, observations: combined };
}

// Light open (READ-05, A-128, 第 7 节): its windows, its footprint, its own lock beside the full application's, and what its bundles carry.
async function runLightPhase() {
  const boundary = checkLightBoundary(appPath);
  const windows = await observeLightOpen({ appPath, samplesRoot, evidenceDir: evidence });
  const observations = [boundary, ...windows.observations];
  return { ok: observations.every((row) => row.status === "passed"), observations, timings: windows.timings };
}

const DRIVEN = { light: runLightPhase, "migrate-v13-newer": migrateNewer, "data-locations-fresh": dataLocationsFresh, "data-locations-upgrade": dataLocationsUpgrade, update: runUpdatePhase };

const smokeReports = {};
const phaseTimings = {};
for (const phase of phases) {
  const phaseStarted = Date.now();
  smokeReports[phase] = DRIVEN[phase] ? await DRIVEN[phase]() : await smoke(phase);
  phaseTimings[phase] = Math.round((Date.now() - phaseStarted) / 1000);
  if (DRIVEN[phase] && smokeReports[phase].ok !== true) {
    console.error(JSON.stringify(smokeReports[phase].observations, null, 2));
    throw new Error(`${phase} failed`);
  }
}
if (onlyPhases) {
  const tempDirs = tempWatch.passed();
  const rows = Object.values(smokeReports).flatMap((report) => report?.observations ?? []);
  console.log(JSON.stringify({ status: "partial", phases, observations: rows.length, failed: rows.filter((row) => row.status !== "passed").map((row) => row.name), tempDirs }));
  process.exit(0);
}

// Each observation of the window walk (library paths, work home, right pane, settings, comic zoom at three window sizes, player and
// reader controls) is written on its own so the report can require every one of them by name.
// The creative walk (projects, whiteboard, mind map, draft, research, embeds, package, rough cut, vector extension, fit at three window sizes) adds its own.
const danmakuNetwork = smokeReports["window-walk"]?.danmakuNetwork;
const observations = [
  ...(smokeReports["window-walk"]?.observations ?? []),
  ...(danmakuNetwork ? [{ name: "danmaku-network", status: danmakuNetwork.status, detail: danmakuNetwork.detail }] : []),
  ...(smokeReports["workspace-restart"]?.observations ?? []),
  ...(smokeReports["workspace-closed"]?.observations ?? []),
  ...(smokeReports["workspace-migrated"]?.observations ?? []),
  ...(smokeReports.creative?.observations ?? []),
  ...(smokeReports.trace?.observations ?? []),
  // The dependency and Agent loop stage (计划第 7 节).
  ...(smokeReports.loop?.observations ?? []),
  ...(smokeReports.voice?.observations ?? []),
  ...(smokeReports.light?.observations ?? []),
  ...["credentials-async", "credentials-async-restart", "migrate-v13", "migrate-v13-restart", "migrate-v13-newer", "data-locations-fresh", "data-locations-upgrade", "update"].flatMap((name) => smokeReports[name]?.observations ?? []),
];

// A package that is missing a bundled tool must stop at start, naming it, instead of failing in the middle of a recording.
function missingAssetCheck() {
  const target = path.join(appPath, "resources", "vad", "silero_vad.onnx");
  const hidden = `${target}.hidden`;
  const profileMissing = fs.mkdtempSync(path.join(os.tmpdir(), "manga-package-missing-"));
  fs.renameSync(target, hidden);
  try {
    const result = spawnSync(path.join(appPath, "manga.exe"), ["--manga-smoke"], {
      cwd: profileMissing,
      env: packagedEnv({ MANGA_CHANNEL: "test", MANGA_PROFILE_ROOT: path.join(profileMissing, "root"), MANGA_DOCUMENTS_DIR: path.join(profileMissing, "documents"), MANGA_POINTER_FILE: path.join(profileMissing, "launcher", "pointer.json"), MANGA_SMOKE_PHASE: "initial" }),
      encoding: "utf8",
      timeout: 60_000,
      windowsHide: true,
    });
    const log = path.join(profileMissing, "root", "logs", "smoke-initial.json");
    const report = fs.existsSync(log) ? JSON.parse(fs.readFileSync(log, "utf8")) : {};
    const named = Array.isArray(report.missingAssets) && report.missingAssets.some((item) => String(item).includes("silero_vad.onnx"));
    if (result.status === 0 || !named) throw new Error(`a package without its voice model did not stop at start (status ${result.status})`);
    return { stoppedAtStart: true, status: result.status, message: String(report.error ?? "") };
  } finally {
    fs.renameSync(hidden, target);
    fs.rmSync(profileMissing, { recursive: true, force: true });
  }
}
const missingAsset = missingAssetCheck();
// The per-user installer of the package's own channel (计划 4.10): made from this directory and its configuration checked; installing it for real is
// node scripts/stage.mjs installer, run on its own.
const installerDir = path.join(path.dirname(desktopPackageDir), "installer");
const packagedChannel = JSON.parse(fs.readFileSync(path.join(appPath, "resources", "channel.json"), "utf8")).channel;
// With the build reused, the installer the run before made from the same directory is the one this run would make (its version is the build's own):
// it is used when the record of it names the same inputs and directory, the directory is still that one after the walks, its bytes are the recorded
// ones and its configuration still checks.
const reusedInstaller = (() => {
  if (!reuseBuild || !appDigestAtStart || directoryDigest(appPath) !== appDigestAtStart) return null;
  const latest = (() => { try { return JSON.parse(fs.readFileSync(latestDesktopPackage, "utf8")); } catch { return null; } })();
  const record = latest?.installer;
  if (!record || latest.appDigest !== appDigestAtStart || record.channel !== packagedChannel || !packagedFingerprintKeys(config).every((key) => latest[key] === fingerprints[key])) return null;
  const file = path.resolve(root, record.output);
  const output = path.join(installerDir, `out-${packagedChannel}`);
  const include = path.join(installerDir, `installer-${packagedChannel}.nsh`);
  if (path.dirname(file) !== output || !fs.existsSync(file) || !fs.existsSync(include) || fs.statSync(file).size !== record.bytes || sha256(fs.readFileSync(file)) !== record.sha256) return null;
  const made = installerConfig(packagedChannel, { output, include, version: record.version });
  if (checkInstallerConfig(packagedChannel, made, fs.readFileSync(include, "utf8")).length) return null;
  return { installer: file, bytes: record.bytes, ms: 0, config: made, version: record.version };
})();
if (reusedInstaller) console.log("[package] the installer made from this same directory is unchanged: used as it is");
else fs.rmSync(installerDir, { recursive: true, force: true });
const madeInstaller = reusedInstaller ?? await buildInstaller({ appDir: appPath, channel: packagedChannel, workDir: installerDir });
const installerSummary = { channel: packagedChannel, version: madeInstaller.version, output: path.relative(root, madeInstaller.installer).replaceAll("\\", "/"), bytes: madeInstaller.bytes, sha256: crypto.createHash("sha256").update(fs.readFileSync(madeInstaller.installer)).digest("hex"), megabytes: Math.round(madeInstaller.bytes / 1024 / 1024), seconds: Math.round(madeInstaller.ms / 1000), appId: madeInstaller.config.appId, perMachine: madeInstaller.config.nsis.perMachine, oneClick: madeInstaller.config.nsis.oneClick, deleteAppDataOnUninstall: madeInstaller.config.nsis.deleteAppDataOnUninstall, defaultFolder: CHANNEL_INSTALL[packagedChannel].dirName, signed: false };
fs.writeFileSync(path.join(evidence, "scenarios.json"), `${JSON.stringify({
  status: observations.length > 0 && observations.every((row) => row.status === "passed") ? "passed" : "failed",
  stage,
  ...fingerprints,
  productAcceptance: "not-run",
  at: new Date().toISOString(),
  source: "packaged window walk, restart of its Profile, a real close of the window and the start after it, upgrade of a synthetic v11 library, creative walk and trace walk, phases window-walk, workspace-restart, workspace-closed, workspace-migrated, creative and trace (synthetic samples, fresh Profile each)",
  windowSizes: smokeReports["window-walk"]?.windowSizes ?? null,
  observations: observations.map((row) => ({ name: row.name, status: row.status, detail: row.detail ?? null })),
}, null, 2)}\n`);
const readingLoopTimings = smokeReports["reading-loop"]?.timings ?? {};
const tempDirs = tempWatch.passed();
if (tempDirs.left > 0) {
  console.error(JSON.stringify({ status: "failed", check: "stage-package", reason: "temporary directories left behind", ...tempDirs }));
  process.exit(1);
}
fs.writeFileSync(path.join(evidence, "package.json"), `${JSON.stringify({
  tempDirs,
  status: "passed",
  passStreak,
  // Whether this run packaged again or used the unchanged build and installer of the run before it on the same inputs.
  build: { reused: reuseBuild, installerReused: Boolean(reusedInstaller) },
  stage,
  ...fingerprints,
  productAcceptance: "not-run",
  at: new Date().toISOString(),
  format: "unsigned local Electron package",
  electron: electronVersion,
  output: path.relative(root, appPath).replaceAll("\\", "/"),
  smoke: phases,
  ...(excusedPhases.length ? { excusedPhases } : {}),
  phaseTimings,
  formats: {
    pages: smokeReports.formats?.pages ?? false,
    contexts: smokeReports.formats?.contexts ?? false,
    failureVisible: smokeReports.formats?.failureVisible ?? false,
    opened: smokeReports.formats?.opened ?? null,
  },
  viewports: smokeReports.reading?.viewports ?? null,
  // LOOP-06: the PDF page's paints around the selection, from the real window.
  loop06: smokeReports.formats?.loop06 ?? null,
  agent: { runningShown: smokeReports.agent?.runningShown ?? false, stoppedShown: smokeReports.agent?.stoppedShown ?? false, conversationShown: smokeReports["agent-restart"]?.conversationShown ?? false },
  windowWalk: { ok: smokeReports["window-walk"]?.ok ?? false, observations: observations.length, seconds: phaseTimings["window-walk"] ?? null },
  // The workspace over a restart of the window walk's Profile, the start after that restart closed its window for real, and on a synthetic v11 library of the two-mode shell started on for the first time (plan 4.8).
  workspace: { restart: smokeReports["workspace-restart"]?.ok ?? false, closed: smokeReports["workspace-closed"]?.ok ?? false, migrated: smokeReports["workspace-migrated"]?.ok ?? false },
  creative: { ok: smokeReports.creative?.ok ?? false, observations: (smokeReports.creative?.observations ?? []).length },
  // AT-97 in the window: a task against a stand-in model, its record opened from the reply, and no secret anywhere it could be read.
  trace: { ok: smokeReports.trace?.ok ?? false, observations: (smokeReports.trace?.observations ?? []).length },
  // The bundled BitTorrent plugin in the packaged window: offered, installed with confirmed permissions, run in a process of its own, a loopback download imported, stopped and started again.
  plugins: { ok: smokeReports.plugins?.ok ?? false, steps: smokeReports.plugins?.steps ?? [] },
  missingAsset,
  installer: installerSummary,
  media: smokeReports.media ? { steps: smokeReports.media.steps, matrix: smokeReports.media.matrix, timings: smokeReports.media.timings } : null,
  voice: smokeReports.voice ? { steps: smokeReports.voice.steps } : null,
  // Light open in the packaged window: the first frame and page of one run, and the working set after a video opened (the bench measures them five times).
  light: smokeReports.light ? { ok: smokeReports.light.ok, timings: smokeReports.light.timings } : null,
  // Operation-level timing from the real reading-loop run, not from click dispatch.
  readingLoop: {
    readLastChapter: smokeReports["reading-loop"]?.readLastChapter ?? false,
    recordedNote: smokeReports["reading-loop"]?.recordedNote ?? false,
    selectionAccurate: smokeReports["reading-loop"]?.selectionAccurate ?? false,
    materialsFrozen: smokeReports["reading-loop"]?.materialsFrozen ?? false,
    materialsFromUi: smokeReports["reading-loop"]?.materialsFromUi ?? false,
    uiTailVisible: smokeReports["reading-loop"]?.uiTailVisible ?? false,
    progressAtTail: smokeReports["reading-loop"]?.progressAtTail ?? false,
    uiRestoredTail: smokeReports["reading-loop-restart"]?.uiRestoredTail ?? false,
    bookmarkHighlighted: smokeReports["reading-loop"]?.bookmarkHighlighted ?? false,
    sourceCardOk: smokeReports["reading-loop"]?.sourceCardOk ?? false,
    restoredProgress: smokeReports["reading-loop-restart"]?.restoredProgress ?? false,
    restoredSource: smokeReports["reading-loop-restart"]?.restoredSource ?? false,
    restoredMaterials: smokeReports["reading-loop-restart"]?.restoredMaterials ?? false,
    diagnostics: smokeReports["reading-loop"]?.diagnostics ?? null,
    timings: readingLoopTimings,
  },
}, null, 2)}\n`);
console.log(JSON.stringify({ status: "passed", check: "stage-package", passStreak, output: appPath }));
fs.writeFileSync(latestDesktopPackage, `${JSON.stringify({ target: path.relative(root, appPath).replaceAll("\\", "/"), evidence: path.relative(root, evidence).replaceAll("\\", "/"), installer: installerSummary, appDigest: appDigestAtStart, stage, ...fingerprints }, null, 2)}\n`);
// The local development install is updated once per change: after a `stage package` run on its own, or by the gate's last step (it runs this
// file three times, and the installed app would be asked to quit and reopen each time).
if (packagedChannel === "development" && process.env.MANGA_PACKAGE_IN_GATE === "1") {
  console.log("[install-dev] left to the gate's last step");
} else if (packagedChannel === "development") {
  try {
    const devInstall = await runInstallDev({
      installerPath: madeInstaller.installer,
      newVersion: madeInstaller.version,
      expectedSha256: installerSummary.sha256,
      packagedAppDir: appPath,
      evidenceDir: evidence,
    });
    const { relaunchedPid: _pid, abortedPidStillAlive: _alive, ...devSummary } = devInstall;
    console.log(JSON.stringify({ check: "stage-install-dev", ...devSummary }));
  } catch (error) {
    console.error(`[install-dev] ${error instanceof Error ? error.message : String(error)}`);
  }
}
