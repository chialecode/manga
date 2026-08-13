param(
  [Parameter(Mandatory = $true)][int]$ParentPid,
  [Parameter(Mandatory = $true)][int]$ChildPid
)

$source = @'
using System;
using System.Runtime.InteropServices;

public static class JobObjectNative {
  [StructLayout(LayoutKind.Sequential)]
  public struct BasicLimits {
    public long PerProcessUserTimeLimit;
    public long PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass;
    public uint SchedulingClass;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct IoCounters {
    public ulong ReadOperationCount;
    public ulong WriteOperationCount;
    public ulong OtherOperationCount;
    public ulong ReadTransferCount;
    public ulong WriteTransferCount;
    public ulong OtherTransferCount;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct ExtendedLimits {
    public BasicLimits BasicLimitInformation;
    public IoCounters IoInfo;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr CreateJobObject(IntPtr attributes, string name);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool TerminateJobObject(IntPtr job, uint exitCode);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

  [DllImport("kernel32.dll")]
  public static extern bool CloseHandle(IntPtr handle);
}
'@

Add-Type -TypeDefinition $source
$job = [JobObjectNative]::CreateJobObject([IntPtr]::Zero, $null)
if ($job -eq [IntPtr]::Zero) { throw "CreateJobObject failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }

$child = [JobObjectNative]::OpenProcess(0x1F0FFF, $false, $ChildPid)
$parent = [JobObjectNative]::OpenProcess(0x00100000, $false, $ParentPid)
if ($child -eq [IntPtr]::Zero -or $parent -eq [IntPtr]::Zero) { throw 'OpenProcess failed' }

$limits = New-Object JobObjectNative+ExtendedLimits
$limits.BasicLimitInformation.LimitFlags = 0x00002000
$size = [Runtime.InteropServices.Marshal]::SizeOf($limits)
$pointer = [Runtime.InteropServices.Marshal]::AllocHGlobal($size)
try {
  [Runtime.InteropServices.Marshal]::StructureToPtr($limits, $pointer, $false)
  if (-not [JobObjectNative]::SetInformationJobObject($job, 9, $pointer, $size)) { throw 'SetInformationJobObject failed' }
  if (-not [JobObjectNative]::AssignProcessToJobObject($job, $child)) { throw 'AssignProcessToJobObject failed' }
  [Console]::Out.WriteLine('assigned')
  [Console]::Out.Flush()
  [void][JobObjectNative]::WaitForSingleObject($parent, [uint32]::MaxValue)
  if (-not [JobObjectNative]::TerminateJobObject($job, 1)) { throw 'TerminateJobObject failed' }
} finally {
  [Runtime.InteropServices.Marshal]::FreeHGlobal($pointer)
  [void][JobObjectNative]::CloseHandle($child)
  [void][JobObjectNative]::CloseHandle($parent)
  [void][JobObjectNative]::CloseHandle($job)
}
