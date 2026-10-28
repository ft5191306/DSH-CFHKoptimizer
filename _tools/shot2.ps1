# Capture a specific window's content even when occluded, via PrintWindow(PW_RENDERFULLCONTENT).
# Usage: pwsh -File _tools\shot2.ps1 -Out <png> [-TitleLike '*DeepSeek*']
param(
  [string]$Out = "C:\Users\Administrator\dsh-plugins\cf-pin\_shots\_win.png",
  [string]$TitleLike = '*DeepSeek*'
)

Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W32B {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@

[void][W32B]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))

$p = Get-Process | Where-Object { $_.ProcessName -eq 'DeepSeek Harness' -and $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like $TitleLike } |
     Select-Object -First 1
if (-not $p) { throw "no window matching $TitleLike" }
$h = $p.MainWindowHandle

$r = New-Object W32B+RECT
[void][W32B]::GetWindowRect($h, [ref]$r)
$w = $r.R - $r.L; $ht = $r.B - $r.T
if ($w -le 0 -or $ht -le 0) { throw "bad window of '$($p.MainWindowTitle)' -> $w x $ht" }

$bmp = New-Object System.Drawing.Bitmap $w, $ht
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
# 2 = PW_RENDERFULLCONTENT (captures DirectComposition/Chromium content)
$okB = [W32B]::PrintWindow($h, $hdc, 2)
if (-not $okB) {
  $okB = [W32B]::PrintWindow($h, $hdc, 0)
}
$g.ReleaseHdc($hdc)
$g.Dispose()

$dir = Split-Path -Parent $Out
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

$dpi = [W32B]::GetDpiForWindow($h)
"title='$($p.MainWindowTitle)' hwnd=$h rect=$($r.L),$($r.T) size=${w}x${ht} dpi=$dpi printOk=$okB out=$Out"
