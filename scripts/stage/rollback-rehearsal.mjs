import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { readBuildInfoIfPresent } from "./version-lib.mjs";

/**
 * `update-rollback` (4.2, LOOP-32), run by `stage installer` on its test identity: the release test identity has `previous` installed and
 * `next` installed over it. The way back is set up as an update would leave it (the previous installer kept with its SHA-512, the record of the
 * install, the backup taken before the update), and `next` is started with the test identity's failure switch:
 *
 * - two failed starts, the third asks; "再试一次" does not go back, and the count starts again;
 * - two more failed starts, the third asks again; "回到 <previous>" puts the backup back (the library in use kept under a new name), skips `next`,
 *   runs the kept installer and starts `previous` again, which records the rollback in its operation log.
 *
 * The question is answered from the environment (test identity only) and written to `runtime\launch-question.json`.
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha = (algorithm, file) => createHash(algorithm).update(fs.readFileSync(file)).digest("hex");
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };

/** Capture the real Win32 launch-failure dialog (`#32770`) of `pid` into `outFile` via `PrintWindow`, then close it (`cancelId` = "再试一次"). */
function captureAndDismissDialog(pid, outFile) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class WinCap {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr dpiContext);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out RECT pvAttribute, int cbAttribute);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
try { [void][WinCap]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch {}
[void][WinCap]::SetProcessDPIAware()
$targetPid = [uint32]$env:MANGA_DIALOG_PID
$found = [IntPtr]::Zero
for ($attempt = 0; $attempt -lt 120 -and $found -eq [IntPtr]::Zero; $attempt++) {
  [WinCap]::EnumWindows({
    param($hWnd, $lParam)
    if (-not [WinCap]::IsWindowVisible($hWnd)) { return $true }
    $winPid = [uint32]0
    [void][WinCap]::GetWindowThreadProcessId($hWnd, [ref]$winPid)
    if ($winPid -ne $targetPid) { return $true }
    $sb = New-Object System.Text.StringBuilder 64
    [void][WinCap]::GetClassName($hWnd, $sb, 64)
    if ($sb.ToString() -eq '#32770') { $script:found = $hWnd; return $false }
    return $true
  }, [IntPtr]::Zero) | Out-Null
  if ($found -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 100 }
}
if ($found -eq [IntPtr]::Zero) { exit 2 }
Start-Sleep -Milliseconds 250
$winRect = New-Object WinCap+RECT
[void][WinCap]::GetWindowRect($found, [ref]$winRect)
$extRect = New-Object WinCap+RECT
$dwmHr = [WinCap]::DwmGetWindowAttribute($found, 9, [ref]$extRect, [System.Runtime.InteropServices.Marshal]::SizeOf([type][WinCap+RECT]))
$fullW = [Math]::Max(1, $winRect.Right - $winRect.Left)
$fullH = [Math]::Max(1, $winRect.Bottom - $winRect.Top)
$fullBmp = New-Object System.Drawing.Bitmap($fullW, $fullH)
$gfx = [System.Drawing.Graphics]::FromImage($fullBmp)
$hdc = $gfx.GetHdc()
$ok = [WinCap]::PrintWindow($found, $hdc, 2)
$gfx.ReleaseHdc($hdc)
if (-not $ok) { $gfx.CopyFromScreen($winRect.Left, $winRect.Top, 0, 0, (New-Object System.Drawing.Size($fullW, $fullH))) }
$gfx.Dispose()
if ($dwmHr -eq 0 -and $extRect.Right -gt $extRect.Left -and $extRect.Bottom -gt $extRect.Top) {
  $cropX = [Math]::Max(0, $extRect.Left - $winRect.Left)
  $cropY = [Math]::Max(0, $extRect.Top - $winRect.Top)
  $cropW = [Math]::Min($fullW - $cropX, $extRect.Right - $extRect.Left)
  $cropH = [Math]::Min($fullH - $cropY, $extRect.Bottom - $extRect.Top)
  if ($cropW -gt 0 -and $cropH -gt 0) {
    $cropped = $fullBmp.Clone((New-Object System.Drawing.Rectangle($cropX, $cropY, $cropW, $cropH)), $fullBmp.PixelFormat)
    $cropped.Save($env:MANGA_DIALOG_OUT, [System.Drawing.Imaging.ImageFormat]::Png)
    $cropped.Dispose()
    $fullBmp.Dispose()
    [void][WinCap]::PostMessage($found, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
    exit 0
  }
}
$fullBmp.Save($env:MANGA_DIALOG_OUT, [System.Drawing.Imaging.ImageFormat]::Png)
$fullBmp.Dispose()
[void][WinCap]::PostMessage($found, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
`;
  const res = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, MANGA_DIALOG_PID: String(pid), MANGA_DIALOG_OUT: outFile },
    windowsHide: true,
    timeout: 30_000,
    encoding: "utf8",
  });
  return res.status === 0 && fs.existsSync(outFile) && fs.statSync(outFile).size > 0;
}

export async function rehearseRollback({ exe, installDir, appRoot, previousInstaller, previousVersion, nextVersion, env, schemaVersion, evidenceDir }) {
  const steps = [];
  const fail = (name, detail) => { steps.push({ name, ok: false, ...detail }); return { ok: false, steps }; };
  const runtime = path.join(appRoot, "runtime");
  const updater = path.join(appRoot, "cache", "updater");
  const data = path.join(appRoot, "data");
  const database = path.join(data, "manga.sqlite");
  if (!fs.existsSync(database)) return fail("update-rollback: the test identity has a library", {});
  if (readBuildInfoIfPresent(path.join(installDir, "resources"))?.version !== nextVersion) return fail("update-rollback: the newer version is installed", {});

  // What an update leaves behind (UpdateService.keepPreviousInstaller, the installer helper's record, the pre-migration backup before the schema upgrade).
  const keptDir = path.join(updater, "previous");
  fs.rmSync(keptDir, { recursive: true, force: true });
  fs.mkdirSync(keptDir, { recursive: true });
  const keptFile = `installer-${previousVersion}.exe`;
  fs.copyFileSync(previousInstaller, path.join(keptDir, keptFile));
  {
    const db0 = new Database(database);
    db0.pragma("wal_checkpoint(TRUNCATE)");
    db0.close();
  }
  const backup = path.join(appRoot, "backups", `manga.sqlite.preupdate-v${previousVersion}.sqlite`);
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.copyFileSync(database, backup);
  {
    const preupdateDb = new Database(backup);
    preupdateDb.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('rehearsalBackupKind', 'preupdate')").run();
    preupdateDb.pragma("wal_checkpoint(TRUNCATE)");
    preupdateDb.close();
  }
  const preupdateSha = sha("sha256", backup);
  const premigrate = `${database}.premigrate-v${schemaVersion}`;
  fs.copyFileSync(database, premigrate);
  {
    const premigrateDb = new Database(premigrate);
    premigrateDb.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('rehearsalBackupKind', 'premigrate')").run();
    premigrateDb.pragma("wal_checkpoint(TRUNCATE)");
    premigrateDb.close();
  }
  const backupSha = sha("sha256", premigrate);
  // Mutate the library in use as a schema upgrade to `schemaVersion + 1` would, so `currentSha !== backupSha` and `currentSha !== preupdateSha`.
  {
    const upgradedDb = new Database(database);
    upgradedDb.prepare("UPDATE schema_meta SET value = ? WHERE key = 'schemaVersion'").run(String(schemaVersion + 1));
    upgradedDb.pragma("wal_checkpoint(TRUNCATE)");
    upgradedDb.close();
  }
  const mutatedSha = sha("sha256", database);
  fs.writeFileSync(path.join(keptDir, "previous.json"), `${JSON.stringify({
    version: previousVersion, sha512Hex: sha("sha512", previousInstaller), file: keptFile, schemaVersion, targetVersion: nextVersion,
    // The rehearsal says the new version moved the library on, so going back puts the backup back.
    targetSchemaVersion: schemaVersion + 1, database, backup, keptAt: new Date().toISOString(),
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(updater, "last-installed.json"), `${JSON.stringify({ status: "installed", version: nextVersion, actualVersion: nextVersion })}\n`);
  for (const name of ["launch-history.json", "launch-attempt.json", "launch-question.json"]) fs.rmSync(path.join(runtime, name), { force: true });
  fs.rmSync(path.join(data, "update-skip.json"), { force: true });

  const start = (answer) => spawnSync(exe, [], {
    env: { ...env, MANGA_TEST_FAIL_LAUNCH: nextVersion, MANGA_WINDOW_HIDDEN: "1", ...(answer ? { MANGA_TEST_LAUNCH_ANSWER: answer } : {}) },
    windowsHide: true, timeout: 120_000,
  });
  const question = () => readJson(path.join(runtime, "launch-question.json"));

  // Two failed starts, then the question; "try again" stays. When `evidenceDir` is given, capture the real Win32 dialog before dismissing it.
  const failed = [start(), start()].map((result) => result.status);
  let askedStatus = null;
  let dialogShot = true;
  if (evidenceDir) {
    const outFile = path.join(evidenceDir, "screenshots", "ui-launch-guard-dialog.png");
    const childEnv = { ...env, MANGA_TEST_FAIL_LAUNCH: nextVersion, MANGA_TEST_NO_RELAUNCH: "1" };
    delete childEnv.MANGA_TEST_LAUNCH_ANSWER;
    delete childEnv.MANGA_WINDOW_HIDDEN;
    const child = spawn(exe, [], { env: childEnv, windowsHide: false, stdio: "ignore" });
    const exited = new Promise((resolve) => child.once("close", (code) => resolve(code)));
    dialogShot = captureAndDismissDialog(child.pid, outFile);
    if (!dialogShot && alive(child.pid)) { try { child.kill(); } catch { /* gone */ } }
    askedStatus = await Promise.race([exited, sleep(15_000).then(() => null)]);
  } else {
    askedStatus = start("retry").status;
  }
  const retried = question();
  const history = readJson(path.join(runtime, "launch-history.json"));
  const retryOk = failed.every((status) => status === 3) && dialogShot && askedStatus === 0 && retried?.answer === "retry"
    && retried.message === `MANGA ${nextVersion} 上次没能正常启动。` && JSON.stringify(retried.buttons) === JSON.stringify([`回到 ${previousVersion}`, "再试一次", "打开下载页"])
    && history?.failures === 0 && readBuildInfoIfPresent(path.join(installDir, "resources"))?.version === nextVersion && !fs.existsSync(path.join(data, "update-skip.json"))
    && mutatedSha !== backupSha && backupSha !== preupdateSha && sha("sha256", database) === mutatedSha;
  steps.push({ name: "update-rollback: two failed starts ask; 再试一次 keeps the new version", ok: retryOk, failed, asked: askedStatus, dialogShot, answer: retried?.answer ?? null, buttons: retried?.buttons ?? null });
  if (!retryOk) return { ok: false, steps };

  // Two more, then "back".
  fs.rmSync(path.join(runtime, "launch-question.json"), { force: true });
  const failedAgain = [start(), start()].map((result) => result.status);
  const currentSha = sha("sha256", database);
  const back = start("back");
  // Read before the kept installer finishes and the previous version opens the library again.
  const restored = currentSha !== backupSha && backupSha !== preupdateSha && fs.existsSync(database) && sha("sha256", database) === backupSha;
  const answered = question();
  // The kept installer runs once this process is gone and then starts the previous version.
  let reinstalled = false;
  for (let waited = 0; waited < 180_000; waited += 500) {
    if (readBuildInfoIfPresent(path.join(installDir, "resources"))?.version === previousVersion) { reinstalled = true; break; }
    await sleep(500);
  }
  let relaunched = null;
  for (let waited = 0; reinstalled && waited < 90_000; waited += 300) {
    const instance = readJson(path.join(runtime, "running-instance.json"));
    if (instance?.state === "ready" && instance.version === previousVersion && alive(instance.pid)) { relaunched = instance; break; }
    await sleep(300);
  }
  // The previous version put the rollback in its operation log and removed the note.
  let recorded = false;
  for (let waited = 0; relaunched && waited < 20_000; waited += 200) {
    if (!fs.existsSync(path.join(data, "rollback-record.json"))) { recorded = true; break; }
    await sleep(200);
  }
  const keptAs = fs.readdirSync(data).filter((name) => name.startsWith("manga.sqlite.rolledback-") && !/-(wal|shm)$/.test(name));
  const skipped = readJson(path.join(data, "update-skip.json"));
  const backOk = failedAgain.every((status) => status === 3) && back.status === 0 && answered?.answer === "back" && restored && reinstalled && Boolean(relaunched) && recorded
    && keptAs.length === 1 && currentSha !== backupSha && sha("sha256", path.join(data, keptAs[0])) === currentSha && skipped?.version === nextVersion
    && !fs.existsSync(path.join(updater, "last-installed.json"));
  steps.push({
    name: `update-rollback: 回到 ${previousVersion} reinstalls it, puts the backup back, keeps the library in use, skips ${nextVersion} and logs it`,
    ok: backOk, failedAgain, back: back.status, answer: answered?.answer ?? null, reinstalled, relaunched: Boolean(relaunched), recorded, keptAs: keptAs.length,
    skipped: skipped?.version ?? null, restored,
  });
  if (relaunched?.pid && alive(relaunched.pid)) {
    try { process.kill(relaunched.pid); } catch { /* gone */ }
    for (let waited = 0; waited < 15_000 && alive(relaunched.pid); waited += 200) await sleep(200);
  }
  return { ok: steps.every((item) => item.ok), steps };
}
