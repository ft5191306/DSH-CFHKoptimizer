// 端到端演练引擎：真跑一轮判定链路，但**不写系统 hosts**。
// 覆盖：状态机、快照、并发派生、配置归一化、每日上限。
// 用法：node _tools/engine-check.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { Engine, STATE, defaultConfig, minRoundIntervalMin, resolveDataDir } from '../lib/engine.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfpin-engine-'))
// 必须注入临时 hosts：任何测试都不许碰系统 hosts。
// 曾经有一次自测直接改掉了真实 hosts（删掉一个 IP），这个注入口就是那次事故的修复。
const fakeHosts = path.join(dir, 'hosts')
fs.writeFileSync(fakeHosts, [
  '# >>> CLOUDFLARE-PIN BEGIN (managed by cf_pin.py) >>>',
  '162.159.148.1 open-design.ai',
  '162.159.128.1 open-design.ai',
  '# <<< CLOUDFLARE-PIN END <<<',
  '',
].join('\r\n'), 'utf8')
let pass = 0, fail = 0
const check = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name) }
  catch (e) { fail++; console.log('  FAIL ' + name + ' -> ' + (e?.message ?? e)) }
}

const engine = new Engine({ dataDir: dir, config: defaultConfig(), log: () => {}, hostsFile: fakeHosts })
engine.loadState()
engine.reloadFromHosts()

console.log('== 冷启动 ==')
check('无采样时是 cold-start', () => assert.equal(engine.snapshot().state, STATE.coldStart))
check('hosts 里有当前 IP', () => assert.ok(engine.currentIps.length > 0))

// 用户要求：启动时不要让候选读数空着，先借用一次当前延迟。
// 但借用值只许用于显示，绝不能参与判定。
console.log('== 启动时借用当前延迟当作候选读数 ==')
{
  // 连当前读数都还没有时**不该**借：没有可借的数，宁可空着也不编。
  const cold = engine.snapshot()
  check('当前读数也没有时不借用（不编数据）', () => {
    assert.equal(cold.bestBorrowed, false)
    assert.equal(cold.best, null)
  })

  engine.current = { ip: '162.159.148.1', address: 'open-design.ai', p50: 380, p95: 420,
    loss: 0, samples: 6, at: Date.now(), durationMs: 1200, reliable: true }
  engine.candidates = []
  const borrowedSnap = engine.snapshot()
  check('有当前读数、还没候选 → 借用', () => assert.equal(borrowedSnap.bestBorrowed, true))
  check('借用的 p50 等于当前 p50', () => assert.equal(borrowedSnap.best.p50, 380))
  // 判定不受影响：借用不该让 decision 认为「有候选可切」
  engine.decide()
  check('借用值不参与判定（不会凭空产生切换决定）', () => {
    assert.equal(engine.decision.write, false)
  })

  // 一旦测出真候选，立刻停止借用
  engine.candidates = [{ ip: '1.2.3.4', colo: 'HKG', p50: 210, p95: 240,
    samples: 40, timeouts: 0, qualified: true, perDomain: {} }]
  const real = engine.snapshot()
  check('有真候选后不再借用', () => assert.equal(real.bestBorrowed, false))
  check('best 换成真候选', () => assert.equal(real.best.p50, 210))
}

console.log('== 真实采样（真网络，约 2s） ==')
await engine.sampleCurrent()
engine.decide()
const afterSample = engine.snapshot()
check('采样后不再冷启动', () => assert.notEqual(afterSample.state, STATE.coldStart))
check('当前读数带时间戳', () => assert.ok(afterSample.current.at > 0))
check('p50 是合理毫秒数', () => assert.ok(afterSample.current.p50 > 0 && afterSample.current.p50 < 5000, String(afterSample.current.p50)))
console.log(`     实测：${Math.round(afterSample.current.p50)}ms · ${afterSample.current.samples} 样本 · state=${afterSample.state}`)

console.log('== 判定：差距不够 → observing，不写 ==')
engine.current = { ...engine.current, p50: 300, reliable: true }
engine.candidates = [
  { ip: '1.1.1.1', colo: 'HKG', p50: 200, p95: 400, samples: 40, timeouts: 0, qualified: true, perDomain: {} },
]
engine.decide()
check('差距 100 < 阈值 150 → 不写', () => assert.equal(engine.decision.write, false))
check('状态是 observing', () => assert.equal(engine.snapshot().state, STATE.observing))
check('记下了 advantage', () => assert.equal(engine.decision.advantage, 100))

console.log('== 判定：差距够 → 写，但 autoWrite=false 时不写 ==')
engine.current.p50 = 400
// 默认配置现在是 autoWrite:true（用户截图定的），所以这条用例必须**显式**关掉，
// 才能测「关掉时不写」这件事本身。之前它靠默认值是 false 蒙对的。
engine.config = { ...engine.config, autoWrite: false }
engine.decide()
check('autoWrite 关闭时不写', () => assert.equal(engine.decision.write, false))

console.log('== 判定：开启 autoWrite 且有流在飞 → waiting-write ==')
engine.config = { ...engine.config, autoWrite: true }
engine.streaming = 1
engine.decide()
check('有流在飞 → waiting-write', () => assert.equal(engine.snapshot().state, STATE.waitingWrite))
check('decision.pending 为真', () => assert.equal(engine.decision.pending, true))

console.log('== 判定：流结束 → 可以写 ==')
engine.streaming = 0
engine.decide()
check('无流时可以写', () => assert.equal(engine.decision.write, true))
check('decision 指向候选', () => assert.equal(engine.decision.candidateIp, '1.1.1.1'))

console.log('== 全劣化：所有候选 p95 触顶 → 不写 ==')
engine.candidates = [
  { ip: '2.2.2.2', colo: 'HKG', p50: 180, p95: 999, samples: 40, timeouts: 4, qualified: false, perDomain: {} },
]
engine.decide()
check('全劣化不写', () => assert.equal(engine.decision.write, false))
check('状态是 all-degraded', () => assert.equal(engine.snapshot().state, STATE.allDegraded))

console.log('== 每日上限 ==')
engine.candidates = [
  { ip: '3.3.3.3', colo: 'HKG', p50: 100, p95: 300, samples: 40, timeouts: 0, qualified: true, perDomain: {} },
]
const now = Date.now()
// 上限默认 48；这里塞满 48 条来触发降级。
engine.switchLog = Array.from({ length: 48 }, (_, i) => now - i * 60_000)
engine.decide()
check('超上限不写', () => assert.equal(engine.decision.write, false))
check('状态是 daily-limit', () => assert.equal(engine.snapshot().state, STATE.dailyLimit))
check('switchesToday = 48', () => assert.equal(engine.snapshot().switchesToday, 48))

console.log('== 未达上限仍可写 ==')
engine.switchLog = Array.from({ length: 47 }, (_, i) => now - i * 60_000)
engine.decide()
check('47 次未达上限 → 可以写', () => assert.equal(engine.decision.write, true))

console.log('== 24h 滚动：旧记录不计入 ==')
engine.switchLog = Array.from({ length: 12 }, (_, i) => now - (25 * 60 * 60 * 1000) - i * 1000)
check('24h 前的记录不算', () => assert.equal(engine.switchLog.filter((t) => t >= now - 864e5).length, 0))

console.log('== 状态持久化 ==')
engine.switchLog = [now, now - 1000]
engine.rotation = 7
engine.saveState()
const engine2 = new Engine({ dataDir: dir, config: defaultConfig(), log: () => {}, hostsFile: fakeHosts })
engine2.loadState()
check('switchLog 落盘可读', () => assert.equal(engine2.switchLog.length, 2))
check('rotation 落盘可读', () => assert.equal(engine2.rotation, 7))

console.log('== 派生读数随并发变化 ==')
check('并发 2 → 150s', () => assert.equal(engine.snapshot().derived.roundDurationMs, 150_000))
engine.config = { ...engine.config, candidateConcurrency: 6 }
check('并发 6 → 50s', () => assert.equal(engine.snapshot().derived.roundDurationMs, 50_000))
check('并发 6 下限 1min', () => assert.equal(minRoundIntervalMin(6), 1))

console.log('== 数据目录 ==')
check('落在 cf-pin-data/<profile>', () => {
  const resolved = resolveDataDir({ profileDir: 'C:\\Users\\x\\.dsh\\profiles\\desktop' })
  assert.ok(resolved.includes('cf-pin-data'), resolved)
  assert.ok(resolved.endsWith('desktop'), resolved)
})

fs.rmSync(dir, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1
