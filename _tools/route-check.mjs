// 用假 ctx 装载插件，直接调路由处理器（路由本身只接受已认证请求，curl 会 401）。
// 覆盖：apply() 是否真跑、路由是否注册、state 快照形状、config 持久化。
// 用法：node _tools/route-check.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let pass = 0, fail = 0
const check = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name) }
  catch (e) { fail++; console.log('  FAIL ' + name + ' -> ' + (e?.message ?? e)) }
}

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cfpin-route-'))
process.env.DSH_HOME = dataRoot
process.env.DSH_PROFILE = 'testprofile'

// 捕获注册出来的路由
const routes = new Map()
const listeners = new Map()
const effects = []

const connection = {
  fetch: {
    register: (route) => {
      routes.set(route.path, route)
      return async () => {}
    },
  },
}

const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  get: (key) => (key === 'connection' ? connection : undefined),
  on: (event, handler) => { listeners.set(event, handler) },
  inject: (names, cb) => { cb(ctx) },
  effect: (factory) => { effects.push(factory) },
  timer: {
    timeout: (cb, ms) => { const t = setTimeout(cb, ms); return () => clearTimeout(t) },
    interval: (cb, ms) => { const t = setInterval(cb, ms); return () => clearInterval(t) },
  },
}

const plugin = await import('../index.js')
plugin.apply(ctx, { autoWrite: false })

console.log('== 装载 ==')
check('注册了 8 条路由', () => assert.equal(routes.size, 8))
check('挂在 llm/stream 上', () => assert.ok(listeners.has('llm/stream')))
check('路径前缀正确', () => {
  for (const p of routes.keys()) assert.ok(p.startsWith('/api/dsh-cf-pin/'), p)
})

async function call(name, body) {
  const route = routes.get('/api/dsh-cf-pin/' + name)
  assert.ok(route, '没有路由 ' + name)
  const request = new Request('http://localhost' + route.path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  const response = await route.fetch(request)
  return { status: response.status, payload: await response.json() }
}

console.log('== /state ==')
const state = await call('state')
check('HTTP 200', () => assert.equal(state.status, 200))
check('ok:true', () => assert.equal(state.payload.ok, true))
const snap = state.payload.value
check('快照有全部关键字段', () => {
  for (const key of ['state', 'admin', 'current', 'candidates', 'best', 'decision', 'round',
    'lastSwitch', 'switchesToday', 'config', 'derived', 'hosts', 'now']) {
    assert.ok(key in snap, '缺字段 ' + key)
  }
})
check('派生读数正确（并发 2 → 150s）', () => assert.equal(snap.derived.roundDurationMs, 150_000))
check('derived 带窗口与槽位', () => {
  assert.equal(snap.derived.slotMs, 25_000)
  assert.equal(snap.derived.windowMs, 20_000)
  assert.equal(snap.derived.candidateCount, 12)
})
check('状态合法', () => assert.ok(typeof snap.state === 'string' && snap.state.length > 0))
console.log('     当前 state=' + snap.state + ' admin=' + snap.admin + ' 当前IP=' + snap.hosts.currentIps.join(','))

console.log('== /config 归一化 ==')
const cfg = await call('config', { config: { candidateConcurrency: 6, roundIntervalMin: 1 } })
check('并发 6 → 一轮 50s', () => assert.equal(cfg.payload.value.derived.roundDurationMs, 50_000))
check('轮间隔被抬到下限 1min', () => assert.equal(cfg.payload.value.config.roundIntervalMin, 1))
check('落盘成功', () => assert.equal(cfg.payload.value.saved, true))

console.log('== /config 夹边界 ==')
const cfg2 = await call('config', { config: { maxSwitchesPerDay: 999, candidateConcurrency: 999 } })
check('每日上限夹到 48', () => assert.equal(cfg2.payload.value.config.maxSwitchesPerDay, 48))
check('并发夹到 12', () => assert.equal(cfg2.payload.value.config.candidateConcurrency, 12))
check('并发 12 → 一轮 25s', () => assert.equal(cfg2.payload.value.derived.roundDurationMs, 25_000))

// 新增配置项必须在 normalizeConfig 里显式接住。
// 这一条是给真实事故兜底的：手改 config.json 写入 skin 后，旧代码的
// normalizeConfig 不认识它，保存其他字段时把它整个丢掉，而且不报错。
console.log('== /config 新增字段不被吞掉 ==')
const skinSet = await call('config', { config: { skin: 'ring' } })
check('skin:ring 被接受', () => assert.equal(skinSet.payload.value.config.skin, 'ring'))
check('skin 有落盘', () => assert.equal(skinSet.payload.value.saved, true))
const skinBad = await call('config', { config: { skin: 'not-a-skin' } })
check('未知 skin 退回 ring', () => assert.equal(skinBad.payload.value.config.skin, 'ring'))
const skinTaiji = await call('config', { config: { skin: 'taiji' } })
check('skin:taiji 被接受', () => assert.equal(skinTaiji.payload.value.config.skin, 'taiji'))
// 三格点阵已删除：旧配置里残留的 'fan' 必须被迁到 ring，而不是保留下来
const skinFan = await call('config', { config: { skin: 'fan' } })
check('已删除的 fan 被迁到 ring', () => assert.equal(skinFan.payload.value.config.skin, 'ring'))
// 改别的字段时，skin 不能被顺手抹掉
await call('config', { config: { skin: 'taiji' } })
const others = await call('config', { config: { switchThresholdMs: 200 } })
check('改别的字段不会丢掉 skin', () => assert.equal(others.payload.value.config.skin, 'taiji'))
await call('config', { config: { skin: 'ring' } })

console.log('== 候选轮间隔是推导值，不可单独配置 ==')
const ivr2 = await call('config', { config: { candidateConcurrency: 2 } })
check('并发 2 → 间隔 3 分钟', () => assert.equal(ivr2.payload.value.config.roundIntervalMin, 3))
const ivr4 = await call('config', { config: { candidateConcurrency: 4 } })
check('并发 4 → 间隔 2 分钟', () => assert.equal(ivr4.payload.value.config.roundIntervalMin, 2))
const ivrBad = await call('config', { config: { roundIntervalMin: 99 } })
check('传入的 roundIntervalMin 被忽略', () => assert.equal(ivrBad.payload.value.config.roundIntervalMin, 2))
await call('config', { config: { candidateConcurrency: 2 } })

console.log('== 配置真的落盘并可重读 ==')
const configFile = path.join(dataRoot, 'cf-pin-data', 'testprofile', 'config.json')
check('config.json 存在', () => assert.ok(fs.existsSync(configFile), configFile))
const persisted = JSON.parse(fs.readFileSync(configFile, 'utf8'))
check('落盘内容与内存一致', () => assert.equal(persisted.maxSwitchesPerDay, 48))
check('落盘含地址列表', () => assert.ok(Array.isArray(persisted.addresses)))

console.log('== /addresses ==')
const addr = await call('addresses', {
  addresses: [{ address: 'open-design.ai', enabled: true }, { address: 'example.com', enabled: false }],
})
check('保存 2 条', () => assert.equal(addr.payload.value.addresses.length, 2))
check('enabled 保留', () => assert.equal(addr.payload.value.addresses[1].enabled, false))
const addr2 = await call('addresses', { addresses: [] })
check('空列表回退到默认', () => assert.equal(addr2.payload.value.addresses.length, 3))

console.log('== /reset 只重置配置，不动 hosts ==')
const before = fs.readFileSync(process.env.SystemRoot + '\\System32\\drivers\\etc\\hosts', 'utf8')
const reset = await call('reset')
const after = fs.readFileSync(process.env.SystemRoot + '\\System32\\drivers\\etc\\hosts', 'utf8')
check('恢复默认并发 2', () => assert.equal(reset.payload.value.config.candidateConcurrency, 2))
check('hosts 未被触碰', () => assert.equal(before, after))

// 用户 2026-10-28 明确要求：**所有由用户点击触发的操作都不许被拦截**。
// 所以 /apply 不再有 needs-confirm 那道二次确认，也不再被「当前已是最优」挡回。
// 这里钉的是「它真的往下走了」——不再返回 needsConfirm。
console.log('== /apply 不再要求二次确认 ==')
const applyNo = await call('apply', {})
check('无合格候选时不再返回 needsConfirm', () => {
  assert.equal(applyNo.payload.value?.needsConfirm, undefined)
})
check('不再有 needs-confirm 这个 error.code', () => {
  assert.notEqual(applyNo.payload.error?.code, 'needs-confirm')
})

console.log('== /addresses/reset 独立恢复默认地址 ==')
await call('addresses', { addresses: [{ address: 'junk.invalid', enabled: true }] })
const addrReset = await call('addresses/reset')
check('恢复成 3 条默认地址', () => assert.equal(addrReset.payload.value.addresses.length, 3))
check('默认地址含 amr-link', () => assert.ok(
  addrReset.payload.value.addresses.some((a) => a.address === 'amr-link.open-design.ai')))

console.log('== advantageMs / thresholdMs 显式给出 ==')
const st2 = await call('state')
check('advantageMs 字段存在', () => assert.ok('advantageMs' in st2.payload.value))
check('thresholdMs = 150', () => assert.equal(st2.payload.value.thresholdMs, 150))
// 界面要做「流式状态」的视觉表达，不能只靠 waiting-write 反推。
check('streaming 字段存在且为数字', () => {
  assert.ok('streaming' in st2.payload.value, '缺少 streaming')
  assert.equal(typeof st2.payload.value.streaming, 'number')
})

console.log('== /reveal ==')
const reveal = await call('reveal')
check('给出数据目录', () => assert.ok(reveal.payload.value.dataDir.includes('cf-pin-data')))
check('给出 hosts 路径', () => assert.ok(reveal.payload.value.hosts.endsWith('hosts')))

console.log('== /scan（真网络，约 60-90s；此处只验形状） ==')
console.log('     跳过完整扫描，避免测试耗时；已由 net-check 单独验证探测原语。')

fs.rmSync(dataRoot, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
// 插件装了真实定时器；测完必须显式退出，否则进程会一直挂着。
process.exit(fail === 0 ? 0 : 1)
