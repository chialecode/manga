import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { evaluateEvidence } from "./m0-report.mjs";
import { sourceFingerprint } from "../experiments/m0/src/report.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tscJs = path.join(root, "node_modules/typescript/bin/tsc");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", ...options });
  if (result.error) {
    console.error(result.error.message);
    return 1;
  }
  return result.status ?? 1;
}

function which(command) {
  const attempts = process.platform === "win32"
    ? [
      { command, options: { encoding: "utf8" } },
      { command: `${command}.cmd`, options: { encoding: "utf8" } },
      { command, options: { encoding: "utf8", shell: true } },
    ]
    : [{ command, options: { encoding: "utf8" } }];
  for (const attempt of attempts) {
    const result = spawnSync(attempt.command, [command.startsWith("ff") ? "-version" : "--version"], attempt.options);
    if (result.error?.code === "ENOENT") continue;
    const text = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    if (result.status === 0 && text) return text.split(/\r?\n/)[0];
  }
  return null;
}

function gitFingerprint() {
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  const dirty = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
  return {
    commit: head.stdout.trim(),
    dirty: Boolean(dirty.stdout.trim()),
    sourceFingerprint: sourceFingerprint(root),
  };
}

function doctor() {
  const env = {
    node: process.versions.node,
    pnpm: which("pnpm"),
    ffmpeg: which("ffmpeg"),
    ffprobe: which("ffprobe"),
    electron: fs.existsSync(path.join(root, "experiments/m0-desktop/node_modules/electron")),
    sqlite: "node:sqlite",
    platform: `${os.platform()} ${os.arch()} ${os.release()}`,
    git: gitFingerprint(),
    humanPending: ["headset-crosstalk-unplug", "hardware-sample-offset", "playback-export-confirmation-on-repaired-build"],
  };
  const passed=Number(process.versions.node.split(".")[0]) >= 24 && Boolean(env.pnpm && env.ffmpeg && env.ffprobe && env.electron);
  console.log(JSON.stringify({ status: passed ? "passed" : "failed", check: "m0-doctor", env }, null, 2));
  return passed ? 0 : 1;
}

function fixtures() {
  return run(process.execPath, ["--experimental-strip-types", "experiments/m0/src/fixtures/generate.ts"]);
}

function typecheck() {
  if (!fs.existsSync(tscJs)) {
    console.error("tsc missing; run pnpm install");
    return 1;
  }
  return run(process.execPath, [tscJs, "--noEmit", "-p", "tsconfig.json"]);
}

function test() {
  const files = fs.readdirSync(path.join(root, "experiments/m0/src/tests"))
    .filter((name) => name.endsWith(".test.ts"))
    .map((name) => path.join("experiments/m0/src/tests", name));
  const evidence = path.resolve(root, process.env.M0_EVIDENCE_DIR ?? "docs/evidence/m0-closure");
  fs.mkdirSync(evidence, { recursive: true });
  const status = run(process.execPath, ["--experimental-strip-types", "--test", "--test-reporter=spec", "--test-concurrency=1", ...files], {
    env: { ...process.env, M0_EVIDENCE_DIR: evidence, M0_VOL_A: process.env.M0_VOL_A, M0_VOL_B: process.env.M0_VOL_B },
  });
  fs.writeFileSync(path.join(evidence, "test-run.json"), `${JSON.stringify({ status: status === 0 ? "passed" : "failed", at: new Date().toISOString(), sourceFingerprint: sourceFingerprint(root), files }, null, 2)}\n`);
  return status;
}

function desktop() {
  const desktopDir = path.join(root, "experiments/m0-desktop");
  const electron = path.join(desktopDir, "node_modules/.bin", process.platform === "win32" ? "electron.cmd" : "electron");
  if (!fs.existsSync(electron)) {
    console.log("Installing electron into experiments/m0-desktop (not a root/CI dependency)...");
    const install = run(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["install", "--ignore-workspace"], {
      cwd: desktopDir,
      shell: process.platform === "win32",
    });
    if (install !== 0) {
      console.error("Failed to install electron. From experiments/m0-desktop run: pnpm install");
      return install || 1;
    }
  }
  const build = run(process.execPath, [path.join(desktopDir, "build.mjs")]);
  if (build !== 0) return build;
  if (!fs.existsSync(electron)) {
    console.error("electron is still missing after install");
    return 1;
  }
  return run(electron, [path.join(desktopDir, "dist/main.cjs")], {
    shell: process.platform === "win32",
    env: { ...process.env, MANGA_NODE_BIN: process.execPath },
  });
}

function report() {
  const dir = path.resolve(root, process.env.M0_EVIDENCE_DIR ?? "docs/evidence/m0-closure");
  fs.mkdirSync(dir,{recursive:true});
  const result=evaluateEvidence(dir,sourceFingerprint(root));
  // Technical/product approval and new-stack integration cannot be inferred from prototype test JSON.
  const summary={generatedAt:new Date().toISOString(),git:gitFingerprint(),evidenceDir:path.relative(root,dir).replaceAll("\\","/"),...result,
    m0Exit:"not-assessed-see-stage-gates",m1Entry:"not-assessed-see-stage-gates",
    stageAssessment:"docs/delivery/status.md",
    note:"Only the tested prototype subset is evaluated here. Milestone closure requires the current stage gates, decisions and version-appropriate human evidence; see status.md."};
  fs.writeFileSync(path.join(dir,"summary.json"),JSON.stringify(summary,null,2)+"\n");
  console.log(JSON.stringify(summary,null,2));
  return result.errors.length?1:0;
}

function bench() {
  return run(process.execPath, ["--experimental-strip-types", "scripts/bench-m0.mjs"]);
}

function packageSmoke() {
  return run(process.execPath, ["--experimental-strip-types", "scripts/package-m0.mjs"]);
}

const command = process.argv[2] ?? "help";
const commands = { doctor, fixtures, test, desktop, report, typecheck, bench, package: packageSmoke };
if (command === "help" || !commands[command]) {
  console.log("node scripts/m0.mjs <doctor|fixtures|typecheck|test|desktop|report|bench|package>");
  process.exit(command === "help" ? 0 : 2);
}
process.exit(commands[command]());
