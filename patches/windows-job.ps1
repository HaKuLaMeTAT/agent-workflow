# A kill-on-close Job Object owns the provider tree, including orphan descendants.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class AwJob {
  [StructLayout(LayoutKind.Sequential)] struct Basic {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] struct IO {
    public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
    public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)] struct Extended {
    public Basic BasicLimitInformation;
    public IO IoInfo;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attrs, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref Extended info, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  // Intentionally retained until process exit; not inherited by children.
  static IntPtr job;
  public static void Enter() {
    job=CreateJobObject(IntPtr.Zero,null);
    if(job==IntPtr.Zero)throw new Win32Exception();
    var info=new Extended(); info.BasicLimitInformation.LimitFlags=0x2000;
    if(!SetInformationJobObject(job,9,ref info,(uint)Marshal.SizeOf(info)))throw new Win32Exception();
    if(!AssignProcessToJobObject(job,GetCurrentProcess()))throw new Win32Exception();
  }
}
'@
[AwJob]::Enter()
$owner = [Diagnostics.Process]::GetProcessById([int]$env:AW_JOB_OWNER)
$null = $owner.Handle
$info = New-Object Diagnostics.ProcessStartInfo
$info.FileName = $env:AW_JOB_NODE
$info.Arguments = '"' + $env:AW_JOB_RUNNER + '" --windows-child "' + $env:AW_JOB_PLAN + '"'
$info.UseShellExecute = $false
$child = [Diagnostics.Process]::Start($info)
while (-not $child.WaitForExit(100)) {
  if ($owner.HasExited) { exit 1 }
}
exit $child.ExitCode
