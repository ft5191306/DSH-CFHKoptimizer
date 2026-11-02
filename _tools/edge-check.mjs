// 联网验证：把修复后的 certOk 对着真实受限 IP 跑一遍。
// 目的不是「跑通」，而是证明 403/1034 的 IP 会被闸门剔除、健康 IP 会被放行。
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const P = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { certOk, inspectEdgeResponse, classifyCertVerdict } = await import(pathToFileURL(path.join(P, 'lib/probe.js')).href)

const DOMAIN = 'amr-link.open-design.ai'
// 实测确认返回 403 error code: 1034 的地址（Edge IP Restricted）
const RESTRICTED = ['162.159.4.1', '162.159.8.1', '162.159.48.1', '162.159.0.1']
// 实测确认健康的地址
const HEALTHY = ['162.159.158.1', '162.159.136.1', '104.26.10.1', '162.159.142.1']

let pass = 0
let fail = 0
const check = (label, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + label) }
  else { fail++; console.log('  FAIL ' + label + (extra ? '  -> ' + extra : '')) }
}

console.log('\n=== 受限 IP 必须被闸门拒绝 ===')
for (const ip of RESTRICTED) {
  const v = await certOk(ip, DOMAIN, { timeoutMs: 8000 })
  // 结论只要求「不放行」。原因可能是边缘拒绝（403/1034），也可能是这次
  // 连不上——两种都必须拦下，只是后者属于 link（调用方会重试一次）。
  const kind = classifyCertVerdict(v)
  check(`${ip} 被拒绝`, v.ok === false, JSON.stringify(v))
  check(`${ip} 归类为 edge 或 link，绝不是 cert 误判`,
    kind === 'edge' || kind === 'link', `${kind}: ${v.message}`)
  console.log(`       [${kind}] ${v.message}`)
}

console.log('\n=== 健康 IP 必须被放行（不能误杀） ===')
for (const ip of HEALTHY) {
  const v = await certOk(ip, DOMAIN, { timeoutMs: 8000 })
  check(`${ip} 通过`, v.ok === true, JSON.stringify(v))
  if (!v.ok) console.log(`       ${v.message}`)
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
