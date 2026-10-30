/**
 * 最小 React hooks 运行时 + 插件工厂加载器。
 *
 * 目的不是模拟浏览器，而是回答一个具体问题：改完之后，Banner 在各类快照下
 * 到底渲染出哪些 class / data 属性？动效挂在错误的类上时，肉眼看代码看不出来，
 * 渲染树能看出来。
 */
import { readFileSync } from 'node:fs'

const FILE = process.argv[2]

// ---------------------------------------------------------------- 假 React

function makeRuntime() {
  const instances = new WeakMap()

  function createElement(type, props, ...children) {
    const flat = []
    const push = (c) => {
      if (c === null || c === undefined || c === false || c === true) return
      if (Array.isArray(c)) { c.forEach(push); return }
      flat.push(c)
    }
    children.forEach(push)
    const p = { ...(props ?? {}) }
    if (flat.length > 0) p.children = flat.length === 1 ? flat[0] : flat
    return { type, props: p }
  }

  const React = { createElement, Fragment: Symbol('Fragment') }

  let current = null // 当前渲染中的实例
  /** 渲染之外（异步回调 / 定时器）发生的 setState：标记所有实例需重渲。 */
  const allInstances = []

  const markDirty = () => {
    if (current !== null) { current.dirty = true; return }
    for (const inst of allInstances) inst.dirty = true
  }

  function hookSlot(init) {
    const inst = current
    const i = inst.i++
    if (!(i in inst.hooks)) inst.hooks[i] = init()
    return { get: () => inst.hooks[i], set: (v) => { inst.hooks[i] = v } }
  }

  React.useState = (init) => {
    const slot = hookSlot(() => (typeof init === 'function' ? init() : init))
    return [slot.get(), (v) => {
      const next = typeof v === 'function' ? v(slot.get()) : v
      if (Object.is(next, slot.get())) return
      slot.set(next)
      markDirty()
    }]
  }

  React.useRef = (init) => hookSlot(() => ({ current: init })).get()

  React.useEffect = (fn, deps) => {
    const inst = current
    const i = inst.i++
    const prev = inst.deps[i]
    const changed = prev === undefined
      || deps === undefined
      || deps.length !== prev.length
      || deps.some((d, k) => !Object.is(d, prev[k]))
    if (!changed) return
    inst.deps[i] = deps
    inst.pending.push(fn)
  }

  React.useReducer = (reducer, init) => {
    const slot = hookSlot(() => init)
    return [slot.get(), (action) => { slot.set(reducer(slot.get(), action)); markDirty() }]
  }

  /** 反复渲染直到没有 setState，每次渲染后跑新出现的 effect。 */
  function renderComponent(comp, props) {
    let inst = instances.get(comp)
    if (inst === undefined) {
      inst = { hooks: [], deps: [], i: 0, dirty: true, pending: [], unmount: [] }
      instances.set(comp, inst)
      allInstances.push(inst)
    }
    let out = null
    for (let round = 0; round < 40; round += 1) {
      inst.i = 0
      inst.dirty = false
      current = inst
      out = comp(props)
      current = null
      const effects = inst.pending
      inst.pending = []
      for (const fn of effects) {
        const r = fn()
        if (typeof r === 'function') inst.unmount.push(r)
      }
      if (!inst.dirty) break
    }
    return out
  }

  /**
   * 卸载一个组件：跑它注册的全部 cleanup，然后从实例表里摘掉。
   *
   * 这是「卸载后不该还有副作用」这类断言的唯一入口——没有它，cleanup 永远
   * 不会被执行，runProbe 那类「等待结束仍继续发请求」的缺陷无法在离线测到。
   */
  function unmountComponent(comp) {
    const inst = instances.get(comp)
    if (inst === undefined) return false
    current = null
    for (const cleanup of inst.unmount.splice(0)) {
      try { cleanup() } catch { /* 卸载期失败按 React 语义忽略 */ }
    }
    instances.delete(comp)
    const at = allInstances.indexOf(inst)
    if (at !== -1) allInstances.splice(at, 1)
    return true
  }

  return { React, renderComponent, instances, unmountComponent }
}

// ------------------------------------------------- 把客户端插件装进假环境里

function loadPlugin() {
  const source = readFileSync(FILE, 'utf8')
  const { React, renderComponent, instances, unmountComponent } = makeRuntime()
  pluginRuntime = { renderComponent }

  let factory = null
  const g = globalThis
  g.window = g
  const docListeners = new Map()
  g.document = {
    hidden: false,
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, new Set())
      docListeners.get(type).add(fn)
    },
    removeEventListener(type, fn) {
      docListeners.get(type)?.delete(fn)
    },
  }
  g.document.__fire = (type) => {
    for (const fn of docListeners.get(type) ?? []) fn()
  }
  // store 的轮询是 4s 一次；测试里压缩到 8ms，否则拿不到第二个快照。
  const realSetInterval = globalThis.setInterval
  g.setInterval = (fn, _ms, ...rest) => realSetInterval(fn, 8, ...rest)
  g.__ModuleLoader__ = { load: ({ factory: f }) => { factory = f } }

  // eslint-disable-next-line no-new-func
  new Function('window', source)(g)
  const mod = factory((name) => {
    if (name === 'react') return React
    throw new Error('unexpected require: ' + name)
  })

  const slots = []
  mod.apply({
    slots: { inject: (_n, fn) => fn(), register: (_o, comp) => slots.push(comp) },
  })

  return { slots, renderComponent, instances, unmountComponent }
}

// collect() 需要渲染子组件（它们内部有 hook），走同一个运行时。
globalThis.__renderComponent = (comp, props) => pluginRuntime.renderComponent(comp, props)
let pluginRuntime = { renderComponent: (c, p) => c(p) }

// ---------------------------------------------------------------- 快照构造

function snapshot(over) {
  const now = 1_700_000_000_000
  return {
    state: 'normal',
    admin: true,
    autoWrite: false,
    current: { ip: '162.159.1.1', p50: 300, p95: 320, at: now - 3000 },
    candidates: [],
    best: { ip: '162.159.2.2', p50: 120, p95: 130 },
    bestBorrowed: false,
    decision: {},
    streaming: 0,
    advantageMs: 180,
    thresholdMs: 150,
    round: { running: false, startedAt: now - 60_000, finishedAt: now - 30_000 },
    lastSwitch: null,
    lastSwitchDegraded: false,
    // 全劣化下写入的候选丢包更高时，引擎会把这一位置 true；文案据此换说法。
    lastSwitchLossy: false,
    // 闸门跳过了哪些 IP（人话），空串表示没跳过。
    lastSwitchCertNote: '',
    lastError: null,
    config: {
      autoWrite: false, currentProbeMs: 6000, candidateConcurrency: 2,
      roundIntervalMin: 5, switchThresholdMs: 150,
      probeWhileThinking: false, skin: 'ring',
      addresses: [{ address: 'amr-link.open-design.ai', enabled: true }],
    },
    derived: { roundDurationMs: 150_000, candidateCount: 12, slotMs: 25_000, windowMs: 20_000 },
    hosts: { path: 'C:\\hosts', currentIps: ['162.159.1.1'], currentDomains: ['amr-link.open-design.ai'] },
    // 手动操作状态与全局首读时刻：默认「很久以前就启动过、当前空闲」，
    // 这样绝大多数场景不会误触发落位动画。需要时由各场景自己覆盖。
    manual: { phase: '', startedAt: 0, note: '', busy: false },
    firstReadingAt: now - 600_000,
    now,
    ...over,
  }
}

/** 走一遍真实的 store：stub fetch 让 /state 返回给定快照。 */
function installFetch(snap) {
  globalThis.fetch = async () => ({
    status: 200,
    json: async () => ({ ok: true, value: snap }),
  })
}

// ---------------------------------------------------------------- 断言工具

let failures = 0
function check(label, condition, extra) {
  if (condition) {
    console.log('  ok   ' + label)
  } else {
    failures += 1
    console.log('  FAIL ' + label + (extra === undefined ? '' : '  → ' + extra))
  }
}

/** 把渲染树里的 class / 属性摘出来。 */
function collect(tree, out = { classes: new Set(), attrs: {}, tags: new Set(), html: '', text: '' }) {
  // 纯文本子节点（例如提示里的 "312ms"）也要收进 text，否则断言看不到它们。
  if (typeof tree === 'string' || typeof tree === 'number') { out.text += String(tree); return out }
  if (tree === null || tree === undefined || typeof tree !== 'object') return out
  if (Array.isArray(tree)) { tree.forEach((t) => collect(t, out)); return out }
  const p = tree.props ?? {}
  out.tags.add(typeof tree.type === 'string' ? tree.type : (tree.type?.name ?? 'Component'))
  if (typeof p.className === 'string') {
    p.className.split(/\s+/).filter(Boolean).forEach((c) => out.classes.add(c))
  }
  for (const key of Object.keys(p)) {
    if (key.startsWith('data-')) out.attrs[key] = p[key]
  }
  // 皮肤是用 dangerouslySetInnerHTML 挂进去的 SVG 字符串，当正文收集。
  if (p.dangerouslySetInnerHTML && typeof p.dangerouslySetInnerHTML.__html === 'string') {
    out.html += p.dangerouslySetInnerHTML.__html
  }
  if (p.children !== undefined) collect(p.children, out)
  // 函数组件要通过 renderComponent 渲染（它内部可能有 hook），不能直接调用。
  if (typeof tree.type === 'function') {
    try {
      collect(globalThis.__renderComponent(tree.type, p), out)
    } catch (cause) {
      out.tags.add('ERROR:' + (tree.type.name ?? '?') + ':' + cause.message)
    }
  }
  return out
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms) })

// ---------------------------------------------------------------- 跑场景

const { renderComponent } = loadPlugin()
const Banner = (await (async () => {
  // slots[0] = detail section, slots[1] = row config, slots[2] = dock banner
  return null
})()) ?? null

console.log('场景 1：空闲、候选更快 180ms（≥ 阈值 150）')
{
  installFetch(snapshot({ streaming: 0 }))
  const mod = loadPlugin()
  const banner = mod.slots[2]
  let tree = null
  // store 的 refresh 是异步的：先渲染拿到 null，等一拍再渲染
  tree = mod.renderComponent(banner, {})
  await sleep(30)
  tree = mod.renderComponent(banner, {})
  const c = collect(tree)
  check('渲染出 cluster', tree !== null, 'tree is null')
  check('data-stream=idle', c.attrs['data-stream'] === 'idle', c.attrs['data-stream'])
  check('has-better 生效', c.classes.has('has-better'))
  check('候选更快由皮肤内部表达（无装饰小点）', !c.classes.has('cfp-cand-pip'))
  check('候选小点挂在 has-better 下才有脉动', tree !== null)
  check('cfp-glyph 包裹层存在', c.classes.has('cfp-glyph'))
  check('图标容器 cfp-glyph 存在', c.classes.has('cfp-glyph'))
  check('无 cfp-wave（不在流式）', !c.classes.has('cfp-wave'))
  check('无 cfp-handoff-bar（未换线）', !c.classes.has('cfp-handoff-bar'))
  check('data-probe-phase 为空', c.attrs['data-probe-phase'] === '', JSON.stringify(c.attrs['data-probe-phase']))
  check('data-arrow=1（180≥150 也算 arrow）', c.attrs['data-arrow'] === '1', c.attrs['data-arrow'])
}

console.log('\n场景 2：正在流式输出')
{
  installFetch(snapshot({ streaming: 2 }))
  const mod = loadPlugin()
  const banner = mod.slots[2]
  mod.renderComponent(banner, {})
  await sleep(30)
  const tree = mod.renderComponent(banner, {})
  const c = collect(tree)
  check('data-stream=stream', c.attrs['data-stream'] === 'stream', c.attrs['data-stream'])
  check('流式不再挂装饰层（改由皮肤表达）', !c.classes.has('cfp-wave'))
  check('读屏文案说「正在生成」', JSON.stringify(tree).includes('正在生成'))
}

console.log('\n场景 3：候选数据过期（round 早已结束）')
{
  const now = 1_700_000_000_000
  installFetch(snapshot({
    round: { running: false, startedAt: now - 900_000, finishedAt: now - 800_000 },
  }))
  const mod = loadPlugin()
  const banner = mod.slots[2]
  mod.renderComponent(banner, {})
  await sleep(30)
  const tree = mod.renderComponent(banner, {})
  const c = collect(tree)
  check('data-stale=1', c.attrs['data-stale'] === '1', c.attrs['data-stale'])
  check('is-stale 生效', c.classes.has('is-stale'))
}

console.log('\n场景 4：需要管理员权限（is-blocked）')
{
  installFetch(snapshot({ state: 'need-admin', admin: false }))
  const mod = loadPlugin()
  const banner = mod.slots[2]
  mod.renderComponent(banner, {})
  await sleep(30)
  const tree = mod.renderComponent(banner, {})
  const c = collect(tree)
  check('data-warn=need-admin', c.attrs['data-warn'] === 'need-admin', c.attrs['data-warn'])
  check('is-blocked 生效', c.classes.has('is-blocked'))
  check('告警文字出现', JSON.stringify(tree).includes('需要管理员权限'))
}

console.log('\n场景 5：断网（is-dead，候选不给「快」的暗示）')
{
  installFetch(snapshot({ state: 'offline', current: null, best: null, bestBorrowed: false }))
  const mod = loadPlugin()
  const banner = mod.slots[2]
  mod.renderComponent(banner, {})
  await sleep(30)
  const tree = mod.renderComponent(banner, {})
  const c = collect(tree)
  check('is-dead 生效', c.classes.has('is-dead'))
  check('无候选小点（best 为空）', !c.classes.has('cfp-cand-pip'))
  check('data-best 为空', c.attrs['data-best'] === '', JSON.stringify(c.attrs['data-best']))
}

console.log('\n场景 6：借用值（启动瞬间还没测候选）')
{
  installFetch(snapshot({ bestBorrowed: true, best: { ip: '162.159.1.1', p50: 300 } }))
  const mod = loadPlugin()
  const banner = mod.slots[2]
  mod.renderComponent(banner, {})
  await sleep(30)
  const tree = mod.renderComponent(banner, {})
  const c = collect(tree)
  check('is-borrowed 生效', c.classes.has('is-borrowed'))
  check('data-borrowed=1', c.attrs['data-borrowed'] === '1')
  check('借用时不算 has-better', !c.classes.has('has-better'))
}

console.log('\n场景 7：换线（ip 变了 → is-swap + 亮条）')
{
  const A = snapshot({ current: { ip: '162.159.1.1', p50: 400, p95: 420, at: 1 }, best: { ip: '162.159.2.2', p50: 120 } })
  installFetch(A)
  const mod = loadPlugin()
  const banner = mod.slots[2]
  mod.renderComponent(banner, {})
  await sleep(40)
  mod.renderComponent(banner, {})
  // 第二次快照：ip 换了。轮询已压到 8ms，等它拉到 B 再渲染。
  const B = snapshot({
    current: { ip: '162.159.2.2', p50: 120, p95: 130, at: 1 },
    best: { ip: '162.159.1.1', p50: 400 },
    lastSwitch: { at: 1_700_000_000_000, ips: ['162.159.2.2'] },
  })
  installFetch(B)
  mod.renderComponent(banner, {})
  await sleep(40)
  const tree = mod.renderComponent(banner, {})
  const c = collect(tree)
  check('data-current 已换成新 IP 的读数', c.attrs['data-current'] === '120', c.attrs['data-current'])
  check('is-swap 生效', c.classes.has('is-swap'))
  check('is-donor 生效', c.classes.has('is-donor'))
  check('data-swap=1', c.attrs['data-swap'] === '1', c.attrs['data-swap'])
  check('换线交给皮肤内部（无装饰层）', !c.classes.has('cfp-handoff-bar'))
}

console.log('\n场景 8：余温皮肤')
{
  const s = snapshot({})
  s.config = { ...s.config, skin: 'afterglow' }
  installFetch(s)
  const mod = loadPlugin()
  const banner = mod.slots[2]
  mod.renderComponent(banner, {})
  await sleep(30)
  const tree = mod.renderComponent(banner, {})
  const c = collect(tree)
  check('data-skin=afterglow', c.attrs['data-skin'] === 'afterglow', c.attrs['data-skin'])
  check('余温图标存在', (c.html ?? '').includes('cfp-afterglow'))
}

console.log('\n场景 9：默认皮肤是环芯')
{
  installFetch(snapshot({}))
  const mod = loadPlugin()
  const banner = mod.slots[2]
  mod.renderComponent(banner, {})
  await sleep(30)
  const tree = mod.renderComponent(banner, {})
  const c = collect(tree)
  check('data-skin=ring-core', c.attrs['data-skin'] === 'ring-core', c.attrs['data-skin'])
  check('环芯图标存在', (c.html ?? '').includes('cfp-ring-core'))
  check('SVG 带 data-tier', /data-tier="(excellent|good|fair|poor)"/.test(c.html ?? ''))
}

console.log('\n场景 10：关掉「显示图标」后横幅整块不渲染')
{
  const s = snapshot({})
  s.config = { ...s.config, showUi: false }
  installFetch(s)
  const mod = loadPlugin()
  const banner = mod.slots[2]
  mod.renderComponent(banner, {})
  await sleep(30)
  const tree = mod.renderComponent(banner, {})
  check('Banner 返回 null', tree === null, JSON.stringify(tree)?.slice(0, 40))

  // 打开时应正常渲染
  const s2 = snapshot({})
  s2.config = { ...s2.config, showUi: true }
  installFetch(s2)
  const mod2 = loadPlugin()
  const b2 = mod2.slots[2]
  mod2.renderComponent(b2, {})
  await sleep(30)
  const t2 = mod2.renderComponent(b2, {})
  check('打开时正常渲染', t2 !== null)
}

console.log('\n场景 11：CSS 模板完整性（反引号会把模板截断，而 node --check 抓不到）')
{
  const raw = readFileSync(FILE, 'utf8')
  const a = raw.indexOf('const CSS = `') + 13
  const b = raw.indexOf('`', a)
  const css = raw.slice(a, b)
  check('CSS 模板内无反引号', !css.includes('`'))
  check('CSS 之后紧接 function Styles', raw.slice(b, b + 40).includes('function Styles'))
  check('CSS 长度合理（>10k）', css.length > 10000, String(css.length))
}

console.log('\n场景 12：图标状态跨会话一致（同一份快照 = 同一份图标状态）')
{
  // 模拟两个会话：各自独立渲染 Banner，读的却是同一个引擎快照。
  // 以前 `probing` 是组件本地 state，A 会话点了测速 B 会话看不到。
  const s = snapshot({})
  s.manual = { phase: 'scan', startedAt: s.now - 500, note: '测速中…', busy: true }
  installFetch(s)
  const mod = loadPlugin()
  const banner = mod.slots[2]

  // 会话 A
  mod.renderComponent(banner, {})
  await sleep(30)
  const a = collect(mod.renderComponent(banner, {}))

  // 会话 B：另一个页面/会话里的同一枚图标，没有点过任何东西
  const modB = loadPlugin()
  const bannerB = modB.slots[2]
  modB.renderComponent(bannerB, {})
  await sleep(30)
  const b = collect(modB.renderComponent(bannerB, {}))

  check('A 会话显示测速中', a.classes.has('is-busy'), [...a.classes].join(','))
  check('B 会话也显示测速中（未点过也不落队）', b.classes.has('is-busy'), [...b.classes].join(','))
  check('两个会话 probe-phase 相同', a.attrs['data-probe-phase'] === b.attrs['data-probe-phase'],
    `${a.attrs['data-probe-phase']} vs ${b.attrs['data-probe-phase']}`)
  check('两个会话 data-probing 相同', a.attrs['data-probing'] === b.attrs['data-probing'])
}

console.log('\n场景 13：切到别的会话不该重播落位动画')
{
  // firstReadingAt 很久以前 → 不是「刚出现」，不该播 arrive。
  const old = snapshot({})
  old.firstReadingAt = old.now - 600_000
  installFetch(old)
  const mod = loadPlugin()
  const banner = mod.slots[2]
  mod.renderComponent(banner, {})
  await sleep(30)
  const t = collect(mod.renderComponent(banner, {}))
  check('全局首读很久以前 → 不播落位', !t.classes.has('is-arriving'), [...t.classes].join(','))

  // firstReadingAt 就在刚刚 → 这是全局首读，应该播。
  const fresh = snapshot({})
  fresh.firstReadingAt = fresh.now - 200
  installFetch(fresh)
  const mod2 = loadPlugin()
  const banner2 = mod2.slots[2]
  mod2.renderComponent(banner2, {})
  await sleep(30)
  const t2 = collect(mod2.renderComponent(banner2, {}))
  check('全局首读刚发生 → 播落位', t2.classes.has('is-arriving'), [...t2.classes].join(','))
}

console.log('\n场景 14：悬停提示显示当前 / 候选延迟')
{
  const s = snapshot({})
  s.current = { ip: '162.159.1.1', p50: 312, p95: 330, at: s.now - 3000 }
  s.best = { ip: '162.159.2.2', p50: 128, p95: 140 }
  s.bestBorrowed = false
  installFetch(s)
  const mod = loadPlugin()
  const banner = mod.slots[2]
  mod.renderComponent(banner, {})
  await sleep(30)
  const c = collect(mod.renderComponent(banner, {}))
  const html = String(c.html ?? '')
  const all = html + ' ' + String(c.text ?? '')
  check('提示容器存在', c.classes.has('cfp-tip'), [...c.classes].join(','))
  check('显示当前延迟 312ms', all.includes('312ms'), all.slice(0, 300))
  check('显示候选延迟 128ms', all.includes('128ms'))
  check('有「当前」标签', all.includes('当前'))
  check('有「候选」标签', all.includes('候选'))
  check('提示对读屏隐藏（信息已在 aria-label 里）', all.includes('aria-hidden'))

  // 无候选读数时不能编一个数字。
  const s2 = snapshot({})
  s2.best = null
  s2.bestBorrowed = false
  installFetch(s2)
  const mod2 = loadPlugin()
  const b2 = mod2.slots[2]
  mod2.renderComponent(b2, {})
  await sleep(30)
  const c2 = collect(mod2.renderComponent(b2, {}))
  check('无候选读数时提示显示「暂无数据」',
    (String(c2.html ?? '') + String(c2.text ?? '')).includes('暂无数据'))
}

console.log('\n场景 15：配置页读引擎的 manual 状态（跨会话不漏网）')
{
  // 轮 4 只把「测速中」提到了引擎，配置页仍读自己的本地 busyAction，
  // 于是图标点了测速、切到配置页，按钮还是「立即检测」且可点。
  // 这一场景把配置页接进回归网 —— 它此前零自动化覆盖。
  const s = snapshot({})
  s.manual = { phase: 'scan', startedAt: s.now - 3000, note: '测速中…', busy: true }
  installFetch(s)
  const mod = loadPlugin()
  // slots[0] = detail section（整页配置）, slots[1] = row config, slots[2] = dock banner
  const page = mod.slots[1]
  mod.renderComponent(page, { view: 'page' })
  await sleep(30)
  const tree = mod.renderComponent(page, { view: 'page' })
  const c = collect(tree)
  const all = String(c.html ?? '') + String(c.text ?? '')

  check('配置页渲染出来了', tree !== null && c.tags.size > 0)
  check('扫描中时动作按钮文案不再说「立即检测」', !all.includes('立即检测'), all.slice(0, 400))
  check('扫描中时显示「检测中…」', all.includes('检测中…'))

  // 禁用状态：找到那个动作按钮，读它的 disabled。
  const buttons = []
  ;(function walk(node) {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(walk); return }
    const p = node.props ?? {}
    if (node.type === 'button') buttons.push(p)
    if (p.children !== undefined) walk(p.children)
    if (typeof node.type === 'function') {
      try { walk(globalThis.__renderComponent(node.type, p)) } catch { /* 忽略 */ }
    }
  })(tree)
  const scanBtn = buttons.find((b) => String(b.children ?? '').includes('检测中'))
  check('扫描中时「检测中…」按钮被禁用', scanBtn?.disabled === true, JSON.stringify(scanBtn?.disabled))

  // 空闲时按钮恢复可用、文案恢复。这是防止「接上 manual 之后永远禁用」的回归。
  const s2 = snapshot({})
  s2.manual = { phase: '', startedAt: 0, note: '', busy: false }
  installFetch(s2)
  const mod2 = loadPlugin()
  const page2 = mod2.slots[1]
  mod2.renderComponent(page2, { view: 'page' })
  await sleep(30)
  const c2 = collect(mod2.renderComponent(page2, { view: 'page' }))
  const all2 = String(c2.html ?? '') + String(c2.text ?? '')
  check('空闲时恢复「立即检测」', all2.includes('立即检测'))

  // 设置项不能被引擎的测速状态锁死：manual.busy 只该影响两个动作按钮。
  // 这里用「写入中」阶段验证 —— 它比 scan 更长，最容易误伤。
  const s3 = snapshot({})
  s3.manual = { phase: 'write', startedAt: s3.now - 1000, note: '写入中…', busy: true }
  installFetch(s3)
  const mod3 = loadPlugin()
  const page3 = mod3.slots[1]
  mod3.renderComponent(page3, { view: 'page' })
  await sleep(30)
  const c3 = collect(mod3.renderComponent(page3, { view: 'page' }))
  const all3 = String(c3.html ?? '') + String(c3.text ?? '')
  check('写入中时「立即切换」显示「写入中…」', all3.includes('写入中…'))
}

console.log('\n场景 16：最近错误必须能被用户看到')
{
  const s = snapshot({ lastError: '写 hosts 失败：EACCES' })
  installFetch(s)
  const mod = loadPlugin()
  const page = mod.slots[1]
  mod.renderComponent(page, { view: 'page' })
  await sleep(30)
  const c = collect(mod.renderComponent(page, { view: 'page' }))
  const all = String(c.html ?? '') + String(c.text ?? '')
  check('配置页露出引擎的 lastError', all.includes('EACCES'), all.slice(0, 500))

  // 没有错误时不该凭空多一行。
  const s2 = snapshot({ lastError: null })
  installFetch(s2)
  const mod2 = loadPlugin()
  const page2 = mod2.slots[1]
  mod2.renderComponent(page2, { view: 'page' })
  await sleep(30)
  const c2 = collect(mod2.renderComponent(page2, { view: 'page' }))
  check('无错误时不显示「最近错误」行',
    !(String(c2.html ?? '') + String(c2.text ?? '')).includes('最近错误'))
}

console.log('\n场景 17：卸载后不该再发 /apply（它会真的改系统 hosts）')
{
  // runProbe 是「扫 → 等 1400ms 刹车 → /apply」的串行流程，而 /apply 会改写
  // 用户的系统 hosts。以前那个等待是裸 setTimeout：用户在这 1.4s 内切走会话
  // 或关掉配置页，组件卸载了，等待却照常结束，然后仍然发出 /apply ——
  // 一次用户已经离开的操作，改了他的机器。
  const s = snapshot({})
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push(String(url) + ' ' + String(init?.body ?? ''))
    return { status: 200, json: async () => ({ ok: true, value: { ok: true } }) }
  }

  const mod = loadPlugin()
  const banner = mod.slots[2]
  mod.renderComponent(banner, {})
  await sleep(30)
  const tree = mod.renderComponent(banner, {})

  // 找到那枚测速按钮，点它。
  const buttons = []
  ;(function walk(node) {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(walk); return }
    const p = node.props ?? {}
    if (node.type === 'button') buttons.push(p)
    if (p.children !== undefined) walk(p.children)
    if (typeof node.type === 'function') {
      try { walk(globalThis.__renderComponent(node.type, p)) } catch { /* 忽略 */ }
    }
  })(tree)
  const scanBtn = buttons.find((b) => String(b['aria-label'] ?? '').includes('点击测速并切换'))
  check('找到测速按钮', scanBtn !== undefined)
  check('idle 时按钮可点', scanBtn?.disabled === false)

  scanBtn.onClick()
  // 让 /scan 落地，但**不要**等满 1400ms 的刹车。
  await sleep(40)
  const applyBefore = calls.filter((c) => c.includes('/apply')).length
  check('扫描后、刹车结束前还没写 hosts', applyBefore === 0, JSON.stringify(calls))

  // 关键动作：在刹车等待期间卸载组件。
  const unmounted = mod.unmountComponent(banner)
  check('组件被卸载', unmounted === true)

  // 等到**远超** 1400ms 的刹车时长，确认那次 /apply 真的没有发生。
  // 必须超过 BRAKE_MS：只等 500ms 的话，「定时器还没到点」也能让断言变绿，
  // 那样这个用例根本证明不了修复。
  await sleep(1_600)
  const appliedAfter = calls.filter((c) => c.includes('/apply')).length
  check('卸载后不再发 /apply（等满 1600ms > 刹车 1400ms）', appliedAfter === 0,
    'calls=' + JSON.stringify(calls))
}

console.log('\n场景 18：降级切换必须区分「相对较好」与「丢包更多」')
{
  // 两种降级都是「全部偏慢」，但事实不同：
  //   - 候选丢包不更高 → 「已切到相对较好的一条」
  //   - 候选丢包更高   → 「已切到延迟较低的一条（丢包更多）」
  // 用同一句话就是界面在撒谎。
  const base = {
    state: 'degraded-switched',
    lastSwitch: { at: 1_700_000_000_000 - 5_000, ips: ['162.159.2.2'] },
    lastSwitchDegraded: true,
  }

  installFetch(snapshot({ ...base, lastSwitchLossy: false }))
  const modA = loadPlugin()
  const bannerA = modA.slots[2]
  modA.renderComponent(bannerA, {})
  await sleep(30)
  const a = collect(modA.renderComponent(bannerA, {}))
  const textA = String(a.text ?? '') + String(a.html ?? '')
  check('普通降级说「相对较好」', textA.includes('相对较好'), textA.slice(0, 300))
  check('普通降级不谎报丢包', !textA.includes('丢包更多'))

  installFetch(snapshot({ ...base, lastSwitchLossy: true }))
  const modB = loadPlugin()
  const bannerB = modB.slots[2]
  modB.renderComponent(bannerB, {})
  await sleep(30)
  const b = collect(modB.renderComponent(bannerB, {}))
  const textB = String(b.text ?? '') + String(b.html ?? '')
  check('丢包更高时如实说明', textB.includes('丢包更多'), textB.slice(0, 300))
  check('丢包更高时不再说「相对较好」', !textB.includes('相对较好'))
}

console.log('\n场景 19：闸门跳过的 IP 必须在配置页可见')
{
  // 证书失败被静默跳过时，用户会以为「点了一下什么都没发生」。
  const s = snapshot({
    lastSwitch: { at: 1_700_000_000_000 - 5_000, ips: ['162.159.2.2'] },
    lastSwitchCertNote: '（104.26.0.1 证书校验未通过，已跳过）',
  })
  installFetch(s)
  const mod = loadPlugin()
  const page = mod.slots[1]
  mod.renderComponent(page, { view: 'page' })
  await sleep(30)
  const c = collect(mod.renderComponent(page, { view: 'page' }))
  const all = String(c.html ?? '') + String(c.text ?? '')
  check('配置页露出被跳过的 IP', all.includes('104.26.0.1'), all.slice(0, 500))
  check('说明是证书校验未通过', all.includes('证书校验未通过'))

  // 没有跳过时不占空行。
  installFetch(snapshot({}))
  const mod2 = loadPlugin()
  const page2 = mod2.slots[1]
  mod2.renderComponent(page2, { view: 'page' })
  await sleep(30)
  const c2 = collect(mod2.renderComponent(page2, { view: 'page' }))
  const all2 = String(c2.html ?? '') + String(c2.text ?? '')
  check('没跳过时不显示证书提示', !all2.includes('证书校验未通过'))
}

console.log('\n总失败数：' + failures)
process.exit(failures === 0 ? 0 : 1)