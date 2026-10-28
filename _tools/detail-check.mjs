// 验证设置直接铺在插件详情页（不用再点进「优选线路」），且门禁正确。
// 用法：node _tools/detail-check.mjs
import fs from 'node:fs'
import path from 'node:path'

let pass = 0, fail = 0
const check = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name) }
  catch (e) { fail++; console.log('  FAIL ' + name + ' -> ' + (e?.message ?? e)) }
}

let hookIndex = 0
const slots = []
let effects = []
const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useState(init) { const i = hookIndex++; if (!(i in slots)) slots[i] = init; return [slots[i], (n) => { slots[i] = typeof n === 'function' ? n(slots[i]) : n }] },
  useReducer(_r, init) { const i = hookIndex++; if (!(i in slots)) slots[i] = init; return [slots[i], (n) => { slots[i] = typeof n === 'function' ? n(slots[i]) : n }] },
  useEffect(fn) { hookIndex++; effects.push(fn) },
  useRef(v) { const i = hookIndex++; if (!(i in slots)) slots[i] = v; return { current: slots[i] } },
  useMemo(fn) { hookIndex++; return fn() },
  useCallback(fn) { hookIndex++; return fn },
  Fragment: 'Fragment',
}

function textOf(node) {
  if (node == null || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (typeof node === 'function') return ''
  if (node.type === 'style') return ''
  if (node.type === 'svg' || node.type === 'path') return ''
  if (typeof node.type === 'function') return textOf(node.type(node.props))
  return (node.children ?? []).map(textOf).join(' ')
}
function render(type, props) { hookIndex = 0; effects = []; return type(props) }
function mount(type, props) { const n = render(type, props); for (const fn of effects) { const c = fn(); void c } return n }

const SNAPSHOT = {
  state: 'normal', admin: true, autoWrite: false,
  current: { ip: '162.159.148.1', address: 'open-design.ai', p50: 410, p95: 440, loss: 0,
    samples: 91, at: Date.now() - 3000, durationMs: 1200, reliable: true },
  candidates: [{ ip: '162.159.144.1', colo: 'HKG', p50: 230, p95: 250, qualified: true, samples: 279, timeouts: 0 }],
  best: { ip: '162.159.144.1', p50: 230, p95: 250, colo: 'HKG' },
  decision: { write: false, reason: 'observing' },
  advantageMs: 180, thresholdMs: 150,
  round: { running: false, startedAt: 0, finishedAt: Date.now() - 30000, durationMs: 150000, intervalMin: 5 },
  lastSwitch: null, switchesToday: 3,
  config: { autoWrite: false, currentProbeMs: 6000, candidateConcurrency: 2, roundIntervalMin: 5,
    switchThresholdMs: 150, maxSwitchesPerDay: 48, probeWhileThinking: false,
    addresses: [{ address: 'open-design.ai', enabled: true }] },
  derived: { roundDurationMs: 150000, minRoundIntervalMin: 3, slotMs: 25000, windowMs: 20000, candidateCount: 12 },
  hosts: { path: 'x', currentIps: ['162.159.148.1'], currentDomains: ['open-design.ai'] },
  lastError: null, probeFailed: false, now: Date.now(),
}

globalThis.window = { __ModuleLoader__: { load: (d) => { globalThis.__mod = d } }, setInterval: () => 1, clearInterval: () => {} }
globalThis.document = { hidden: false, addEventListener: () => {}, removeEventListener: () => {} }
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, value: SNAPSHOT }) })

const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'client.js'), 'utf8')
new Function('window', 'document', 'fetch', src)(globalThis.window, globalThis.document, globalThis.fetch)
const mod = globalThis.__mod.factory((n) => { if (n === 'react') return react; throw new Error(n) })

const registered = []
let detailSection = null
mod.apply({
  slots: {
    inject: (_n, cb) => cb(),
    register: (o, c) => {
      registered.push(o)
      if (o.name === 'plugins.detail.section') detailSection = c
      return () => {}
    },
  },
})

console.log('== 注册 ==')
check('注册了三个 slot', () => {
  if (registered.length !== 3) throw new Error(registered.map((r) => r.name).join(','))
})
check('含 plugins.detail.section', () => {
  if (!registered.some((r) => r.name === 'plugins.detail.section')) throw new Error('缺少详情页区块')
})

console.log('== 门禁：别的插件不渲染 ==')
check('别的 bundle → null', () => {
  const out = render(detailSection, { subject: { kind: 'bundle', pkg: { name: '@local/other-plugin' } } })
  if (out !== null) throw new Error('不该渲染')
})
check('别的 row → null', () => {
  const out = render(detailSection, { subject: { kind: 'row', pkg: { name: '@local/other' }, row: {} } })
  if (out !== null) throw new Error('不该渲染')
})
check('subject 缺失 → null', () => {
  const out = render(detailSection, {})
  if (out !== null) throw new Error('不该渲染')
})

console.log('== 本包 bundle 页：设置直接可见 ==')
// 注意：DetailSettingsSection 是无 hook 的外层，真正的 ConfigPage 在里面。
// 这个测试替身无法可靠地在嵌套组件之间共享 hook 槽位，所以这里分两步验证：
//   1) 外层确实把 ConfigPage 挂了出来（结构断言，不依赖 hook 状态）
//   2) ConfigPage 单独渲染时内容完整（已有 render-check 覆盖，这里再确认关键项）
const detailNode = render(detailSection, { subject: { kind: 'bundle', pkg: { name: '@local/dsh-cf-pin' } } })
check('外层把 ConfigPage 挂了出来', () => {
  if (detailNode == null) throw new Error('返回了 null')
  const text = JSON.stringify(detailNode, (k, v) => (typeof v === 'function' ? '[fn ' + (v.name || 'anon') + ']' : v))
  if (!text.includes('cfp-detailSection')) throw new Error('缺少容器类名')
  if (!text.includes('ConfigPage')) throw new Error('没有挂 ConfigPage: ' + text.slice(0, 200))
})

// 把 ConfigPage 本体拿出来独立挂载、独立取数，确认详情页拿到的就是完整的设置页。
let configPage = null
mod.apply({
  slots: {
    inject: (_n, cb) => cb(),
    register: (o, c) => { if (o.name === 'plugins.row.config') configPage = c; return () => {} },
  },
})
mount(configPage, { view: 'page' })
await new Promise((r) => setTimeout(r, 60))
const detailText = textOf(render(configPage, { view: 'page' }))
console.log('   详情页所挂组件的内容长度: ' + detailText.length)

check('出现「自动切换」开关（无需再点一层）', () => {
  if (!detailText.includes('链路变慢时自动切换')) throw new Error(detailText.slice(0, 200))
})
check('出现「立即检测」', () => { if (!detailText.includes('立即检测')) throw new Error('缺少') })
check('出现「当前 IP」', () => { if (!detailText.includes('当前 IP')) throw new Error('缺少') })
check('出现每日上限 48', () => { if (!detailText.includes('48')) throw new Error('缺少 48') })
check('出现「探测地址」', () => { if (!detailText.includes('探测地址')) throw new Error('缺少') })
check('设置默认展开（不用再点开）', () => {
  if (!detailText.includes('链路变慢时自动切换')) throw new Error('设置折叠着')
})

console.log('== 本包的 row 配置页也能渲染（保留原来的入口）==')
const cfgText = detailText
check('配置页仍有全部内容', () => {
  if (!cfgText.includes('立即检测') || !cfgText.includes('当前 IP')) throw new Error(cfgText.slice(0, 150))
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
