// 两套单图标皮肤（辐条 / 太极）与点击测速。
//
// 覆盖的是**新皮肤引入的三类风险**，不是重复 banner-check 已有的点阵断言：
//   1. 皮肤串台：config.skin 选错/写坏时横幅不能整块消失，必须退回 fan；
//   2. 两侧独立：左半读当前、右半读候选，绝不能把候选的值画到当前上；
//   3. 点击行为：点击必须走 scan → apply 两个真实接口，且失败时不能假装成功。
//
// 用法：node _tools/skin-check.mjs
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

const classesOf = (node) => String(node.props?.className ?? '').split(' ').filter(Boolean)

const countClass = (tree, cls) => {
  let count = 0
  walk(tree, (node) => { if (classesOf(node).includes(cls)) count += 1 })
  return count
}

const withClass = (tree, cls) => {
  const out = []
  walk(tree, (node) => { if (classesOf(node).includes(cls)) out.push(node) })
  return out
}

// ---------------------------------------------------------- 假环境
let currentSnapshot = null
let currentValue = null
const calls = []

globalThis.window = {
  __ModuleLoader__: { load: (def) => { globalThis.__mod = def } },
  setInterval: () => 1,
  clearInterval: () => {},
  setTimeout: (fn) => { void fn; return 1 },
  clearTimeout: () => {},
}
globalThis.document = { hidden: false, addEventListener: () => {}, removeEventListener: () => {} }
globalThis.fetch = async (url, init) => {
  const body = init?.body ? JSON.parse(init.body) : {}
  const key = String(url).split('/api/dsh-cf-pin/')[1]
  calls.push({ key, body })
  if (nextFetchError && nextFetchError.key === key) {
    const err = nextFetchError
    nextFetchError = null
    return { status: 200, json: async () => ({ ok: false, error: { code: err.code, message: err.message } }) }
  }
  if (key === 'state') return { status: 200, json: async () => ({ ok: true, value: currentSnapshot }) }
  return { status: 200, json: async () => ({ ok: true, value: currentValue ?? {} }) }
}
let nextFetchError = null

const base = (patch = {}) => ({
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
  lastError: null, probeFailed: false, streaming: 0, now: Date.now(),
  ...patch,
  // skin 是**配置项**，不是快照顶层字段；用例里写 { skin: 'ring' } 是一种简称，
  // 在这里折进 config，免得每条用例都写成 { config: { skin: 'ring' } }。
  config: {
    autoWrite: true, currentProbeMs: 6000, candidateConcurrency: 2, roundIntervalMin: 5,
    switchThresholdMs: 150, maxSwitchesPerDay: 12, probeWhileThinking: false, skin: 'fan',
    addresses: [{ address: 'open-design.ai', enabled: true }],
    ...(patch.config ?? {}),
    ...(patch.skin === undefined ? {} : { skin: patch.skin }),
  },
})

// ---------------------------------------------------------- 装载
const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'client.js'), 'utf8')

function loadBanner() {
  delete globalThis.__mod
  new Function('window', 'document', 'fetch', src)(globalThis.window, globalThis.document, globalThis.fetch)
  const mod = globalThis.__mod.factory((n) => {
    if (n === 'react') return React
    throw new Error(n)
  })
  let component = null
  mod.apply({
    slots: {
      inject: (_n, cb) => cb(),
      register: (options, c) => { if (options.name === 'conversation.input.dock') component = c; return () => {} },
    },
  })
  return component
}

const wait = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms))

async function viewWith(patch = {}) {
  calls.length = 0
  currentSnapshot = base(patch)
  const component = loadBanner()
  mount(component, {})
  await wait()
  return { component, tree: render(component, {}) }
}

/** 从皮肤属性里取 SVG 根节点，用来数点、读 fill。 */
const skinRoot = (tree) => withClass(tree, 'cfp-skin')[0] ?? null

// ---------------------------------------------------------- 用例

console.log('== 皮肤选择 ==')
{
  const dflt = (await viewWith({})).tree
  const ring = (await viewWith({ skin: 'ring' })).tree
  const taiji = (await viewWith({ skin: 'taiji' })).tree

  check('不指定时默认辐条', () => {
    if (dflt.props['data-skin'] !== 'ring') throw new Error(String(dflt.props['data-skin']))
    if (countClass(dflt, 'cfp-spokes') !== 1) throw new Error('没有辐条')
  })
  check('ring 渲染辐条、不再画三格', () => {
    if (ring.props['data-skin'] !== 'ring') throw new Error(String(ring.props['data-skin']))
    if (countClass(ring, 'cfp-spokes') !== 1) throw new Error('没有辐条')
    if (countClass(ring, 'cfp-current') !== 0 || countClass(ring, 'cfp-cand') !== 0) {
      throw new Error('三格仍在')
    }
  })
  check('taiji 渲染太极、不再画三格', () => {
    if (taiji.props['data-skin'] !== 'taiji') throw new Error(String(taiji.props['data-skin']))
    if (countClass(taiji, 'cfp-taiji') !== 1) throw new Error('没有太极')
    if (countClass(taiji, 'cfp-current') !== 0) throw new Error('三格仍在')
  })
  // 这一条是给「配置被手改成垃圾」兜底的：横幅宁可显示默认皮肤，也不能空白。
  // normalizeSkin 在后端做白名单，前端这里也必须自己再兜一次。
  // 注意：必须**串行**取值——viewWith 用的是模块级替身状态，并发会互相覆盖。
  const badResults = []
  for (const bad of [{ skin: 'nope' }, { skin: null }, { skin: 42 }, { skin: 'fan' }]) {
    badResults.push((await viewWith(bad)).tree)
  }
  check('皮肤写坏 / 已删除的 fan 都退回辐条，而不是整块消失', () => {
    badResults.forEach((t) => {
      if (t.props['data-skin'] !== 'ring') throw new Error('没退回 ring：' + t.props['data-skin'])
    })
  })
}

console.log('\n== 尺寸：两套皮肤都是 25px ==')
{
  const cssText = fs.readFileSync(path.join(import.meta.dirname, '..', 'client.js'), 'utf8')
  check('两套皮肤的显示尺寸都是 25px', () => {
    // 必须锚定到独立规则 `.cfp-skin{`，否则会先匹配到
    // `.cfp-cluster.is-dead .cfp-skin{opacity:.5}` 这类修饰规则。
    const rule = /(^|\n)\.cfp-skin\{[^}]*\}/.exec(cssText)
    if (rule === null) throw new Error('缺少 .cfp-skin')
    if (!/width:25px/.test(rule[0]) || !/height:25px/.test(rule[0])) {
      throw new Error('皮肤尺寸不是 25px：' + rule[0])
    }
    if (/30px/.test(rule[0])) throw new Error('皮肤仍是 30px')
  })
  check('点击区跟着收到 25px', () => {
    const btn = /(^|\n)\.cfp-skinBtn\{[^}]*\}/.exec(cssText)
    if (btn === null) throw new Error('缺少 .cfp-skinBtn')
    if (!/width:25px/.test(btn[0])) throw new Error('按钮不是 25px')
  })
}

console.log('\n== 辐条：形状来自 circle 的 02 方案 ==')
{
  const { tree } = await viewWith({ skin: 'ring' })
  const dots = withClass(tree, 'cfp-spoke-lit')
  check('两颗 = 每辐条 3 圈 + 圆心（左 5 根 + 右 5 根）', () => {
    // 10 根辐条 × 3 圈 + 1 个圆心 = 31 个点
    if (dots.length !== 31) throw new Error('点数 ' + dots.length)
  })
  check('左右两半各 5 根辐条（按 cx 分布在两侧）', () => {
    const left = dots.filter((d) => Number(d.props.cx) < 14.9).length
    const right = dots.filter((d) => Number(d.props.cx) > 15.1).length
    if (left !== 15 || right !== 15) throw new Error('left=' + left + ' right=' + right)
    // 圆心那颗 cx 正好 15
    if (dots.length - left - right !== 1) throw new Error('圆心点数量不对')
  })
  check('最外圈半径约 11.1（不会超出 30 坐标系）', () => {
    let max = 0
    dots.forEach((d) => {
      const x = Number(d.props.cx) - 15
      const y = Number(d.props.cy) - 15
      max = Math.max(max, Math.hypot(x, y))
    })
    if (max < 10.5 || max > 11.5) throw new Error('最外圈半径 ' + max.toFixed(2))
  })
}

console.log('\n== 两侧独立（辐条） ==')
{
  // 当前 900ms（差）、候选 200ms（优）。两侧点亮的环数必须不同，
  // 且左半的点要用当前的好坏、右半用候选的——绝不能都一样。
  const { tree } = await viewWith({
    skin: 'ring',
    current: { ip: 'x', address: 'a', p50: 900, p95: 950, loss: 0, samples: 40,
      at: Date.now() - 2000, durationMs: 900, reliable: true },
    best: { ip: 'y', p50: 200, p95: 220, colo: 'HKG' },
  })
  check('左半点亮的数量少于右半', () => {
    const dots = withClass(tree, 'cfp-spoke-lit')
    if (dots.length === 0) throw new Error('一颗点都没画')
    let leftLit = 0
    let rightLit = 0
    dots.forEach((dot) => {
      // 亮度与颜色都走 style（fill 属性不接受 var()，所以不能用 props.opacity/fill）
      const lit = Number(dot.props?.style?.opacity) > 0.5
      if (!lit) return
      if (Number(dot.props.cx) < 15) leftLit += 1
      else rightLit += 1
    })
    if (!(leftLit < rightLit)) throw new Error('left=' + leftLit + ' right=' + rightLit)
  })
  check('每颗点都带 style.fill（属性写法会退回黑色）', () => {
    const dots = withClass(tree, 'cfp-spoke-lit')
    if (dots.length === 0) throw new Error('一颗点都没画')
    for (const dot of dots) {
      if (typeof dot.props?.style?.fill !== 'string' || dot.props.style.fill === '') {
        throw new Error('有点缺少 style.fill')
      }
      if (dot.props.fill !== undefined) throw new Error('仍在用 fill 属性')
    }
  })
  check('每个点都有底点画在下面（没数据也有形状）', () => {
    const dotCount = countClass(tree, 'cfp-spoke-lit')
    const baseCount = countClass(tree, 'cfp-spoke-base')
    if (dotCount === 0 || dotCount !== baseCount) {
      throw new Error('lit=' + dotCount + ' base=' + baseCount)
    }
  })
}

console.log('\n== 两侧独立（太极） ==')
{
  const { tree } = await viewWith({
    skin: 'taiji',
    current: { ip: 'x', address: 'a', p50: 700, p95: 760, loss: 0, samples: 40,
      at: Date.now() - 2000, durationMs: 900, reliable: true },
    best: { ip: 'y', p50: 320, p95: 340, colo: 'HKG' },
  })
  check('左右各自的遮罩缺口数量不同', () => {
    const masks = withClass(tree, '')
    void masks
    // 遮罩是 <mask> 节点，用 type 找。
    const maskNodes = []
    walk(tree, (node) => { if (node.type === 'mask') maskNodes.push(node) })
    if (maskNodes.length !== 2) throw new Error('遮罩数 ' + maskNodes.length)
    const holeCount = (mask) => {
      const kids = mask.props?.children
      const list = Array.isArray(kids) ? kids : [kids]
      // 第一个是底白 rect，其余是洞
      return list.filter((kid) => kid && kid.type === 'circle').length
    }
    const a = holeCount(maskNodes[0])
    const b = holeCount(maskNodes[1])
    if (!(a !== b)) throw new Error('两侧缺口一样多：' + a + ' / ' + b)
    if (a === 0 && b === 0) throw new Error('两侧都没侵蚀')
  })
  check('眼睑取更差的一档（700ms → poor，0.2）', () => {
    const root = skinRoot(tree)
    if (!root) throw new Error('没有太极根节点')
    const eye = root.props?.style?.['--cfp-eye']
    if (eye !== '0.2') throw new Error('眼睑 ' + eye)
  })
  const bothGood = await viewWith({
    skin: 'taiji',
    current: { ip: 'x', address: 'a', p50: 200, p95: 220, loss: 0, samples: 40,
      at: Date.now() - 2000, durationMs: 900, reliable: true },
    best: { ip: 'y', p50: 300, p95: 320, colo: 'HKG' },
  })
  check('两侧都优时眼睑全开', () => {
    const root = skinRoot(bothGood.tree)
    if (!root) throw new Error('没有太极根节点')
    if (root.props?.style?.['--cfp-eye'] !== '1') throw new Error('眼睑 ' + root.props?.style?.['--cfp-eye'])
  })
}

console.log('\n== 点击测速 ==')
{
  const { tree } = await viewWith({ skin: 'ring' })
  const buttons = withClass(tree, 'cfp-skinBtn')
  check('皮肤模式下有一颗可点按钮', () => {
    if (buttons.length !== 1) throw new Error('按钮数 ' + buttons.length)
    if (typeof buttons[0].props.onClick !== 'function') throw new Error('没有 onClick')
  })
  check('按钮的读屏文案包含两侧读数', () => {
    const label = String(buttons[0].props['aria-label'] ?? '')
    if (!label.includes('当前') || !label.includes('候选')) throw new Error(label)
  })

  // 点击 → 必须依次调用 scan 与 apply。
  // 注意：scan 结束后有一段 1400ms 的刹车动画，apply 在它之后才发，
  // 所以这里要等够（这是设计稿的编排：转完了才写）。
  calls.length = 0
  currentValue = { candidates: [{ ip: '1.1.1.1' }] }
  buttons[0].props.onClick()
  await wait(1800)
  check('点击后先 scan 再 apply', () => {
    const keys = calls.map((c) => c.key).filter((k) => k !== 'state')
    if (keys[0] !== 'scan') throw new Error('第一个调用是 ' + keys[0])
    if (!keys.includes('apply')) throw new Error('没有 apply：' + keys.join(','))
  })
}

console.log('\n== 点击的失败路径 ==')
{
  const { tree } = await viewWith({ skin: 'ring' })
  const buttons = withClass(tree, 'cfp-skinBtn')
  // scan 直接失败：不能假装成功
  calls.length = 0
  nextFetchError = { key: 'scan', code: 'scan', message: 'boom' }
  buttons[0].props.onClick()
  await wait(120)
  check('scan 失败后不调用 apply', () => {
    const keys = calls.map((c) => c.key)
    if (keys.includes('apply')) throw new Error('还是写了：' + keys.join(','))
  })

  // apply 返回 needs-confirm（后端已删这道拦截，但万一旧版后端还在）：
  // 前端**不许**自己补一次带 confirm 的请求，也不许把它当成功。
  const view2 = await viewWith({ skin: 'ring' })
  const btn2 = withClass(view2.tree, 'cfp-skinBtn')[0]
  calls.length = 0
  currentValue = { candidates: [{ ip: '1.1.1.1' }] }
  nextFetchError = { key: 'apply', code: 'needs-confirm', message: '没有合格候选' }
  btn2.props.onClick()
  await wait(1800)
  check('遇到 needs-confirm 不擅自补发 confirm', () => {
    const applies = calls.filter((c) => c.key === 'apply')
    if (applies.length !== 1) throw new Error('apply 次数 ' + applies.length)
    if (applies[0].body?.confirm === true) throw new Error('擅自确认了')
    if (applies[0].body?.forced !== undefined) {
      // forced 由后端路由统一加，前端不该自己拼
      throw new Error('前端不该自己传 forced')
    }
  })
}

console.log('\n== 状态映射：两套皮肤都要一致 ==')
{
  // 每个状态都要在两套皮肤下产出**同样的**语义标记。这是防「换皮肤就丢状态」：
  // 皮肤只是画法，不该影响状态本身的表达。
  const STATES = [
    'cold-start', 'normal', 'switched', 'observing', 'waiting-write',
    'no-candidate', 'all-degraded', 'offline', 'probe-failed',
    'daily-limit', 'need-admin',
  ]
  for (const state of STATES) {
    const ring = (await viewWith({ state, skin: 'ring' })).tree
    const taiji = (await viewWith({ state, skin: 'taiji' })).tree
    check(`${state}：两套皮肤的 data-state 一致`, () => {
      if (ring.props['data-state'] !== state) throw new Error('ring=' + ring.props['data-state'])
      if (taiji.props['data-state'] !== state) throw new Error('taiji=' + taiji.props['data-state'])
      // 只有这两个状态会切换皮肤，不能反过来影响状态
      if (ring.props['data-skin'] !== 'ring' || taiji.props['data-skin'] !== 'taiji') {
        throw new Error('皮肤标记被状态覆盖了')
      }
    })
  }

  // 断网：两套皮肤都必须真的「暗下去」，不能只是属性变了
  const offRing = (await viewWith({ state: 'offline', skin: 'ring' })).tree
  const offTaiji = (await viewWith({ state: 'offline', skin: 'taiji' })).tree
  check('断网时两套皮肤都打 is-dead', () => {
    const has = (t) => {
      let found = false
      walk(t, (n) => {
        if (String(n.props?.className ?? '').split(' ').includes('is-dead')) found = true
      })
      return found
    }
    if (!has(offRing)) throw new Error('辐条没暗')
    if (!has(offTaiji)) throw new Error('太极没暗')
  })

  // 全劣化：都要打 is-alert（CSS 里靠它做缓慢明暗）
  const alertRing = (await viewWith({ state: 'all-degraded', skin: 'ring' })).tree
  const alertTaiji = (await viewWith({ state: 'all-degraded', skin: 'taiji' })).tree
  check('全劣化时两套皮肤都打 is-alert', () => {
    const has = (t) => {
      let found = false
      walk(t, (n) => {
        if (String(n.props?.className ?? '').split(' ').includes('is-alert')) found = true
      })
      return found
    }
    if (!has(alertRing)) throw new Error('辐条没有 is-alert')
    if (!has(alertTaiji)) throw new Error('太极没有 is-alert')
  })
}

console.log('\n== 太极的待机动效（设计稿三层结构）==')
{
  const css = fs.readFileSync(path.join(import.meta.dirname, '..', 'client.js'), 'utf8')
  check('三层容器都在（motion / tremor / spin）', () => {
    for (const cls of ['t-motion', 't-tremor', 't-spin']) {
      if (!css.includes("className: '" + cls + "'")) throw new Error('缺少 ' + cls)
    }
  })
  check('待机是 60s 匀速一圈', () => {
    if (!/\.cfp-taiji \.t-motion\{animation:cfp-idle-turn 60s linear infinite\}/.test(css)) {
      throw new Error('待机旋转没绑上，或时长不是 60s')
    }
    if (!/@keyframes cfp-idle-turn\{from\{transform:rotate\(0deg\)\}to\{transform:rotate\(360deg\)\}\}/.test(css)) {
      throw new Error('缺少 idle-turn 关键帧')
    }
  })
  check('差档抖动、中档缓慢抖动，优/良档不抖', () => {
    if (!/\[data-tier='poor'\] \.t-tremor\{animation:cfp-tremor \.14s steps\(2,end\) infinite\}/.test(css)) {
      throw new Error('差档抖动缺失')
    }
    if (!/\[data-tier='fair'\] \.t-tremor\{animation:cfp-tremor-soft 3\.4s/.test(css)) {
      throw new Error('中档抖动缺失')
    }
    if (/data-tier='excellent'\] \.t-tremor/.test(css) || /data-tier='good'\] \.t-tremor/.test(css)) {
      throw new Error('优/良档不该抖')
    }
  })
  check('太极的交接旋转走内部 t-spin，不与外层 .cfp-skin 重复', () => {
    if (!/\.cfp-cluster\.is-swap \.cfp-taiji \.t-spin\{/.test(css)) {
      throw new Error('太极交接没绑 t-spin')
    }
    // 外层那条必须只作用于辐条，否则太极会转两次
    if (/\.cfp-cluster\.is-swap \.cfp-skin\{animation:cfp-handoff-spin/.test(css)) {
      throw new Error('外层仍在给所有皮肤加交接旋转，太极会转两次')
    }
  })
  check('交接期间停掉待机转与抖动', () => {
    if (!/is-swap \.cfp-taiji \.t-motion,/.test(css)) throw new Error('交接时待机转没停')
    if (!/is-swap \.cfp-taiji\[data-tier='poor'\] \.t-tremor/.test(css)) {
      throw new Error('交接时抖动没停')
    }
  })
  check('降低动效时太极三层全部停掉', () => {
    for (const cls of ['.t-motion', '.t-tremor', '.t-spin']) {
      const idx = css.indexOf('prefers-reduced-motion')
      if (!css.slice(idx).includes(cls)) throw new Error('reduced-motion 没覆盖 ' + cls)
    }
  })
  // check 是同步的，所以先在外面把树取出来，再断言。
  const poorView = await viewWith({
    skin: 'taiji',
    current: { ip: 'x', address: 'a', p50: 700, p95: 760, loss: 0, samples: 40,
      at: Date.now() - 2000, durationMs: 900, reliable: true },
    best: { ip: 'y', p50: 320, p95: 340, colo: 'HKG' },
  })
  check('data-tier 真的画到 SVG 上（CSS 选择器才有东西可选）', () => {
    const root = skinRoot(poorView.tree)
    if (!root) throw new Error('没有太极根节点')
    if (root.props['data-tier'] !== 'poor') {
      throw new Error('data-tier=' + root.props['data-tier'] + '（应为 poor）')
    }
  })
}

console.log('\n== 启动时借用当前延迟：两套皮肤都要显示两侧读数 ==')
{
  // 后端在「还没测过候选」时会拿当前读数顶上，并打 bestBorrowed。
  // 前端必须：① 把借来的数画出来（不是空着）；② 不因此误报「有更好候选」。
  for (const skin of ['ring', 'taiji']) {
    const view = await viewWith({
      skin,
      bestBorrowed: true,
      candidates: [],
      current: { ip: '162.159.148.1', address: 'open-design.ai', p50: 380, p95: 420,
        loss: 0, samples: 6, at: Date.now() - 1000, durationMs: 1200, reliable: true },
      best: { ip: '162.159.148.1', p50: 380, p95: 420, colo: null },
      advantageMs: 0,
    })
    check(`${skin}：借来的候选读数被画出来`, () => {
      if (view.tree.props['data-borrowed'] !== '1') {
        throw new Error('data-borrowed=' + view.tree.props['data-borrowed'])
      }
      if (view.tree.props['data-best'] !== '380') {
        throw new Error('data-best=' + view.tree.props['data-best'] + '（应显示 380）')
      }
    })
    check(`${skin}：借用不误报「有更好候选」`, () => {
      if (view.tree.props['data-arrow'] !== '0') {
        throw new Error('data-arrow=' + view.tree.props['data-arrow'])
      }
    })
    check(`${skin}：借用不算「候选过期」`, () => {
      if (view.tree.props['data-stale'] !== '0') {
        throw new Error('data-stale=' + view.tree.props['data-stale'])
      }
    })
  }

  // 真候选出现后，借用标记必须消失
  const real = await viewWith({
    skin: 'ring',
    bestBorrowed: false,
    best: { ip: '1.2.3.4', p50: 210, p95: 240, colo: 'HKG' },
    advantageMs: 170,
  })
  check('有真候选时不再标记借用', () => {
    if (real.tree.props['data-borrowed'] !== '0') throw new Error('仍在标记借用')
    if (real.tree.props['data-best'] !== '210') throw new Error('没换成真候选')
    if (real.tree.props['data-arrow'] !== '1') throw new Error('没有标记更好候选')
  })
}

console.log('\n== 断网时不能点 ==')
{
  const { tree } = await viewWith({ skin: 'ring', state: 'offline' })
  const buttons = withClass(tree, 'cfp-skinBtn')
  check('offline 时按钮 disabled', () => {
    if (buttons.length !== 1) throw new Error('按钮数 ' + buttons.length)
    if (buttons[0].props.disabled !== true) throw new Error('仍然可点')
  })
}

console.log('\n' + pass + ' passed, ' + fail + ' failed')
if (fail > 0) process.exitCode = 1
