// 横幅是纯视觉的三格指示器：当前延迟 / 候选延迟 / 流式状态。
// 这里验证：没有可见文字、三格齐全、条长与状态跟着快照走、换线时播动效。
// 用法：node _tools/banner-check.mjs
import fs from 'node:fs'
import path from 'node:path'

let pass = 0, fail = 0
const check = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name) }
  catch (e) { fail++; console.log('  FAIL ' + name + ' -> ' + (e?.message ?? e)) }
}

// ---------------------------------------------------------- 替身 React
let hookIndex = 0
let slots = []
let effects = []
let pollers = []

const same = (a, b) => a === b || (Array.isArray(a) && Array.isArray(b)
  && a.length === b.length && a.every((v, i) => Object.is(v, b[i])))

const React = {
  Fragment: 'Fragment',
  createElement(type, props, ...children) {
    const flat = children.flat(Infinity)
      .filter((c) => c !== null && c !== undefined && c !== false && c !== true)
    const merged = { ...(props ?? {}) }
    if (flat.length === 1) merged.children = flat[0]
    else if (flat.length > 1) merged.children = flat
    if (typeof type === 'function') return type(merged)
    return { type, props: merged }
  },
  useState(init) {
    const i = hookIndex++
    if (!(i in slots)) slots[i] = init
    return [slots[i], (next) => { slots[i] = typeof next === 'function' ? next(slots[i]) : next }]
  },
  useReducer(_reduce, init) {
    const i = hookIndex++
    if (!(i in slots)) slots[i] = init
    return [slots[i], (next) => { slots[i] = typeof next === 'function' ? next(slots[i]) : next }]
  },
  useEffect(fn, deps) {
    const i = hookIndex++
    const prev = effects[i]
    if (!prev || !same(prev.deps, deps)) effects[i] = { deps, fn }
  },
  useRef(value) {
    const i = hookIndex++
    if (!(i in slots)) slots[i] = { current: value }
    return slots[i]
  },
}

function render(component, props) {
  hookIndex = 0
  effects = []
  const tree = component(props)
  const queue = effects.filter(Boolean)
  effects = []
  for (const entry of queue) entry.fn()
  return tree
}

function mount(component, props) {
  slots = []
  return render(component, props)
}

// ---------------------------------------------------------- 树遍历
function walk(node, fn) {
  if (node === null || typeof node !== 'object') return
  fn(node)
  const kids = node.props?.children
  if (Array.isArray(kids)) kids.forEach((kid) => walk(kid, fn))
  else if (kids !== undefined) walk(kids, fn)
}

const hasClass = (tree, cls) => {
  let found = false
  walk(tree, (node) => {
    if (String(node.props?.className ?? '').split(' ').includes(cls)) found = true
  })
  return found
}

const countClass = (tree, cls) => {
  let count = 0
  walk(tree, (node) => {
    if (String(node.props?.className ?? '').split(' ').includes(cls)) count += 1
  })
  return count
}

function textOf(node, visibleOnly) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map((kid) => textOf(kid, visibleOnly)).join('')
  if (node.type === 'style') return ''
  if (visibleOnly === true && String(node.props?.className ?? '').split(' ').includes('cfp-sr')) return ''
  return textOf(node.props?.children, visibleOnly)
}

// ---------------------------------------------------------- 假环境
let currentSnapshot = null
globalThis.window = {
  __ModuleLoader__: { load: (def) => { globalThis.__mod = def } },
  setInterval: (fn) => { pollers.push(fn); return pollers.length },
  clearInterval: () => {},
}
globalThis.document = { hidden: false, addEventListener: () => {}, removeEventListener: () => {} }
globalThis.fetch = async () => ({ status: 200, json: async () => ({ ok: true, value: currentSnapshot }) })

const base = () => ({
  state: 'normal', admin: true, autoWrite: true,
  current: { ip: '162.159.148.1', address: 'open-design.ai', p50: 410, p95: 440, loss: 0,
    samples: 91, at: Date.now() - 3000, durationMs: 1200, reliable: true },
  candidates: [{ ip: '162.159.144.1', colo: 'HKG', p50: 230, p95: 250, qualified: true, samples: 279, timeouts: 0 }],
  best: { ip: '162.159.144.1', p50: 230, p95: 250, colo: 'HKG' },
  decision: { write: false, reason: 'observing' },
  advantageMs: 180, thresholdMs: 150,
  round: { running: false, startedAt: Date.now() - 200000, finishedAt: Date.now() - 30000,
    durationMs: 150000, intervalMin: 5 },
  lastSwitch: { at: Date.now() - 300000, ips: ['162.159.148.1'] }, switchesToday: 0,
  config: { autoWrite: true, currentProbeMs: 6000, candidateConcurrency: 2, roundIntervalMin: 5,
    switchThresholdMs: 150, maxSwitchesPerDay: 12, probeWhileThinking: false,
    addresses: [{ address: 'open-design.ai', enabled: true }] },
  derived: { roundDurationMs: 150000, minRoundIntervalMin: 3, slotMs: 25000, windowMs: 20000, candidateCount: 12 },
  hosts: { path: 'x', currentIps: ['162.159.148.1'], currentDomains: ['open-design.ai'] },
  lastError: null, probeFailed: false, now: Date.now(),
})

// ---------------------------------------------------------- 装载
const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'client.js'), 'utf8')

/** 每个用例都重新装载：store 是模块级单例，复用会读到上一个用例的快照。 */
function loadBannerModule() {
  pollers = []
  delete globalThis.__mod
  new Function('window', 'document', 'fetch', src)(globalThis.window, globalThis.document, globalThis.fetch)
  const mod = globalThis.__mod.factory((n) => { if (n === 'react') return React; throw new Error(n) })
  let component = null
  mod.apply({
    slots: {
      inject: (_n, cb) => cb(),
      register: (options, c) => { if (options.name === 'conversation.input.dock') component = c; return () => {} },
    },
  })
  return component
}

const wait = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))

async function viewWith(patch) {
  currentSnapshot = { ...base(), ...patch }
  const component = loadBannerModule()
  const tree = mount(component, {})
  await wait()
  const settled = render(component, {})
  return { component, tree: settled }
}

// ---------------------------------------------------------- 用例
console.log('== 一个可见字都没有 ==')
{
  const { tree } = await viewWith({})
  check('可见文本为空', () => {
    const visible = textOf(tree, true)
    if (visible !== '') throw new Error(JSON.stringify(visible))
  })
  check('读屏文案仍在', () => {
    if (!textOf(tree).includes('当前 410ms')) throw new Error(JSON.stringify(textOf(tree)))
  })
  check('图标可点击（点击=测速写入，不再是纯展示）', () => {
    let clickable = false
    walk(tree, (node) => { if (typeof node.props?.onClick === 'function') clickable = true })
    if (!clickable) throw new Error('图标不可点')
  })
}

console.log('\n== 单图标：一颗同时读两侧 ==')
{
  const { tree } = await viewWith({})
  check('默认辐条，且不再有三格', () => {
    if (tree.props['data-skin'] !== 'ring') throw new Error(String(tree.props['data-skin']))
    if (countClass(tree, 'cfp-current') !== 0 || countClass(tree, 'cfp-cand') !== 0
      || countClass(tree, 'cfp-stream') !== 0) throw new Error('三格残留')
    if (countClass(tree, 'cfp-skin') !== 1) throw new Error('图标数量不对')
  })
  check('当前延迟 410 写进快照属性', () => {
    if (tree.props['data-current'] !== '410') throw new Error(String(tree.props['data-current']))
  })
  check('候选延迟 230 写进快照属性', () => {
    if (tree.props['data-best'] !== '230') throw new Error(String(tree.props['data-best']))
  })
  check('闲置时流式标记是 idle', () => {
    if (tree.props['data-stream'] !== 'idle') throw new Error(String(tree.props['data-stream']))
  })
  check('更快的候选 → data-arrow=1', () => {
    if (tree.props['data-arrow'] !== '1') throw new Error('没有标记有更好候选')
  })
  check('每个环点都带 style.fill（不能写成 fill 属性，var() 在属性里无效）', () => {
    const dots = []
    walk(tree, (node) => {
      if (String(node.props?.className ?? '').includes('cfp-spoke-lit')) dots.push(node)
    })
    if (dots.length === 0) throw new Error('一颗点都没画')
    for (const dot of dots) {
      const fill = dot.props?.style?.fill
      if (typeof fill !== 'string' || fill === '') {
        throw new Error('有点没有 style.fill，它会退回默认黑色')
      }
    }
  })
}

console.log('\n== 没有数据就不点灯 ==')
{
  const { tree } = await viewWith({
    state: 'cold-start',
    current: null, best: null, candidates: [],
    round: { running: true, startedAt: Date.now() - 3000, finishedAt: 0, durationMs: 150000, intervalMin: 5 },
  })
  check('当前延迟为空', () => {
    if (tree.props['data-current'] !== '') {
      throw new Error(JSON.stringify(tree.props['data-current']))
    }
  })
  check('候选延迟为空', () => {
    if (tree.props['data-best'] !== '') throw new Error(String(tree.props['data-best']))
  })
  check('一个亮点都不画（opacity 全 0）', () => {
    let lit = 0
    walk(tree, (node) => {
      const cls = String(node.props?.className ?? '')
      if (cls.includes('cfp-spoke-lit') && Number(node.props?.style?.opacity) > 0.02) lit += 1
    })
    if (lit !== 0) throw new Error(String(lit))
  })
}

console.log('\n== 候选过期 ==')
{
  const { tree } = await viewWith({
    round: { running: false, startedAt: Date.now() - 900000,
      finishedAt: Date.now() - 14 * 60_000, durationMs: 150000, intervalMin: 5 },
  })
  check('打上过期标记', () => {
    if (tree.props['data-stale'] !== '1') throw new Error('没有过期标记')
  })
  check('候选延迟仍然保留', () => {
    if (tree.props['data-best'] !== '230') throw new Error(String(tree.props['data-best']))
  })
}

console.log('\n== 状态映射到视觉 ==')
for (const [state, patch, cls] of [
  ['offline', {}, 'is-dead'],
  ['all-degraded', {}, 'is-alert'],
]) {
  const { tree } = await viewWith({ state, ...patch })
  check(state + ' → ' + cls, () => {
    if (!hasClass(tree, cls)) throw new Error('缺少 ' + cls)
  })
}

console.log('\n== 流式标记（皮肤不再有流式格，但状态仍要如实给出）==')
{
  const streaming = (await viewWith({ state: 'waiting-write' })).tree
  check('有回复在流 → stream', () => {
    // 皮肤里没有「流式格」这一格了，所以不再有 is-stream 类；
    // 但 data-stream 必须如实反映，方便宿主/读屏拿到。
    if (streaming.props['data-stream'] !== 'stream') {
      throw new Error(String(streaming.props['data-stream']))
    }
  })
  const idle = (await viewWith({ state: 'normal' })).tree
  check('没有回复 → idle', () => {
    if (idle.props['data-stream'] !== 'idle') throw new Error(String(idle.props['data-stream']))
  })

  // 关键回归：state 是 normal，但宿主报告 streaming > 0。
  // 这是模型正常输出时的常态，曾经因为它只读 waiting-write 而一直不亮。
  const live = (await viewWith({ state: 'normal', streaming: 1 })).tree
  check('normal 但 streaming>0 → stream（权威信号优先）', () => {
    if (live.props['data-stream'] !== 'stream') throw new Error(String(live.props['data-stream']))
  })
  const zero = (await viewWith({ state: 'normal', streaming: 0 })).tree
  check('streaming=0 → idle', () => {
    if (zero.props['data-stream'] !== 'idle') throw new Error(String(zero.props['data-stream']))
  })
  // 多路并发（子 agent/工具并行）时计数 >1 也应亮
  const many = (await viewWith({ state: 'normal', streaming: 3 })).tree
  check('streaming=3 → stream', () => {
    if (many.props['data-stream'] !== 'stream') throw new Error(String(many.props['data-stream']))
  })
}

console.log('\n== 换线：整颗图标播一次交接旋转 ==')
{
  currentSnapshot = { ...base(), best: { ip: '162.159.144.1', p50: 500, p95: 700, colo: 'HKG' }, advantageMs: 0 }
  const component = loadBannerModule()
  mount(component, {})
  await wait()
  const before = render(component, {})
  check('切换前不播交接动画', () => {
    if (before.props['data-swap'] !== '0' || hasClass(before, 'is-swap')) throw new Error('提前播了')
  })

  currentSnapshot = {
    ...base(),
    state: 'switched',
    current: { ip: '162.159.144.1', address: 'open-design.ai', p50: 240, p95: 300, loss: 0,
      samples: 9, at: Date.now(), durationMs: 20000, reliable: true },
    best: { ip: '162.159.144.1', p50: 240, p95: 300, colo: 'HKG' },
    lastSwitch: { at: Date.now(), ips: ['162.159.144.1'] },
    now: Date.now(),
  }
  await pollers[0]()
  await wait()
  render(component, {})
  const after = render(component, {})

  check('换线时打上 is-swap', () => {
    if (after.props['data-swap'] !== '1' || !hasClass(after, 'is-swap')) {
      throw new Error(String(after.props['data-swap']))
    }
  })
  check('新延迟已落到 data-* 上', () => {
    if (after.props['data-current'] !== '240') throw new Error(String(after.props['data-current']))
  })
  check('换线不再残留三格专用的光点 / 落弹 / 供体类', () => {
    if (countClass(after, 'cfp-orb') !== 0) throw new Error('残留 cfp-orb')
    if (hasClass(after, 'is-arrive')) throw new Error('残留 is-arrive')
    if (hasClass(after, 'is-donor')) throw new Error('残留 is-donor')
  })
}

console.log('\n== 告警文字 ==')
{
  // 纯视觉分不清「需要管理员」和「今天到上限」，这两类必须给字。
  const admin = await viewWith({ state: 'need-admin' })
  check('need-admin 有可见文字', () => {
    const text = textOf(admin.tree, true)
    if (!text.includes('管理员')) throw new Error('缺少告警文字: ' + JSON.stringify(text))
  })
  const limit = await viewWith({ state: 'daily-limit' })
  check('daily-limit 有可见文字', () => {
    const text = textOf(limit.tree, true)
    if (!text.includes('上限')) throw new Error(JSON.stringify(text))
  })
  const offlineWarn = await viewWith({ state: 'offline' })
  check('offline 有可见文字', () => {
    const text = textOf(offlineWarn.tree, true)
    if (!text.includes('网络')) throw new Error(JSON.stringify(text))
  })

  // 正常运行状态不该被打扰——一个可见字都不能有。
  for (const quiet of ['normal', 'observing', 'waiting-write', 'no-candidate']) {
    const v = await viewWith({ state: quiet })
    check(`${quiet} 保持纯视觉（无可见文字）`, () => {
      const text = textOf(v.tree, true).trim()
      if (text !== '') throw new Error('多出了文字: ' + JSON.stringify(text))
    })
  }
}

console.log('\n== 样式里写好了动效 ==')
check('换线 / 交接旋转关键帧', () => {
  if (!src.includes('@keyframes cfp-handoff-spin')) throw new Error('缺少交接旋转')
})
// 测速必须是「真的在转」，不是只有缩放——用户实测反馈「没有旋转，只有轻微缩放」。
// 设计稿是四段：加速 600ms → 匀速 620ms/圈 → 刹车 1400ms → 停。
check('测速是分段旋转（加速 / 匀速 / 刹车）', () => {
  if (!src.includes('@keyframes cfp-spin-up')) throw new Error('缺少测速起步加速')
  if (!src.includes('@keyframes cfp-spin-loop')) throw new Error('缺少测速匀速循环')
  if (!src.includes('@keyframes cfp-spin-brake')) throw new Error('缺少测速刹车')
  if (!/is-busy \.cfp-skin\{animation:cfp-spin-up/.test(src)) {
    throw new Error('测速旋转没绑到 is-busy 上')
  }
  if (!/is-busy\[data-probe-phase='brake'\] \.cfp-skin/.test(src)) {
    throw new Error('刹车阶段没绑定')
  }
})
check('降低动效时停掉单图标的所有动画', () => {
  if (!/prefers-reduced-motion[\s\S]{0,800}\.cfp-skin/.test(src)) throw new Error('缺少')
  if (!/prefers-reduced-motion[\s\S]{0,800}animation:none!important/.test(src)) {
    throw new Error('没有关掉动画')
  }
})
// 钉住的是「横幅盒子和输入框卡片是同一个盒子」这个契约，不是某一行 CSS 的写法。
// 挂点 conversation.input.dock 是 composerStack 的纵向 flex 项，会被拉伸到整条宽度；
// 只要缺了 max-width + 居中，点阵就会贴到窗口最左边（实测偏左 174.5px）。
check('横幅与输入框卡片同一个盒子', () => {
  const rule = /\.cfp-dock\{[^}]*\}/.exec(src)
  if (rule === null) throw new Error('缺少 cfp-dock')
  const css = rule[0]
  if (!/max-width:var\(--dsh-composer-card-max-width/.test(css)) {
    throw new Error('cfp-dock 必须用卡片的 max-width 定宽，否则会被拉伸成整条')
  }
  if (!/margin:0 auto/.test(css)) throw new Error('cfp-dock 必须居中，否则会贴左')
  if (!/width:calc\(100% - var\(--dsh-composer-side-clearance/.test(css)) {
    throw new Error('cfp-dock 宽度必须扣掉 side-clearance，与 inputBar 的横向 padding 对齐')
  }
  // 不能再退化成「整条铺满」或「绝对定位」——后者会盖住输入框。
  if (/position:absolute/.test(css)) throw new Error('cfp-dock 不能绝对定位，它要占 composerStack 自己那一行')
  if (/flex:1/.test(css)) throw new Error('cfp-dock 不能 flex:1，那会把内容推到整条边缘')
})

// 点阵的点必须真的看得见。
//
// 这一条是补一次真实事故：底点曾用 --dsw-alias-label-quaternary，而宿主题里
// **没有**声明这个变量（405 个已声明变量里不含它）。SVG 的 fill 拿到未定义变量
// 会退回默认**黑色**，在深色背景上就是「候选图标不显示了」——静态检查全过，
// 只有真实渲染才发现。所以这里钉两件事：
//   1. 底点/亮点不许再用那几个已知不存在的变量名；
//   2. 用了 var(--dsw-*) 的地方必须带兜底色，避免下次改名又静默变黑。
const DEAD_VARS = [
  '--dsw-alias-label-quaternary',
  '--dsw-alias-label-error',
  '--dsw-alias-fill-l2',
  '--dsw-alias-bg-l1',
  '--dsw-font-mono',
]
check('底点与亮点不使用不存在的主题变量', () => {
  for (const name of DEAD_VARS) {
    // 允许出现在注释里（解释历史），但不允许出现在 CSS 声明中。
    const bad = new RegExp('var\\(' + name + '[),]')
    if (bad.test(src)) throw new Error('用了宿主题里不存在的变量 ' + name)
  }
})
check('辐条的底点用了存在的主题变量并带兜底', () => {
  const base = /\.cfp-spoke-base\{[^}]*\}/.exec(src)
  if (base === null) throw new Error('缺少 .cfp-spoke-base')
  if (!/fill:var\(--dsw-[a-z0-9-]+,[^)]+\)/.test(base[0])) {
    throw new Error('.cfp-spoke-base 的 fill 必须带兜底色，变量缺失时不能退化成黑色')
  }
})
// 本轮的真实事故：`fill="var(--dsw-...)"` 写成 SVG **属性**。
// 表现属性不接受 var()，会被判非法并退回默认黑色——图标在深色底上整个消失。
// 正确做法是走 style（CSS 声明），所以亮点的颜色必须写在 style 里。
check('辐条亮点的颜色写在 style 里，不能写成 fill 属性', () => {
  const at = src.indexOf("className: 'cfp-spoke-lit'")
  if (at < 0) throw new Error('找不到 cfp-spoke-lit 的渲染代码')
  // 取这一处渲染往后的一段，看它用哪种方式给颜色
  const body = src.slice(at, at + 700)
  const beforeStyle = body.split('style:')[0] ?? ''
  if (/^\s*fill:/m.test(beforeStyle) || /,\s*fill:/.test(beforeStyle)) {
    throw new Error('cfp-spoke-lit 仍在用 fill 属性，var() 在属性里无效，会退回黑色')
  }
  if (!/style:\s*\{[\s\S]{0,200}?fill:/.test(body)) {
    throw new Error('cfp-spoke-lit 必须用 style.fill')
  }
})
// 太极的遮罩 id 必须稳定。每帧自增会让 mask 引用指向不存在的 id，
// 整块图形被裁掉——用户看到的就是「图标一闪而过然后消失」。
check('太极遮罩 id 用 useRef 固定，不在每次渲染时自增', () => {
  const fn = /function TaijiIcon[\s\S]{0,600}/.exec(src)
  if (fn === null) throw new Error('找不到 TaijiIcon')
  if (/taijiUid\s*\+=\s*1/.test(fn[0])) {
    throw new Error('TaijiIcon 仍在渲染时自增 id，mask 会失效')
  }
  if (!/useStableId\(\)/.test(fn[0])) throw new Error('TaijiIcon 没有使用稳定的遮罩 id')
})
check('太极的眼睛取两侧里更差的一档（方向不能反）', () => {
  const line = /const eyeTier = [^\n]+/.exec(src)
  if (line === null) throw new Error('找不到 eyeTier')
  if (!/>=\s*curQualityOrder\(bestTier\)/.test(line[0])) {
    throw new Error('取档方向反了，会把好的那侧用到两边')
  }
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)

