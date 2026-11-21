import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Shared Windows detached PowerShell installer launcher (Node built-ins only so `bootstrap.ts`
 * and `index.ts` share the exact SHA-512 verification, `readyFile` handshake, and `cancelFile`
 * abort protocol without pulling app-core into the bootstrap bundle).
 */

export type DetachedHelperHandle =
  | { ok: true; cancelFile: string; cancel: () => void }
  | { ok: false };

function removeQuietly(file: string): void {
  try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
}

/**
 * Launches a hidden detached Windows PowerShell helper via `Start-Process` and waits until the
 * helper verifies its inputs and writes `readyFile` with its live PID.
 */
async function launchDetachedPowerShell(input: {
  attemptId: string;
  planFile: string;
  readyFile: string;
  cancelFile: string;
  planEnvVar: string;
  scriptEnvVar: string;
  script: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  cleanupOnSpawnFailure?: boolean;
}): Promise<DetachedHelperHandle> {
  // PowerShell cannot run with DETACHED_PROCESS here; a directly attached child is killed by Node's
  // Windows job when the app exits. Start-Process launches the hidden helper independently.
  const outer = `Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList @('-NoProfile','-NonInteractive','-WindowStyle','Hidden','-EncodedCommand',$env:${input.scriptEnvVar}) -WindowStyle Hidden`;
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", outer], {
    detached: false,
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...input.env,
      [input.planEnvVar]: input.planFile,
      [input.scriptEnvVar]: Buffer.from(input.script, "utf16le").toString("base64"),
    },
  });
  let outerFailed = false;
  child.once("exit", (code) => { outerFailed = code !== 0; });
  const started = await new Promise<boolean>((resolve) => {
    child.once("error", () => resolve(false));
    child.once("spawn", () => resolve(true));
  });
  if (!started) {
    if (input.cleanupOnSpawnFailure) {
      for (const file of [input.planFile, input.readyFile, input.cancelFile]) removeQuietly(file);
    }
    return { ok: false };
  }
  const deadline = Date.now() + input.timeoutMs;
  let prepared = false;
  while (!outerFailed && Date.now() < deadline) {
    try {
      const ready = JSON.parse(fs.readFileSync(input.readyFile, "utf8")) as { attemptId?: string; helperPid?: number };
      if (ready.attemptId === input.attemptId && Number.isSafeInteger(ready.helperPid) && (ready.helperPid ?? 0) > 0) {
        process.kill(ready.helperPid!, 0);
        prepared = true;
        break;
      }
    } catch { /* preparation is still in progress */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const cancel = () => {
    try { fs.writeFileSync(input.cancelFile, "cancelled"); } catch { /* best effort */ }
  };
  if (outerFailed || !prepared) {
    cancel();
    child.unref();
    return { ok: false };
  }
  child.unref();
  return { ok: true, cancelFile: input.cancelFile, cancel };
}

/**
 * Starts the detached rollback helper that waits for the current process to exit, re-verifies the
 * previous installer's SHA-512, installs it silently, and relaunches the app.
 * Callers can invoke `handle.cancel()` if DB rollback fails before exiting.
 */
export async function startRollbackInstaller(input: {
  runtimeDir: string;
  installer: string;
  sha512Hex: string;
  execPath?: string;
}): Promise<DetachedHelperHandle> {
  try {
    fs.mkdirSync(input.runtimeDir, { recursive: true });
    const exePath = input.execPath ?? process.execPath;
    const attemptId = `rollback_${process.pid}_${Date.now()}`;
    const planFile = path.join(input.runtimeDir, `${attemptId}.plan.json`);
    const readyFile = path.join(input.runtimeDir, `${attemptId}.ready.json`);
    const cancelFile = path.join(input.runtimeDir, `${attemptId}.cancel`);
    const plan = {
      attemptId,
      pid: process.pid,
      installer: input.installer,
      sha512Hex: input.sha512Hex.toLowerCase(),
      installDir: path.dirname(exePath),
      exePath,
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
    const helperEnv: NodeJS.ProcessEnv = { ...process.env };
    delete helperEnv.MANGA_TEST_FAIL_LAUNCH;
    delete helperEnv.MANGA_TEST_LAUNCH_ANSWER;
    delete helperEnv.MANGA_LAUNCH_ATTEMPT_FILE;
    return await launchDetachedPowerShell({
      attemptId,
      planFile,
      readyFile,
      cancelFile,
      planEnvVar: "MANGA_ROLLBACK_PLAN",
      scriptEnvVar: "MANGA_ROLLBACK_SCRIPT",
      script,
      timeoutMs: 15_000,
      env: helperEnv,
      cleanupOnSpawnFailure: true,
    });
  } catch {
    return { ok: false };
  }
}

/** Removes stale `update-install_*` plan/ready/cancel artifacts left by prior attempts. */
export function pruneStaleUpdateHelperFiles(updaterDir: string): void {
  if (!fs.existsSync(updaterDir)) return;
  try {
    for (const entry of fs.readdirSync(updaterDir, { withFileTypes: true })) {
      if (entry.isFile() && /^update-install_[\da-f-]+\.(?:json|ready|cancel)$/.test(entry.name)) {
        removeQuietly(path.join(updaterDir, entry.name));
      }
    }
  } catch { /* best effort */ }
}

/**
 * Starts the detached update installer helper for `restart` or `quit` modes.
 * Clears `MANGA_INSTALL_*` env vars before relaunching, gates `-WindowStyle Hidden` on
 * `MANGA_WINDOW_HIDDEN=1`, and prunes stale artifacts from prior attempts before writing new ones.
 */
export async function startUpdateInstaller(input: {
  updaterDir: string;
  attemptId: string;
  installerPath: string;
  mode: "restart" | "quit";
  expectedSha512Base64: string;
  targetVersion: string | null;
  relaunchArgs: string[];
  execPath?: string;
}): Promise<DetachedHelperHandle> {
  try {
    const exePath = input.execPath ?? process.execPath;
    const installDir = path.dirname(exePath);
    fs.mkdirSync(input.updaterDir, { recursive: true });
    pruneStaleUpdateHelperFiles(input.updaterDir);
    const planFile = path.join(input.updaterDir, `${input.attemptId}.json`);
    const readyFile = path.join(input.updaterDir, `${input.attemptId}.ready`);
    const cancelFile = path.join(input.updaterDir, `${input.attemptId}.cancel`);
    const doneFile = path.join(input.updaterDir, "last-installed.json");
    removeQuietly(doneFile);
    fs.writeFileSync(
      planFile,
      `${JSON.stringify({
        pid: process.pid,
        installerPath: input.installerPath,
        installDir,
        exePath,
        mode: input.mode,
        attemptId: input.attemptId,
        version: input.targetVersion,
        sha512Hex: Buffer.from(input.expectedSha512Base64, "base64").toString("hex"),
        doneFile,
        readyFile,
        cancelFile,
        relaunchArgs: input.relaunchArgs,
      }, null, 2)}\n`,
    );
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$planFile = $env:MANGA_INSTALL_PLAN",
      "Remove-Item Env:MANGA_INSTALL_PLAN -ErrorAction SilentlyContinue",
      "Remove-Item Env:MANGA_INSTALL_SCRIPT -ErrorAction SilentlyContinue",
      "$plan = Get-Content -LiteralPath $planFile -Raw -Encoding UTF8 | ConvertFrom-Json",
      "$code = 1; $actualVersion = $null; $installed = $false; $failureStage = 'prepare'; $errorType = $null",
      "try {",
      // The caller may be PowerShell 7, whose inherited module path omits Windows
      // PowerShell's Get-FileHash function. Load the helper's own system module.
      "  Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop",
      "  if ((Get-FileHash -LiteralPath $plan.installerPath -Algorithm SHA512).Hash.ToLowerInvariant() -ne $plan.sha512Hex) { throw 'installer changed' }",
      "  $ready = @{ attemptId = $plan.attemptId; helperPid = $PID } | ConvertTo-Json -Compress",
      "  [System.IO.File]::WriteAllText([string]$plan.readyFile, [string]$ready, (New-Object System.Text.UTF8Encoding($false)))",
      "  $failureStage = 'wait-for-exit'",
      "  for ($i = 0; $i -lt 400; $i++) {",
      "    if (Test-Path -LiteralPath $plan.cancelFile) { throw 'installation cancelled' }",
      "    if (-not (Get-Process -Id $plan.pid -ErrorAction SilentlyContinue)) { break }",
      "    Start-Sleep -Milliseconds 100",
      "  }",
      "  if (Get-Process -Id $plan.pid -ErrorAction SilentlyContinue) { throw 'old application still running' }",
      "  if (Test-Path -LiteralPath $plan.cancelFile) { throw 'installation cancelled' }",
      "  $failureStage = 'verify-installer'",
      "  if ((Get-FileHash -LiteralPath $plan.installerPath -Algorithm SHA512).Hash.ToLowerInvariant() -ne $plan.sha512Hex) { throw 'installer changed' }",
      "  if (Test-Path -LiteralPath $plan.cancelFile) { throw 'installation cancelled' }",
      "  $failureStage = 'install'",
      "  $p = Start-Process -FilePath $plan.installerPath -ArgumentList @('--updated', '/S', ('/D=' + $plan.installDir)) -Wait -PassThru -WindowStyle Hidden",
      "  $code = $p.ExitCode",
      "  $failureStage = 'inspect-installed-version'",
      "  $actualVersion = (Get-Content -LiteralPath (Join-Path $plan.installDir 'resources/build.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version",
      "  $installed = $code -eq 0 -and $actualVersion -eq $plan.version -and (Test-Path -LiteralPath $plan.exePath)",
      "} catch { $code = 1; $errorType = $_.Exception.GetType().FullName }",
      "$done = @{ attemptId = $plan.attemptId; status = if ($installed) { 'installed' } else { 'failed' }; exitCode = $code; version = $plan.version; actualVersion = $actualVersion; mode = $plan.mode; installerSha512Hex = $plan.sha512Hex; failureStage = if ($installed) { $null } else { $failureStage }; errorType = $errorType; completedAt = (Get-Date).ToString('o') } | ConvertTo-Json -Compress",
      "[System.IO.File]::WriteAllText([string]$plan.doneFile, [string]$done, (New-Object System.Text.UTF8Encoding($false)))",
      "if ($plan.mode -eq 'restart' -and -not (Test-Path -LiteralPath $plan.cancelFile) -and -not (Get-Process -Id $plan.pid -ErrorAction SilentlyContinue) -and (Test-Path -LiteralPath $plan.exePath)) {",
      "  $hidden = $env:MANGA_WINDOW_HIDDEN -eq '1'",
      "  if ($plan.relaunchArgs -and $plan.relaunchArgs.Count -gt 0) {",
      "    if ($hidden) { Start-Process -FilePath $plan.exePath -ArgumentList $plan.relaunchArgs -WindowStyle Hidden }",
      "    else { Start-Process -FilePath $plan.exePath -ArgumentList $plan.relaunchArgs }",
      "  } else {",
      "    if ($hidden) { Start-Process -FilePath $plan.exePath -WindowStyle Hidden }",
      "    else { Start-Process -FilePath $plan.exePath }",
      "  }",
      "}",
    ].join("; ");
    return await launchDetachedPowerShell({
      attemptId: input.attemptId,
      planFile,
      readyFile,
      cancelFile,
      planEnvVar: "MANGA_INSTALL_PLAN",
      scriptEnvVar: "MANGA_INSTALL_SCRIPT",
      script,
      timeoutMs: 8_000,
      env: process.env,
    });
  } catch {
    return { ok: false };
  }
}
