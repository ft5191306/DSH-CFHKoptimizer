/**
 * 生成 `docs/ui-states.png`：四档 + 全组合矩阵的**实际渲染图**。
 *
 * 为什么要有这个脚本，而不是直接放一张截图：
 *   文档里的「余温 39/25/14/6/1 个点」「环芯 16/12/8/4/0」这类数字，
 *   如果靠读代码常量抄下来，改皮肤那天文档就会静默失配。
 *   这里把 `client.js` 里的皮肤函数**真跑一遍**，从产出的 SVG 里数点数，
 *   再渲染成图 —— 图和数字同源，改完重跑一次就同步。
 *
 * 用法（在插件目录下）：
 *   node _tools/render-states.mjs            # 只写 HTML，自己开浏览器看
 *   node _tools/render-states.mjs --png      # 额外尝试用 Edge/Chrome headless 出 PNG
 *
 * 产物：
 *   _tmp-ui-states.html   —— 中间文件，可直接双击打开
 *   docs/ui-states.png    —— 只在 --png 且找得到浏览器时更新
 *
 * 注意：静态展示**不需要**动画。两套皮肤的测速读头/波纹组默认 `opacity:0`，
 * 圈外点挂 `cfp-far` 也是 0。少了那两条 CSS，会把 39 个白色探针点画出来，
 * 图会被读成「满盘亮点」—— 所以下面显式写了 `.cfp-probe{opacity:0}`。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const P = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WANT_PNG = process.argv.includes('--png')

/** 从 client.js 抽出皮肤区段（纯常量 + 纯函数，不依赖 React）。 */
function loadSkins() {
  const src = fs.readFileSync(path.join(P, 'client.js'), 'utf8')
  const start = src.indexOf('const TIER_EDGES')
  const end = src.indexOf('function SkinGlyph(')
  if (start < 0 || end < 0) throw new Error('client.js 结构变了：找不到皮肤区段（TIER_EDGES / SkinGlyph）')
  const chunk = src.slice(start, end)
  return new Function(
    chunk + '; return { renderRingCore, renderAfterglow, TIER_EDGES, tierOf, RING_LIT, CORE_LIT, GLOW_REACH, GLOW_CORE, worseTier };',
  )()
}

const M = loadSkins()
const TIERS = ['excellent', 'good', 'fair', 'poor', 'nodata']
const CN = { excellent: '优', good: '良', fair: '中', poor: '差', nodata: '无读数' }
const RANGE = { excellent: '≤380ms', good: '380–490', fair: '490–600', poor: '>600ms', nodata: '—' }

// ---------------------------------------------------------------- 点数实测

/** 按 side 切分 SVG（`cfp-side-cur` / `cfp-side-cand`）。嵌套 <g> 不能用惰性正则。 */
function splitSides(svg) {
  const cur = svg.indexOf('<g class="cfp-side-cur')
  const cand = svg.indexOf('<g class="cfp-side-cand')
  const probe = svg.indexOf('<g class="cfp-probe')
  const end = probe > 0 ? probe : svg.lastIndexOf('</g>')
  if (cur < 0 || cand < 0) return { curPart: '', candPart: '' }
  return cur < cand
    ? { curPart: svg.slice(cur, cand), candPart: svg.slice(cand, end) }
    : { candPart: svg.slice(cand, cur), curPart: svg.slice(cur, end) }
}

const circlesOf = (s) => s.match(/<circle[^>]*>/g) ?? []
const opacityOf = (c) => Number((/opacity:\s*([\d.]+)/.exec(c) ?? [])[1] ?? 1)

/** 数一份 SVG 里「视觉上点亮/可见」的点。 */
function measure(skin, tier) {
  const svg = skin === 'ring'
    ? M.renderRingCore({ current: tier, candidate: tier })
    : M.renderAfterglow({ current: tier, candidate: tier })
  const { curPart, candPart } = splitSides(svg)
  const cand = circlesOf(candPart)
  const cur = circlesOf(curPart)
  if (skin === 'ring') {
    return {
      candLit: cand.filter((c) => /class="k/.test(c)).length, candTotal: cand.length,
      curLit: cur.filter((c) => /class="k/.test(c)).length, curTotal: cur.length,
    }
  }
  return {
    candVis: cand.filter((c) => opacityOf(c) > 0.001).length, candTotal: cand.length,
    curVis: cur.filter((c) => opacityOf(c) > 0.001).length, curTotal: cur.length,
  }
}

console.log('=== 实测点数（从渲染出的 SVG 里数，不是抄常量）===')
console.log('档位         环芯 外圈/内芯        余温 候选侧/当前侧')
for (const t of TIERS) {
  const r = measure('ring', t)
  const g = measure('glow', t)
  console.log(
    (t + ' (' + CN[t] + ')').padEnd(18),
    `外${r.candLit}/${r.candTotal} 内${r.curLit}/${r.curTotal}`.padEnd(22),
    `候选${g.candVis}/${g.candTotal} 当前${g.curVis}/${g.curTotal}`,
  )
}

// 几何断言：档位越好，点越多。跑挂了说明皮肤坏了，别拿去写文档。
const ringLits = TIERS.map((t) => measure('ring', t).candLit)
const glowVis = TIERS.map((t) => measure('glow', t).candVis)
const monotonic = (arr) => arr.every((v, i) => i === 0 || arr[i - 1] >= v)
if (!monotonic(ringLits)) throw new Error('环芯外圈亮点数不再单调递减：' + JSON.stringify(ringLits))
if (!monotonic(glowVis)) throw new Error('余温候选侧可见点数不再单调递减：' + JSON.stringify(glowVis))

// ---------------------------------------------------------------- 生成 HTML

const pairs = []
for (const cur of TIERS) for (const cand of TIERS) pairs.push({ cur, cand })

const bigCard = (t) => {
  const ring = M.renderRingCore({ current: t, candidate: t })
  const glow = M.renderAfterglow({ current: t, candidate: t })
  return `<div class="big">
    <div class="bigv">${ring}</div>
    <div class="bigv">${glow}</div>
    <div class="cap"><div class="tname">${t} · ${CN[t]}</div><div class="trange">${RANGE[t]}</div></div>
  </div>`
}

const matrixCell = ({ cur, cand }) => `<div class="cell">
    <div class="sm">${M.renderRingCore({ current: cur, candidate: cand })}</div>
    <div class="sm">${M.renderAfterglow({ current: cur, candidate: cand })}</div>
    <div class="meta">候选 <b>${CN[cand]}</b><br>当前 <b>${CN[cur]}</b></div>
  </div>`

const html = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>dsh-cf-pin 图标状态</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;padding:28px;background:#1a1a1c;color:#e6e6e8;
       font:14px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
  h2{font-size:15px;font-weight:600;margin:26px 0 8px;color:#fff}
  h2:first-of-type{margin-top:0}
  .note{color:#8b9199;font-size:12px;margin:0 0 14px}
  .bigs{display:flex;gap:26px;flex-wrap:wrap}
  .big{background:#232326;border:1px solid #2e2e33;border-radius:12px;
       padding:16px 14px 12px;display:flex;flex-direction:column;align-items:center;gap:10px;min-width:112px}
  .bigv svg{width:72px;height:72px;display:block}
  .cap{text-align:center}
  .tname{font-size:12px;color:#fff}
  .trange{font-size:11px;color:#8b9199}
  .legend{display:flex;gap:18px;font-size:11px;color:#8b9199;margin:0 0 10px;flex-wrap:wrap}
  .legend span{display:flex;align-items:center;gap:5px}
  .sw{width:10px;height:10px;border-radius:2px;display:inline-block}
  .grid{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;max-width:780px}
  .cell{background:#232326;border:1px solid #2e2e33;border-radius:8px;
        padding:8px 6px;display:flex;flex-direction:column;align-items:center;gap:5px}
  .sm svg{width:25px;height:25px;display:block}
  .meta{font-size:9.5px;color:#8b9199;text-align:center;line-height:1.35}
  .meta b{color:#cfcfd4;font-weight:600}

  /* --- 皮肤静态样式：从 client.js 搬来的最小集合，无动画 --- */
  .cfp-ring-core .k.tp-excellent{fill:#2f8f5b}
  .cfp-ring-core .k.tp-good{fill:#2f6fd0}
  .cfp-ring-core .k.tp-fair{fill:#b5761f}
  .cfp-ring-core .k.tp-poor{fill:#c3433a}
  .cfp-ring-core .g{fill:#8b9199;opacity:.55}
  .cfp-ring-core .cfp-probe{opacity:0}
  .cfp-ring-core .cfp-probe .w{fill:#eef0f3}

  .cfp-afterglow .tp-excellent .k{fill:#2f8f5b}
  .cfp-afterglow .tp-good .k{fill:#2f6fd0}
  .cfp-afterglow .tp-fair .k{fill:#b5761f}
  .cfp-afterglow .tp-poor .k{fill:#c3433a}
  .cfp-afterglow .tp-nodata .k{fill:#8b9199}
  .cfp-afterglow .g{fill:#6b7078}
  .cfp-afterglow .cfp-probe{opacity:0}
  /* 圈外点静止不可见。真实插件靠 animation 覆盖内联 opacity 实现；
     静态图没有动画，用 !important 表达同一个静止态。 */
  .cfp-afterglow .cfp-far{opacity:0 !important}
</style></head><body>

<h2>四档 + 无读数（当前与候选取同档，最常见的稳态）</h2>
<div class="note">每档两张：左 = 环芯 ring-core，右 = 余温 afterglow。放大到 72px 便于看清点阵。</div>
<div class="bigs">${TIERS.map(bigCard).join('')}</div>

<h2>颜色图例</h2>
<div class="legend">
  <span><i class="sw" style="background:#2f8f5b"></i>excellent 优 ≤380ms</span>
  <span><i class="sw" style="background:#2f6fd0"></i>good 良 380–490ms</span>
  <span><i class="sw" style="background:#b5761f"></i>fair 中 490–600ms</span>
  <span><i class="sw" style="background:#c3433a"></i>poor 差 &gt;600ms</span>
  <span><i class="sw" style="background:#8b9199"></i>nodata 无读数</span>
</div>

<h2>全组合矩阵（25 格，实际 25×25px 尺寸）</h2>
<div class="note">每格：上 = 环芯，下 = 余温。文字是「候选 / 当前」。两套皮肤在任意档位组合下的真实输出。</div>
<div class="grid">${pairs.map(matrixCell).join('')}</div>

</body></html>`

const htmlPath = path.join(P, '_tmp-ui-states.html')
fs.writeFileSync(htmlPath, html, 'utf8')
console.log('\n写出 ' + htmlPath)

if (!WANT_PNG) {
  console.log('（加 --png 可尝试自动出图）')
  process.exit(0)
}

// ---------------------------------------------------------------- 出 PNG

const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
]
const browser = BROWSERS.find((p) => fs.existsSync(p))
if (browser === undefined) {
  console.log('没找到 Edge/Chrome，跳过出图。HTML 已写好，可手动截图。')
  process.exit(0)
}

const outPng = path.join(P, 'docs/ui-states.png')
fs.mkdirSync(path.dirname(outPng), { recursive: true })
// 先删旧图：否则浏览器没真正出图时，我们会把上一次的图当成新图。
if (fs.existsSync(outPng)) fs.unlinkSync(outPng)

/**
 * headless 浏览器偶尔不退出（它 fork 出的子进程会拖着主进程）。
 * 所以给足超时，超时后**不看退出码、只看文件有没有写出来**——
 * 截图往往在超时之前就已经落盘了。
 */
const res = spawnSync(browser, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars',
  '--force-device-scale-factor=2',
  '--window-size=880,1120',
  '--screenshot=' + outPng,
  'file:///' + htmlPath.replace(/\\/g, '/'),
], { stdio: 'ignore', timeout: 60_000 })

if (!fs.existsSync(outPng)) {
  console.log('出图失败（浏览器退出码 ' + res.status + '）。HTML 已写好，可手动截图：')
  console.log('  ' + htmlPath)
  process.exit(1)
}
console.log('写出 ' + outPng + '（' + fs.statSync(outPng).size + ' 字节）')
