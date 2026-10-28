# 重启后验证：点击图标是否真的触发了 scan → apply。
#
# 这是本轮最关键的一次验证。前几次我都只用单测里的「模拟点击」证明按钮挂了
# onClick，但用户实测点击**什么都没发生**——那说明单测覆盖不到真实链路。
#
# 做法：直接调 /scan 与 /apply 这两个接口，看它们是否真的开始干活，
# 而不是被缓存或「已是最优」挡回。
param(
  [string]$Base = ""
)
$ErrorActionPreference = 'Stop'

if ($Base -eq "") {
  # 从运行中的 DSH 取端口：GUI URL 就是这个宿主
  $Base = "http://127.0.0.1:61541"
}

Write-Host "== 探测宿主端口 =="
$ports = @()
foreach ($p in 61500..61600) {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$p/" -TimeoutSec 1 -UseBasicParsing -ErrorAction Stop
    $ports += $p
  } catch {
    if ($_.Exception.Response -ne $null) { $ports += $p }
  }
}
Write-Host ("候选端口: " + ($ports -join ', '))

function Call-Api($port, $path, $body) {
  $json = if ($body -eq $null) { '{}' } else { ($body | ConvertTo-Json -Compress) }
  try {
    $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/dsh-cf-pin/$path" `
      -Method Post -Body $json -ContentType 'application/json' `
      -TimeoutSec 120 -UseBasicParsing -ErrorAction Stop
    return ($resp.Content | ConvertFrom-Json)
  } catch {
    return @{ __status = $_.Exception.Response.StatusCode.value__; __error = $_.Exception.Message }
  }
}

$ok = $false
foreach ($port in $ports) {
  Write-Host "`n== 试端口 $port =="
  $state = Call-Api $port 'state' $null
  if ($state.__status -ne $null) {
    Write-Host ("  /state 返回 " + $state.__status + "（可能是没登录，跳过）")
    continue
  }
  if ($state.ok -ne $true) { Write-Host "  /state 不可用"; continue }

  $ok = $true
  $cfg = $state.value.config
  Write-Host ("  皮肤 = " + $cfg.skin + " · 并发 = " + $cfg.candidateConcurrency + " · 轮间隔 = " + $cfg.roundIntervalMin + " 分钟")
  Write-Host ("  当前 IP = " + $state.value.current.ip + " p50=" + $state.value.current.p50 + "ms")

  Write-Host "`n-- 1) 点击「立即检测」应真的重扫，不能返回 cached --"
  $scan = Call-Api $port 'scan' @{}
  if ($scan.ok -ne $true) {
    Write-Host ("  FAIL: scan 失败 → " + ($scan.error.message))
  } elseif ($scan.value.cached -eq $true) {
    Write-Host "  FAIL: 仍然返回 cached —— 用户点检测却拿到旧结果"
  } else {
    Write-Host ("  OK: 真的扫了，" + ($scan.value.candidates | Measure-Object).Count + " 个候选")
  }

  Write-Host "`n-- 2) 点击「立即切换」不应被 alreadyOptimal / needsConfirm 挡回 --"
  $apply = Call-Api $port 'apply' @{}
  Write-Host ("  value: " + ($apply.value | ConvertTo-Json -Compress -Depth 3))
  if ($apply.value.needsConfirm -eq $true) {
    Write-Host "  FAIL: 仍要求二次确认"
  } elseif ($apply.value.alreadyOptimal -eq $true) {
    Write-Host "  FAIL: 仍被「当前已是最优」拦回"
  } else {
    Write-Host "  OK: 没有被拦，走进了写入流程"
  }
  break
}

if (-not $ok) {
  Write-Host "`n无法连上插件接口（需要先重启 DSH 让新代码生效，且需要有效会话凭据）。"
  exit 2
}
