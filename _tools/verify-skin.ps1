# 重启后验证两套皮肤真的画出来了。
#
# 静态检查已经骗过一次：`fill` 写成属性、mask id 每帧自增，两处都能通过
# `node --check` 和单测，但真实渲染是「整块消失 / 一闪而过」。所以这里只看像素：
#   1. 图标区域必须有明显亮于背景的像素（有东西被画出来，且不是退回黑色）
#   2. 包围盒接近正方形（单图标），而不是宽扁横排（旧三格）
param(
  [string]$Out = "C:\Users\Administrator\dsh-plugins\cf-pin\_shots\_verify-ring.png"
)
$ErrorActionPreference = 'Stop'

& pwsh -NoProfile -File "C:\Users\Administrator\dsh-plugins\cf-pin\_tools\shot2.ps1" `
  -Out $Out -TitleLike '*DeepSeek*'
if ($LASTEXITCODE -ne 0) { throw "screenshot failed" }

$py = "C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\python\python.exe"
if (-not (Test-Path $py)) { $py = "python" }

$script = @'
import sys
import numpy as np
from PIL import Image

path = sys.argv[1]
a = np.asarray(Image.open(path).convert("RGB")).astype(np.int16)
H, W, _ = a.shape
S = 2.0
BG = np.array([21, 21, 23])

# 图标在输入卡片上方那一条带里。收窄到「下 25%、左 65%」避开右侧按钮与状态行。
y0, y1 = int(H * 0.70), int(H * 0.90)
x0, x1 = int(W * 0.10), int(W * 0.65)
band = a[y0:y1, x0:x1]

delta = band - BG
bright = (delta.sum(axis=2) > 45) & (band.max(axis=2) > 45)
ys, xs = np.nonzero(bright)

if len(xs) == 0:
    bright = delta.sum(axis=2) > 22
    ys, xs = np.nonzero(bright)
if len(xs) == 0:
    print("FAIL: 图标区域完全没有非背景像素 —— 整块没画出来")
    sys.exit(2)

bx0, bx1 = xs.min(), xs.max()
by0, by1 = ys.min(), ys.max()
w = (bx1 - bx0 + 1) / S
h = (by1 - by0 + 1) / S
print(f"图标包围盒: x {(x0+bx0)/S:.1f}..{(x0+bx1)/S:.1f} css, y {(y0+by0)/S:.1f}..{(y0+by1)/S:.1f} css")
print(f"尺寸: {w:.1f} x {h:.1f} css px")
print(f"非背景像素: {len(xs)}")

peak = int(band[bright].max())
mean = float(band[bright].mean())
print(f"亮度: 峰值 {peak}, 均值 {mean:.0f}  (背景 {int(BG.max())})")

ratio = w / h if h > 0 else 99
print(f"宽高比 w/h = {ratio:.2f}")

ok = True
if peak <= 60:
    print("FAIL: 最亮像素几乎等于背景 —— 颜色没生效（很可能退回黑色）")
    ok = False
if ratio > 2.4:
    print("FAIL: 宽高比过大，看起来还是三格横排")
    ok = False
if 0.6 <= ratio <= 1.9 and peak > 60:
    print("PASS: 接近正方形且足够亮 —— 单图标皮肤已渲染")

sys.exit(0 if ok else 1)
'@

$tmp = Join-Path $env:TEMP "cfpin-verify-skin.py"
Set-Content -Path $tmp -Value $script -Encoding UTF8
& $py $tmp $Out
exit $LASTEXITCODE
