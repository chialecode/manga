import { spawnSync } from "node:child_process";
import path from "node:path";

export const UNINSTALL_KEY = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall";

/** Whether a process with `pid` is currently alive (treating EPERM as alive). */
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && error.code === "EPERM");
  }
}

/** Best-effort termination of a spawned child process or PID without throwing if already gone. */
export function killProcessTreeBestEffort(target) {
  if (!target) return;
  if (typeof target === "number") {
    if (isProcessAlive(target)) {
      try { process.kill(target); } catch { /* gone */ }
    }
    return;
  }
  try {
    if (typeof target.kill === "function" && target.exitCode === null) target.kill();
    else if (Number.isInteger(target.pid) && isProcessAlive(target.pid)) process.kill(target.pid);
  } catch { /* gone */ }
}

/**
 * Read current-user Windows Uninstall registry entries.
 * Returns normalized records with `Key`, `DisplayName`, `DisplayVersion`, `Publisher`, `DisplayIcon`, `InstallLocation`, `UninstallString`, and `command`.
 */
export function readUninstallRegistryEntries({ filterNames, throwOnError = false, timeoutMs = 30_000 } = {}) {
  if (process.platform !== "win32") return [];
  const cmd = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; if (Test-Path -LiteralPath '${UNINSTALL_KEY}') { Get-ChildItem '${UNINSTALL_KEY}' -ErrorAction SilentlyContinue | ForEach-Object { $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue; if ($p -and $p.DisplayName) { [pscustomobject]@{ Key = $_.PSChildName; DisplayName = [string]$p.DisplayName; DisplayVersion = [string]$p.DisplayVersion; Publisher = [string]$p.Publisher; DisplayIcon = [string]$p.DisplayIcon; InstallLocation = [string]$p.InstallLocation; UninstallString = [string]$p.UninstallString } } } | ConvertTo-Json -Compress }`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd], {
    encoding: "utf8",
    windowsHide: true,
    timeout: timeoutMs,
  });
  if (result.status !== 0) {
    if (!throwOnError) return [];
    const reason = result.error ? String(result.error.message) : `exit ${result.status ?? result.signal}`;
    const detail = typeof result.stderr === "string" ? result.stderr.trim().split(/\r?\n/)[0]?.slice(0, 200) : "";
    throw new Error(`unable to inspect Windows installation state (${reason}${detail ? `: ${detail}` : ""})`);
  }
  const text = typeof result.stdout === "string" ? result.stdout.trim() : "";
  if (!text) return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    if (throwOnError) throw new Error("invalid Windows installation state");
    return [];
  }
  const entries = (Array.isArray(parsed) ? parsed : [parsed]).map((entry) => {
    const uninstallString = String(entry.UninstallString ?? "");
    const command = uninstallString.replace(/^"([^"]+)".*$/, "$1");
    const installLocation = entry.InstallLocation ? String(entry.InstallLocation) : command ? path.dirname(command) : "";
    return {
      Key: String(entry.Key ?? ""),
      DisplayName: String(entry.DisplayName ?? ""),
      DisplayVersion: String(entry.DisplayVersion ?? ""),
      Publisher: String(entry.Publisher ?? ""),
      DisplayIcon: String(entry.DisplayIcon ?? ""),
      InstallLocation: installLocation,
      UninstallString: uninstallString,
      command,
    };
  });
  if (Array.isArray(filterNames) && filterNames.length > 0) {
    const allowed = new Set(filterNames);
    return entries.filter((entry) => allowed.has(entry.DisplayName));
  }
  return entries;
}
