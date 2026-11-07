import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

/**
 * LOOP-13: a benchmark window asks Windows not to slow its processes down for power (`SetProcessInformation(ProcessPowerThrottling)` with the
 * execution-speed bit controlled and off), so a figure does not depend on which application is in front. Only a bench phase does this, and only
 * when `stage bench` asks (`MANGA_BENCH_NO_THROTTLE=1`); the product never does. The call goes through PowerShell's `Add-Type`; the processes of
 * the application (the GPU and renderer processes come later) are taken again every two seconds. What was done is written to the logs.
 */
const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MangaPowerThrottling {
  [StructLayout(LayoutKind.Sequential)] public struct State { public uint Version; public uint ControlMask; public uint StateMask; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetProcessInformation(IntPtr process, int infoClass, ref State info, int size);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static bool Off(int pid) {
    IntPtr handle = OpenProcess(0x0200, false, pid);
    if (handle == IntPtr.Zero) return false;
    try {
      State state = new State { Version = 1, ControlMask = 1, StateMask = 0 };
      return SetProcessInformation(handle, 4, ref state, Marshal.SizeOf(typeof(State)));
    } finally { CloseHandle(handle); }
  }
}
'@
foreach ($line in [Console]::In.ReadToEnd().Split([Environment]::NewLine, [StringSplitOptions]::RemoveEmptyEntries)) {
  $id = [int]$line
  [Console]::Out.WriteLine("$id " + [MangaPowerThrottling]::Off($id))
}
`;

function turnOff(pids: number[]): Promise<Map<number, boolean>> {
  return new Promise((resolve) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", SCRIPT], { windowsHide: true });
    let out = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { out += chunk; });
    child.on("error", () => resolve(new Map()));
    child.on("close", () => {
      const done = new Map<number, boolean>();
      for (const line of out.split(/\r?\n/)) {
        const [id, ok] = line.trim().split(" ");
        if (id && ok) done.set(Number(id), ok === "True");
      }
      resolve(done);
    });
    child.stdin.end(pids.join("\n"));
  });
}

/** Starts the opt-out when this is a bench phase that asked for it; returns a stop function (it writes what was done). */
export function benchPowerThrottlingOff(phase: string, logsDir: string): () => void {
  if (process.platform !== "win32" || !phase.startsWith("bench") || process.env.MANGA_BENCH_NO_THROTTLE !== "1") return () => undefined;
  const handled = new Map<number, boolean>();
  let busy = false;
  const round = async () => {
    if (busy) return;
    busy = true;
    try {
      const fresh = [process.pid, ...app.getAppMetrics().map((metric) => metric.pid)].filter((pid, index, all) => !handled.has(pid) && all.indexOf(pid) === index);
      if (fresh.length) for (const [pid, ok] of await turnOff(fresh)) handled.set(pid, ok);
    } finally { busy = false; }
  };
  void round();
  const timer = setInterval(() => { void round(); }, 2000);
  return () => {
    clearInterval(timer);
    const values = [...handled.values()];
    try {
      fs.mkdirSync(logsDir, { recursive: true });
      fs.writeFileSync(path.join(logsDir, `power-throttling-${phase}.json`), `${JSON.stringify({ phase, processes: values.length, off: values.filter(Boolean).length }, null, 2)}\n`);
    } catch { /* the figure is only a note */ }
  };
}
