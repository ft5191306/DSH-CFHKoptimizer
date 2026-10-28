# Capture the DSH main window at native (DPI-aware) resolution.
# Usage: pwsh -File _tools\shot.ps1 -Out <png path>
param(
  [string]$Out = "C:\Users\Administrator\dsh-plugins\cf-pin\_shots\_live.png",
  [int]$ProcId = 0
)

Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W32 {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@

# PER_MONITOR_AWARE_V2 = -4
[void][W32]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))

$procs = if ($ProcId -ne 0) {
  Get-Process -Id $ProcId -ErrorAction Stop
} else {
  Get-Process | Where-Object { $_.ProcessName -eq 'DeepSeek Harness' -and $_.MainWindowHandle -ne 0 }
}
$p = $procs | Where-Object { $_.MainWindowTitle } | Select-Object -First 1
if (-not $p) { $p = $procs | Select-Object -First 1 }
if (-not $p) { throw "no DSH window process found" }

$h = $p.MainWindowHandle
if ($h -eq 0) { throw "process $($p.Id) has no main window handle" }

if ([W32]::IsIconic($h)) { [void][W32]::ShowWindow($h, 9); Start-Sleep -Milliseconds 700 }
[void][W32]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 500

$r = New-Object W32+RECT
[void][W32]::GetWindowRect($h, [ref]$r)
if ($r.L -eq -32000) { throw "window still minimized (rect -32000)" }
$w = $r.R - $r.L; $ht = $r.B - $r.T
if ($w -le 0 -or $ht -le 0) { throw "bad rect $($r.L),$($r.T),$($r.R),$($r.B)" }

# park the cursor away from hover-sensitive UI before grabbing
[void][W32]::SetCursorPos($r.L + 20, $r.T + 600)
Start-Sleep -Milliseconds 350

$bmp = New-Object System.Drawing.Bitmap $w, $ht
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.L, $r.T, 0, 0, (New-Object System.Drawing.Size $w, $ht))
$g.Dispose()
$dir = Split-Path -Parent $Out
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

"pid=$($p.Id) hwnd=$h rect=$($r.L),$($r.T) size=${w}x${ht} out=$Out"
