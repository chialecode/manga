import { spawnSync } from "node:child_process";

/**
 * LOOP-13: `stage bench` asks Windows not to slow its own Node process down for power (`SetProcessInformation(ProcessPowerThrottling)` with the
 * execution-speed bit controlled and off), the process the service-layer figures (the scan, the call trace, the search) are measured in. Left to
 * Windows, a process whose window is not in front runs about three times slower on this kind of machine. The bench windows do the same for their
 * own processes (apps/desktop/src/main/smoke/power-throttling.ts). Only the bench calls this; the product never does. Answers whether it was done.
 */
export function benchProcessNoThrottle(pid = process.pid) {
  if (process.platform !== "win32") return false;
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MangaBenchThrottling {
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
[Console]::Out.WriteLine([MangaBenchThrottling]::Off(${Number(pid)}))
`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
  return result.status === 0 && String(result.stdout).trim() === "True";
}
