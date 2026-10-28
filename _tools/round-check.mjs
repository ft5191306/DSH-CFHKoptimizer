// 跑一轮**真实**候选轮（256 粗筛 + 12 实测，约 3-4 分钟），验证整条链路。
// 这是唯一能证明「探测、机房过滤、淘汰、排序、判定」真的成立的方式。
// 用法：node _tools/round-check.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { Engine, STATE, defaultConfig } from '../lib/engine.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfpin-round-'))
// 隔离：绝不碰系统 hosts。这个测试只读，但一旦有人给它加了写路径，
// 真实 hosts 就会被改掉——只读也照样走注入。
const fakeHosts = path.join(dir, 'hosts')
fs.writeFileSync(fakeHosts, [
  '# >>> CLOUDFLARE-PIN BEGIN (managed by cf_pin.py) >>>',
  '162.159.148.1 open-design.ai',
  '# <<< CLOUDFLARE-PIN END <<<',
  '',
].join('\r\n'), 'utf8')

const engine = new Engine({
  dataDir: dir,
  config: { ...defaultConfig(), autoWrite: false },
  log: () => {},
  hostsFile: fakeHosts,
})
engine.loadState()
engine.reloadFromHosts()

console.log('当前 IP:', engine.currentIps.join(', ') || '(无)')
console.log('启用地址:', engine.enabledAddresses().map((a) => a.address).join(', '))
console.log('')

const t0 = Date.now()
await engine.sampleCurrent()
console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] 当前读数: ${engine.current?.p50}ms (${engine.current?.samples} 样本)`)

console.log('开始候选轮（256 粗筛 + 机房识别 + 12×地址实测）…')
const t1 = Date.now()
await engine.runCandidateRound()
const elapsed = (Date.now() - t1) / 1000

console.log(`\n候选轮完成，耗时 ${elapsed.toFixed(0)}s`)
console.log('候选数:', engine.candidates.length, '| 合格:', engine.candidates.filter((c) => c.qualified).length)
console.log('')
console.log('IP'.padEnd(17) + 'colo'.padEnd(6) + 'p50'.padStart(7) + 'p95'.padStart(8) + '  样本  合格')
console.log('-'.repeat(58))
for (const c of engine.candidates) {
  console.log(
    c.ip.padEnd(17) +
    String(c.colo ?? '?').padEnd(6) +
    String(Math.round(c.p50)).padStart(7) +
    String(Math.round(c.p95)).padStart(8) +
    String(c.samples).padStart(6) +
    (c.qualified ? '   合格' : '   淘汰'),
  )
}

const snap = engine.snapshot()
console.log('\n判定:', JSON.stringify(snap.decision))
console.log('状态:', snap.state)
console.log('最优:', JSON.stringify(snap.best))

// 结论校验
const problems = []
if (engine.candidates.length === 0) problems.push('一个候选都没测到')
if (elapsed > 400) problems.push(`一轮耗时 ${elapsed}s，超过预期上限`)
for (const c of engine.candidates) {
  if (c.p95 >= 999 && c.qualified) problems.push(`${c.ip} p95 触顶却被判合格`)
  if (c.colo !== null && !['HKG', 'NRT', 'KIX', 'ICN', 'SIN', 'TPE', 'BKK', 'MNL', 'SGN'].includes(c.colo)) {
    problems.push(`${c.ip} 是远端机房 ${c.colo}，本应被过滤`)
  }
  if (engine.currentIps.includes(c.ip)) problems.push(`${c.ip} 是当前 IP，本应被排除`)
}
// 排序校验：合格者按 p50 升序
const kept = engine.candidates.filter((c) => c.qualified)
for (let i = 1; i < kept.length; i++) {
  if (kept[i].p50 < kept[i - 1].p50) problems.push('合格候选未按 p50 升序')
}

fs.rmSync(dir, { recursive: true, force: true })
if (problems.length > 0) {
  console.log('\n发现问题:')
  for (const p of problems) console.log('  - ' + p)
  process.exit(1)
}
console.log('\n全部校验通过')
process.exit(0)
