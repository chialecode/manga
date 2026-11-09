import { app, dialog, shell } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  commitVerifiedRollback,
  evaluateBootstrapStart,
  questionText,
  RELEASES_PAGE,
  retryLaunch,
  verifiedPrevious,
  type GuardedBootstrapStart,
  type GuardPaths,
  type LaunchDecision,
} from "./launch-guard.ts";

/**
 * The packaged main entry (`main.cjs`, A-128, 4.1). Node and Electron only: it decides which main process this start is and loads it.
 *
 * - `--manga-light` loads light open (`light-main.cjs`), which never touches the library, plugins, the Agent or updates.
 * - Everything else (a normal start, `--manga-smoke`, `--quit-for-update`) loads the full application (`full-main.cjs`), as before.
 *
 * Before the full application of a release that came by an update, it keeps count of the starts that never reached the window and, after two of
 * them, asks what to do (4.2) before any other code is loaded.
 */
// The bundles sit next to this one; the path is worked out at run time, so the bundler leaves the require alone.
const load = (file: string): void => { require(path.join(__dirname, file)); };

/** Run the kept installer once this process is gone, then start the version it put back. The installer's bytes are checked again just before. */
async function runPreviousInstaller(paths: GuardPaths, installer: string, sha512Hex: string): Promise<boolean> {
  try {
    fs.mkdirSync(paths.runtime, { recursive: true });
    const attemptId = `rollback_${process.pid}_${Date.now()}`;
    const planFile = path.join(paths.runtime, `${attemptId}.plan.json`);
    const readyFile = path.join(paths.runtime, `${attemptId}.ready.json`);
    const cancelFile = path.join(paths.runtime, `${attemptId}.cancel`);
    const plan = {
      attemptId,
      pid: process.pid,
      installer,
      sha512Hex: sha512Hex.toLowerCase(),
      installDir: path.dirname(process.execPath),
      exePath: process.execPath,
      readyFile,
      cancelFile,
    };
    fs.writeFileSync(planFile, `${JSON.stringify(plan, null, 2)}\n`);
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$planFile = $env:MANGA_ROLLBACK_PLAN",
      "$plan = $null",
      "Remove-Item Env:MANGA_ROLLBACK_PLAN -ErrorAction SilentlyContinue",
      "Remove-Item Env:MANGA_ROLLBACK_SCRIPT -ErrorAction SilentlyContinue",
      "try {",
      "  $plan = Get-Content -LiteralPath $planFile -Raw -Encoding UTF8 | ConvertFrom-Json",
      "  Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop",
      "  if ((Get-FileHash -LiteralPath $plan.installer -Algorithm SHA512).Hash.ToLowerInvariant() -ne $plan.sha512Hex) { exit 2 }",
      "  $ready = @{ attemptId = $plan.attemptId; helperPid = $PID } | ConvertTo-Json -Compress",
      "  [System.IO.File]::WriteAllText([string]$plan.readyFile, [string]$ready, (New-Object System.Text.UTF8Encoding($false)))",
      "  for ($i = 0; $i -lt 400; $i++) {",
      "    if (Test-Path -LiteralPath $plan.cancelFile) { exit 4 }",
      "    if (-not (Get-Process -Id $plan.pid -ErrorAction SilentlyContinue)) { break }",
      "    Start-Sleep -Milliseconds 100",
      "  }",
      "  if (Get-Process -Id $plan.pid -ErrorAction SilentlyContinue) { exit 3 }",
      "  if (Test-Path -LiteralPath $plan.cancelFile) { exit 4 }",
      "  if ((Get-FileHash -LiteralPath $plan.installer -Algorithm SHA512).Hash.ToLowerInvariant() -ne $plan.sha512Hex) { exit 2 }",
      "  $p = Start-Process -FilePath $plan.installer -ArgumentList @('--updated', '/S', ('/D=' + $plan.installDir)) -Wait -PassThru -WindowStyle Hidden",
      "  if ($p.ExitCode -eq 0 -and (Test-Path -LiteralPath $plan.exePath)) {",
      "    if ($env:MANGA_WINDOW_HIDDEN -eq '1') { Start-Process -FilePath $plan.exePath -WindowStyle Hidden }",
      "    else { Start-Process -FilePath $plan.exePath }",
      "  }",
      "} finally {",
      "  if ($planFile) { Remove-Item -LiteralPath $planFile -Force -ErrorAction SilentlyContinue }",
      "  if ($plan) {",
      "    Remove-Item -LiteralPath $plan.readyFile -Force -ErrorAction SilentlyContinue",
      "    Remove-Item -LiteralPath $plan.cancelFile -Force -ErrorAction SilentlyContinue",
      "  }",
      "}",
    ].join("; ");
    // PowerShell cannot run with DETACHED_PROCESS here; a directly attached child is killed when this process exits before Start-Process runs.
    const outer = "Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList @('-NoProfile','-NonInteractive','-WindowStyle','Hidden','-EncodedCommand',$env:MANGA_ROLLBACK_SCRIPT) -WindowStyle Hidden";
    const helperEnv: NodeJS.ProcessEnv = { ...process.env, MANGA_ROLLBACK_PLAN: planFile, MANGA_ROLLBACK_SCRIPT: Buffer.from(script, "utf16le").toString("base64") };
    delete helperEnv.MANGA_TEST_FAIL_LAUNCH;
    delete helperEnv.MANGA_TEST_LAUNCH_ANSWER;
    delete helperEnv.MANGA_LAUNCH_ATTEMPT_FILE;
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", outer], {
      detached: false,
      stdio: "ignore",
      windowsHide: true,
      env: helperEnv,
    });
    let outerFailed = false;
    child.once("exit", (code) => { outerFailed = code !== 0; });
    const started = await new Promise<boolean>((resolve) => {
      child.once("error", () => resolve(false));
      child.once("spawn", () => resolve(true));
    });
    if (!started) {
      for (const file of [planFile, readyFile, cancelFile]) fs.rmSync(file, { force: true });
      return false;
    }
    const deadline = Date.now() + 15_000;
    let prepared = false;
    while (!outerFailed && Date.now() < deadline) {
      try {
        const ready = JSON.parse(fs.readFileSync(readyFile, "utf8")) as { attemptId?: string; helperPid?: number };
        if (ready.attemptId === attemptId && Number.isSafeInteger(ready.helperPid) && (ready.helperPid ?? 0) > 0) {
          process.kill(ready.helperPid!, 0);
          prepared = true;
          break;
        }
      } catch { /* preparation is still in progress */ }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (outerFailed || !prepared) {
      try { fs.writeFileSync(cancelFile, "cancelled"); } catch { /* best effort */ }
      child.unref();
      return false;
    }
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** The question, as a system dialog. A test identity may answer it from the environment; the question is then written where the test reads it. */
async function ask(start: GuardedBootstrapStart, decision: Extract<LaunchDecision, { kind: "ask" }>): Promise<void> {
  const previous = verifiedPrevious(start.paths);
  const text = questionText(decision.version, previous);
  let answer: "back" | "retry" | "download";
  const scripted = start.testIdentity ? process.env.MANGA_TEST_LAUNCH_ANSWER : undefined;
  if (scripted === "back" || scripted === "retry" || scripted === "download") {
    answer = scripted;
  } else {
    await app.whenReady();
    const { response } = await dialog.showMessageBox({ type: "warning", title: "MANGA", message: text.message, detail: text.detail, buttons: text.buttons, defaultId: previous ? 1 : 0, cancelId: previous ? 1 : 0, noLink: true });
    const choices: Array<"back" | "retry" | "download"> = previous ? ["back", "retry", "download"] : ["retry", "download"];
    answer = choices[response] ?? "retry";
  }
  if (start.testIdentity) {
    fs.mkdirSync(start.paths.runtime, { recursive: true });
    fs.writeFileSync(path.join(start.paths.runtime, "launch-question.json"), `${JSON.stringify({ ...text, answer, previous: previous?.version ?? null, at: new Date().toISOString() }, null, 2)}\n`);
  }
  if (answer === "back") {
    const committed = commitVerifiedRollback(start.paths, decision.version);
    if (committed.kind === "rolled-back") {
      const launched = await runPreviousInstaller(start.paths, committed.previous.file, committed.previous.sha512Hex);
      if (!launched) await shell.openExternal(RELEASES_PAGE).catch(() => undefined);
    } else {
      await shell.openExternal(RELEASES_PAGE).catch(() => undefined);
    }
  } else if (answer === "download") {
    await shell.openExternal(RELEASES_PAGE).catch(() => undefined);
  } else {
    retryLaunch(start.paths, decision.version);
    // The full application registers its schemes and takes its lock before the app is ready; a start that has shown a dialog is past that point.
    if (!start.testIdentity || (!scripted && process.env.MANGA_TEST_NO_RELAUNCH !== "1")) app.relaunch();
  }
  app.exit(0);
}

const outcome = evaluateBootstrapStart({
  packaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  argv: process.argv,
  env: process.env,
});
if (outcome.mode === "light") {
  load("light-main.cjs");
} else if (outcome.mode === "ask") {
  void ask(outcome.guarded, outcome.guarded.decision);
} else {
  if (outcome.attemptFile) process.env.MANGA_LAUNCH_ATTEMPT_FILE = outcome.attemptFile;
  // The rehearsal's stand-in for a version that does not start: only a test identity listens to it.
  if (outcome.failOnPurpose) app.exit(3);
  else load("full-main.cjs");
}
