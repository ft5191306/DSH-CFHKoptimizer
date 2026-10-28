// 渲染 client.js 的两个分支，确认关键控件与文案真的出现。
//
// 做法说明：不试图完整模拟 React。只在**同一棵渲染树**里维持连续的 hook 序号
// （真实 React 就是这样按渲染顺序分配槽位的），执行挂载 effect，等快照落地后
// 再渲染一次，然后把元素树摊平成文本做断言。
//
// 用法：node _tools/render-check.mjs
import fs from 'node:fs'
import path from 'node:path'

let pass = 0, fail = 0
const check = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name) }
  catch (e) { fail++; console.log('  FAIL ' + name + ' -> ' + (e?.message ?? e)) }
}

// ---------------------------------------------------------------- 替身 React
let hookIndex = 0
const slots = []       // hook 状态槽
let effects = []       // 本轮登记的 effect

const react = {
  createElement: (type, props, ...children) =>
    ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useState(init) {
    const i = hookIndex++
    if (!(i in slots)) slots[i] = init
    return [slots[i], (next) => { slots[i] = typeof next === 'function' ? next(slots[i]) : next }]
  },
  useReducer(_r, init) {
    const i = hookIndex++
    if (!(i in slots)) slots[i] = init
    // dispatch 可能收到函数（store 的 bump 就是 value => value + 1）
    return [slots[i], (next) => { slots[i] = typeof next === 'function' ? next(slots[i]) : next }]
  },
  useEffect(fn) { hookIndex++; effects.push(fn) },
  useRef(v) { const i = hookIndex++; if (!(i in slots)) slots[i] = v; return { current: slots[i] } },
  useMemo(fn) { hookIndex++; return fn() },
  useCallback(fn) { hookIndex++; return fn },
  Fragment: 'Fragment',
}

// ---------------------------------------------------------------- 摊平为文本

/** 渲染一次整棵树：hook 序号在树内连续。 */
function renderTree(type, props) {
  hookIndex = 0
  effects = []
  const node = type(props)
  return { node, text: textOf(node) }
}

/**
 * 摊平为文本时**必须展开函数组件**（Facts / Styles 等），
 * 并保持 hook 序号连续——否则子组件读到空状态，看起来像「没渲染」。
 */
function textOf(node) {
  if (node == null || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (typeof node === 'function') return ''
  if (node.type === 'style') return ''
  if (typeof node.type === 'function') {
    // 子组件沿用当前 hook 序号继续往下消费
    return textOf(node.type(node.props))
  }
  return (node.children ?? []).map(textOf).join(' ')
}

/** 执行挂载 effect（useSnapshot 靠它 retain 并启动轮询）。 */
function mount(type, props) {
  renderTree(type, props)
  for (const fn of effects) { const c = fn(); void c }
}

// ---------------------------------------------------------------- 假环境
const fetched = []
globalThis.window = {
  __ModuleLoader__: { load: (def) => { globalThis.__mod = def } },
  setInterval: () => 1,
  clearInterval: () => {},
}
globalThis.document = {
  hidden: false,
  addEventListener: () => {},
  removeEventListener: () => {},
}

const SNAPSHOT = {
  state: 'normal', admin: true, autoWrite: false,
  current: { ip: '162.159.148.1', address: 'open-design.ai', p50: 218, p95: 240, loss: 0,
    samples: 91, at: Date.now() - 4000, durationMs: 1200, reliable: true },
  candidates: [{ ip: '162.159.144.1', colo: 'HKG', p50: 215, p95: 233, qualified: true, samples: 279, timeouts: 0 }],
  best: { ip: '162.159.144.1', p50: 215, p95: 233, colo: 'HKG' },
  decision: { write: false, reason: 'observing', candidateIp: '162.159.144.1', advantage: 3 },
  advantageMs: 3, thresholdMs: 150,
  round: { running: false, startedAt: Date.now() - 200000, finishedAt: Date.now() - 30000,
    durationMs: 150000, intervalMin: 5 },
  lastSwitch: null, switchesToday: 0,
  config: { autoWrite: false, currentProbeMs: 6000, candidateConcurrency: 2, roundIntervalMin: 5,
    switchThresholdMs: 150, maxSwitchesPerDay: 12, probeWhileThinking: false,
    addresses: [{ address: 'open-design.ai', enabled: true }] },
  derived: { roundDurationMs: 150000, minRoundIntervalMin: 3, slotMs: 25000, windowMs: 20000, candidateCount: 12 },
  hosts: { path: 'C:\\Windows\\System32\\drivers\\etc\\hosts',
    currentIps: ['162.159.148.1'], currentDomains: ['open-design.ai'] },
  lastError: null, probeFailed: false, now: Date.now(),
}

globalThis.fetch = async (url) => {
  fetched.push(url)
  return { ok: true, status: 200, json: async () => ({ ok: true, value: SNAPSHOT }) }
}

// ---------------------------------------------------------------- 装载
const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'client.js'), 'utf8')
new Function('window', 'document', 'fetch', src)(globalThis.window, globalThis.document, globalThis.fetch)

const mod = globalThis.__mod.factory((n) => {
  if (n === 'react') return react
  throw new Error('unexpected require: ' + n)
})

let banner = null
let configPage = null
const registered = []
mod.apply({
  slots: {
    inject: (_n, cb) => cb(),
    register: (options, component) => {
      registered.push(options)
      if (options.name === 'conversation.input.dock') banner = component
      if (options.name === 'plugins.row.config') configPage = component
      return () => {}
    },
  },
})

console.log('== 模块与注册 ==')
check('模块 id 为包名', () => {
  if (globalThis.__mod.id !== '@local/dsh-cf-pin') throw new Error(globalThis.__mod.id)
})
check('inject 含 slots', () => {
  if (!mod.inject.includes('slots')) throw new Error(JSON.stringify(mod.inject))
})
check('三个 slot 都注册了', () => {
  if (registered.length !== 3) throw new Error(String(registered.length))
})
check('配置页 key 正确', () => {
  const c = registered.find((r) => r.name === 'plugins.row.config')
  if (c.key !== '@local/dsh-cf-pin#cf-pin') throw new Error(c.key)
})
check('横幅 id/order 正确', () => {
  const b = registered.find((r) => r.name === 'conversation.input.dock')
  if (b.id !== 'cf-pin-banner' || b.order !== 30) throw new Error(JSON.stringify(b))
})

// ---------------------------------------------------------------- 挂载并取数
console.log('== 挂载配置页、等快照 ==')
mount(configPage, { view: 'page' })
check('挂载即发起 fetch', () => {
  if (fetched.length === 0) throw new Error('没有请求 /state')
  if (!fetched[0].includes('/api/dsh-cf-pin/state')) throw new Error(fetched[0])
})
await new Promise((r) => setTimeout(r, 60))

console.log('== view="page"（配置参数现在收在「设置」二级折叠里，默认收起）==')
const page = renderTree(configPage, { view: 'page' }).text
check('出现「设置」折叠头', () => { if (!page.includes('设置')) throw new Error(page.slice(0, 200)) })
check('出现「立即检测」', () => { if (!page.includes('立即检测')) throw new Error('缺少') })
check('出现「立即切换」', () => { if (!page.includes('立即切换')) throw new Error('缺少') })
check('出现「当前 IP」', () => { if (!page.includes('当前 IP')) throw new Error('缺少') })
check('出现「今日切换」', () => { if (!page.includes('今日切换')) throw new Error('缺少') })
// 218ms 经 formatMs 取整到十位 → "220ms"。断言按实际格式写，不要按原始值写。
check('显示实测延迟（取整到十位）', () => { if (!page.includes('220ms')) throw new Error('缺少当前延迟，实际文本: ' + page.slice(0, 300)) })
check('不是空状态', () => { if (page.includes('正在读取状态')) throw new Error('仍停在读取中') })
check('设置默认展开（打开就能看到参数）', () => { if (!page.includes('自动切换')) throw new Error('折叠着，用户要多点一次') })

console.log('== view="summary" ==')
const summary = renderTree(configPage, { view: 'summary' }).text
check('summary 不含动作按钮', () => {
  if (summary.includes('立即检测') || summary.includes('立即切换')) throw new Error('渲染了完整页')
})
check('summary 有状态文案', () => { if (!summary.includes('链路')) throw new Error(JSON.stringify(summary)) })

console.log('== view 缺失 / 未知（曾修过的降级缺陷）==')
// 判据：必须渲染出配置页骨架（「设置」折叠头 + 动作按钮），而不是摘要。
const noView = renderTree(configPage, {}).text
check('view 缺失 → 完整配置页', () => {
  if (!noView.includes('设置') || !noView.includes('立即检测')) {
    throw new Error('降级成摘要了: ' + noView.slice(0, 160))
  }
})
const oddView = renderTree(configPage, { view: 'whatever' }).text
check('未知 view → 完整配置页', () => {
  if (!oddView.includes('设置') || !oddView.includes('立即检测')) throw new Error('降级了')
})

console.log('== 横幅：单图标纯视觉 ==')
// 横幅没有可见文字；数值只进 data-* 和读屏文案（cfp-sr，视觉隐藏）。
// 筛可见文字要**按 cfp-sr 剔除**，不能按 aria-label 剔除——
// 单图标把 aria-label 挂到了里面的 button 上，根节点已经没有它了。
mount(banner, {})
await new Promise((r) => setTimeout(r, 60))
const bannerTree = renderTree(banner, {}).node
const bannerProps = bannerTree.props ?? {}
const bannerText = renderTree(banner, {}).text
const srSpans = []
;(function collectSr(node) {
  if (node == null || typeof node !== 'object') return
  if (String(node.props?.className ?? '').split(' ').includes('cfp-sr')) {
    srSpans.push(node.children ?? node.props?.children)
    return
  }
  const kids = node.children ?? []
  if (Array.isArray(kids)) kids.forEach(collectSr)
  else if (kids !== undefined) collectSr(kids)
})(bannerTree)
let visibleBanner = bannerText
for (const sr of srSpans) {
  const srText = Array.isArray(sr) ? sr.join('') : String(sr ?? '')
  if (srText !== '') visibleBanner = visibleBanner.split(srText).join('')
}
visibleBanner = visibleBanner.trim()

const bannerClasses = []
;(function walkBanner(node) {
  if (node == null || typeof node !== 'object') return
  const name = String(node.props?.className ?? '')
  if (name !== '') bannerClasses.push(...name.split(' '))
  if (typeof node.type === 'function') return walkBanner(node.type(node.props))
  const kids = node.children ?? []
  if (Array.isArray(kids)) kids.forEach(walkBanner)
  else if (kids !== undefined) walkBanner(kids)
})(bannerTree)

check('横幅无可见文字', () => {
  // 横幅里唯一的文字是 cfp-sr（视觉隐藏）与「测速中…」这类瞬时提示。
  // 待机态（本用例）必须是零可见文字。
  if (visibleBanner !== '') throw new Error(JSON.stringify(visibleBanner))
})
check('默认皮肤是辐条', () => {
  if (bannerProps['data-skin'] !== 'ring') throw new Error(String(bannerProps['data-skin']))
  if (!bannerClasses.includes('cfp-spokes')) throw new Error('缺少 cfp-ring')
})
check('三格点阵已删除', () => {
  for (const cls of ['cfp-current', 'cfp-cand', 'cfp-stream']) {
    if (bannerClasses.includes(cls)) throw new Error('残留 ' + cls)
  }
})
check('图标可点击（测速写入）', () => {
  let clickable = false
  ;(function scan(node) {
    if (node == null || typeof node !== 'object') return
    if (typeof node.props?.onClick === 'function') clickable = true
    const kids = node.children ?? []
    if (Array.isArray(kids)) kids.forEach(scan)
    else if (kids !== undefined) scan(kids)
  })(bannerTree)
  if (!clickable) throw new Error('图标不可点')
})
check('按钮读屏文案带两个延迟', () => {
  // aria-label 挂在 button 上，不再挂在根节点（根节点不是 role=img 了）。
  let label = ''
  ;(function scan(node) {
    if (node == null || typeof node !== 'object') return
    if (typeof node.props?.onClick === 'function' && node.props?.['aria-label']) {
      label = String(node.props['aria-label'])
    }
    const kids = node.children ?? []
    if (Array.isArray(kids)) kids.forEach(scan)
    else if (kids !== undefined) scan(kids)
  })(bannerTree)
  if (!label.includes('当前 220ms')) throw new Error(JSON.stringify(label))
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
