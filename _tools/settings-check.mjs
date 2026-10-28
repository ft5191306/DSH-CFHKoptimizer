// 验证配置页是**两级**结构：页面 → 「设置」一个折叠 → 全部参数。
// 用法：node _tools/settings-check.mjs
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

/** 找出可以点的折叠头（带 aria-expanded 的 button）。 */
function findToggles(node, out = []) {
  if (node == null || typeof node !== 'object') return out
  if (Array.isArray(node)) { node.forEach((n) => findToggles(n, out)); return out }
  if (node.props && 'aria-expanded' in node.props) out.push(node)
  if (typeof node.type === 'function') { findToggles(node.type(node.props), out); return out }
  ;(node.children ?? []).forEach((n) => findToggles(n, out))
  return out
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

let configPage = null
mod.apply({ slots: { inject: (_n, cb) => cb(), register: (o, c) => { if (o.name === 'plugins.row.config') configPage = c; return () => {} } } })

mount(configPage, { view: 'page' })
await new Promise((r) => setTimeout(r, 60))

console.log('== 初始态（设置默认展开）==')
const collapsed = render(configPage, { view: 'page' })
const collapsedText = textOf(collapsed)
const toggles = findToggles(collapsed)
console.log('   折叠头数量: ' + toggles.length + ' | 文案: ' + JSON.stringify(collapsedText.slice(0, 120)))
check('只有一个折叠入口（两级，不是三级）', () => {
  if (toggles.length !== 1) throw new Error('折叠头有 ' + toggles.length + ' 个，应为 1')
})
check('折叠叫「设置」', () => {
  if (!collapsedText.includes('设置')) throw new Error(collapsedText.slice(0, 120))
})
check('不再有「高级」这个额外层级', () => {
  if (collapsedText.includes('高级')) throw new Error('仍存在「高级」')
})
check('默认展开：参数直接可见', () => {
  if (!collapsedText.includes('链路变慢时自动切换')) throw new Error('设置折叠着，用户要多点一次')
})

console.log('== 收起态（点一下才收起）==')
const toggle = toggles[0]
toggle.props.onClick()
const collapsedAgain = render(configPage, { view: 'page' })
const collapsedAgainText = textOf(collapsedAgain)
check('收起后参数隐藏', () => {
  if (collapsedAgainText.includes('链路变慢时自动切换')) throw new Error('收起无效')
})
// 再点开回来
findToggles(collapsedAgain)[0].props.onClick()
const expanded = render(configPage, { view: 'page' })
const expandedText = textOf(expanded)
console.log('   展开后长度: ' + expandedText.length)

const mustHave = [
  // switchRow 的标题是真实文本节点；Switch 控件本身只有 aria-label，
  // 摊平文本取不到，所以这里断言标题而不是开关文案。
  ['自动切换开关', '链路变慢时自动切换'],
  ['每日上限（48 次）', '48'],
  ['切换阈值', '切换阈值'],
  ['回复进行中', '回复进行中'],
  ['并发数', '并发数'],
  ['候选轮间隔', '候选轮间隔'],
  ['采样间隔', '采样间隔'],
  ['探测地址', '探测地址'],
  ['测量方式（只读说明）', '测量方式'],
]
for (const [label, needle] of mustHave) {
  check('展开后含 ' + label, () => {
    if (!expandedText.includes(needle)) throw new Error('缺少 ' + needle)
  })
}
check('展开后仍然只有 1 个折叠头', () => {
  const t = findToggles(expanded)
  if (t.length !== 1) throw new Error('折叠头有 ' + t.length + ' 个')
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
