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

  return { React, renderComponent, instances }
}

// ------------------------------------------------- 把客户端插件装进假环境里

function loadPlugin() {
  const source = readFileSync(FILE, 'utf8')
  const { React, renderComponent, instances } = makeRuntime()
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

  return { slots, renderComponent, instances }
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
    switchesToday: 1,
    config: {
      autoWrite: false, currentProbeMs: 6000, candidateConcurrency: 2,
      roundIntervalMin: 5, switchThresholdMs: 150, maxSwitchesPerDay: 48,
      probeWhileThinking: false, skin: 'ring',
      addresses: [{ address: 'amr-link.open-design.ai', enabled: true }],
    },
    derived: { roundDurationMs: 150_000, candidateCount: 12, slotMs: 25_000, windowMs: 20_000 },
    hosts: { path: 'C:\\hosts', currentIps: ['162.159.1.1'], currentDomains: ['amr-link.open-design.ai'] },
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
function collect(tree, out = { classes: new Set(), attrs: {}, tags: new Set(), html: '' }) {
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

console.log('\n总失败数：' + failures)
process.exit(failures === 0 ? 0 : 1)