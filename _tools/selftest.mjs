// 宿主半的自测：只测纯逻辑与不联网的部分，不碰系统 hosts。
// 用法：node _tools/selftest.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  BEGIN_MARK, END_MARK, composeHosts, currentPin, detectEol,
  pythonStrip, renderBlock, splitLinesKeepEnds, stripBlock, writeHosts,
} from '../lib/hosts.js'
import { buildCandidates, percentile, PENALTY_MS, P95_REJECT_MS } from '../lib/probe.js'
import { defaultConfig, minRoundIntervalMin, roundDurationMs } from '../lib/engine.js'

let pass = 0
let fail = 0
function check(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name) }
  catch (error) { fail++; console.log('  FAIL ' + name + ' -> ' + (error?.message ?? error)) }
}

console.log('== 候选池 ==')
check('256 个', () => assert.equal(buildCandidates().length, 256))
check('首尾与数值序', () => {
  const list = buildCandidates()
  assert.equal(list[0], '104.26.0.1')
  assert.equal(list[list.length - 1], '162.159.254.1')
})
check('无 .0 主机位', () => {
  for (const ip of buildCandidates()) assert.ok(!ip.endsWith('.0'), ip)
})

console.log('== 百分位（numpy linear） ==')
check('[1..5] p50=3', () => assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3))
check('[1..5] p95=4.8', () => assert.equal(percentile([1, 2, 3, 4, 5], 0.95), 4.8))
check('单样本', () => assert.equal(percentile([7], 0.95), 7))
check('[0,999] p95=949.05', () => assert.ok(Math.abs(percentile([0, 999], 0.95) - 949.05) < 1e-9))

console.log('== 淘汰边界：n=40 时 2 个超时不淘汰、3 个才淘汰 ==')
function p95With(k, n) {
  const base = Array.from({ length: n - k }, () => 200)
  const poisoned = Array.from({ length: k }, () => PENALTY_MS)
  const all = [...base, ...poisoned].sort((a, b) => a - b)
  return percentile(all, 0.95)
}
check('n=40 k=2 → 不淘汰', () => assert.ok(p95With(2, 40) < P95_REJECT_MS, String(p95With(2, 40))))
check('n=40 k=3 → 淘汰', () => assert.ok(p95With(3, 40) >= P95_REJECT_MS, String(p95With(3, 40))))

console.log('== hosts 段 ==')
const sample = [
  '# sample header',
  '139.177.246.196 pcdownload-huoshan.aki-game.net #UHE_',
  '',
  BEGIN_MARK,
  '162.159.152.1 cloudflare.com',
  '162.159.130.1 cloudflare.com',
  '162.159.152.1 open-design.ai',
  END_MARK,
  '# trailing note',
  '',
].join('\r\n')

check('currentPin 读出现有段', () => {
  const { ips, domains } = currentPin(sample)
  assert.deepEqual(ips, ['162.159.152.1', '162.159.130.1'])
  assert.deepEqual(domains, ['cloudflare.com', 'open-design.ai'])
})
check('段外内容原样保留', () => {
  const out = composeHosts(sample, ['1.2.3.4'], ['open-design.ai'])
  assert.ok(out.includes('139.177.246.196 pcdownload-huoshan.aki-game.net #UHE_'))
  assert.ok(out.includes('# trailing note'))
  assert.ok(!out.includes('162.159.152.1'))
})
check('CRLF 保持', () => {
  const out = composeHosts(sample, ['1.2.3.4'], ['open-design.ai'])
  assert.equal(detectEol(out), '\r\n')
  assert.ok(!/[^\r]\n/.test(out), '出现了裸 LF')
})
check('域名外层 / IP 内层', () => {
  const block = renderBlock(['1.1.1.1', '2.2.2.2'], ['a.com', 'b.com'], '\n')
  const lines = block.split('\n').filter(Boolean)
  assert.deepEqual(lines, [BEGIN_MARK, '1.1.1.1 a.com', '2.2.2.2 a.com', '1.1.1.1 b.com', '2.2.2.2 b.com', END_MARK])
})
check('幂等：写两次结果一致', () => {
  const once = composeHosts(sample, ['1.2.3.4', '5.6.7.8'], ['open-design.ai'])
  const twice = composeHosts(once, ['1.2.3.4', '5.6.7.8'], ['open-design.ai'])
  assert.equal(once, twice)
})
check('stripBlock 幂等', () => assert.equal(stripBlock(stripBlock(sample)), stripBlock(sample)))

console.log('== Python 语义复刻 ==')
check('splitLinesKeepEnds 处理 \\f', () => {
  assert.deepEqual(splitLinesKeepEnds('a\fb\n'), ['a\f', 'b\n'])
})
check('pythonStrip 处理 NBSP', () => assert.equal(pythonStrip('\u00a0 x \u00a0'), 'x'))

console.log('== 写入路径（临时文件，不碰系统 hosts） ==')
check('备份单份覆盖 + 原子替换', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfpin-'))
  const file = path.join(dir, 'hosts')
  fs.writeFileSync(file, sample, 'utf8')
  const r1 = writeHosts(composeHosts(sample, ['1.1.1.1'], ['open-design.ai']), { file })
  const r2 = writeHosts(composeHosts(sample, ['2.2.2.2'], ['open-design.ai']), { file })
  assert.equal(r1.mode, 'atomic')
  assert.equal(r2.mode, 'atomic')
  assert.equal(r1.backup, r2.backup, '备份必须是同一份（单份覆盖）')
  assert.ok(fs.existsSync(file + '.bak'))
  assert.ok(!fs.existsSync(file + '.cfpin.tmp'), '临时文件必须清理')
  const backups = fs.readdirSync(dir).filter((n) => n.startsWith('hosts.bak'))
  assert.equal(backups.length, 1, '只能有一份备份：' + backups.join(','))
  assert.deepEqual(currentPin(fs.readFileSync(file, 'utf8')).ips, ['2.2.2.2'])
  fs.rmSync(dir, { recursive: true, force: true })
})

console.log('== 派生读数 ==')
check('并发 2 → 150s / 3min', () => {
  assert.equal(roundDurationMs(2), 150_000)
  assert.equal(minRoundIntervalMin(2), 3)
})
check('并发 12 → 25s', () => assert.equal(roundDurationMs(12), 25_000))
check('并发 1 → 300s / 5min', () => assert.equal(roundDurationMs(1), 300_000))

console.log('== 默认配置 ==')
check('默认值与设计一致', () => {
  // 2026-10-28 按用户截图重新定稿：自动切换默认开、回复中也探测、
  // 只勾选 amr-link 一条地址、默认同心环皮肤。
  const c = defaultConfig()
  assert.equal(c.autoWrite, true)
  assert.equal(c.currentProbeMs, 6000)
  assert.equal(c.candidateConcurrency, 2)
  // 轮间隔是推导值（并发 2 → ceil(12/2)*25s = 150s → 3 分钟）
  assert.equal(c.roundIntervalMin, 3)
  assert.equal(c.switchThresholdMs, 150)
  assert.equal(c.maxSwitchesPerDay, 48)
  assert.equal(c.probeWhileThinking, true)
  assert.equal(c.skin, 'ring')
  assert.equal(c.probeWhileWaiting, undefined)
  assert.equal(c.addresses.filter((a) => a.enabled).length, 1)
  assert.equal(c.addresses.find((a) => a.enabled).address, 'amr-link.open-design.ai')
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1
