// 验证「当前已是最优」（文档第 83 行）：不写 hosts，并给出明确答复。
//
// 【重要】这个测试**必须**用临时 hosts 文件。曾经有一版没有注入口，
// 直接改掉了真实的系统 hosts（删掉了一个 IP）。Engine 现在支持
// `hostsFile` 注入，任何写盘路径都要在这里被替换掉。
//
// 用法：node _tools/optimal-check.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { Engine, defaultConfig, defaultHostsPath } from '../lib/engine.js'
import { currentPin, readHosts } from '../lib/hosts.js'

let pass = 0, fail = 0
const check = (name, fn) => {
  try { fn(); pass++; console.log('  ok   ' + name) }
  catch (e) { fail++; console.log('  FAIL ' + name + ' -> ' + (e?.message ?? e)) }
}

// 真实系统 hosts 的指纹：测试全程必须保持不变。
const systemHosts = defaultHostsPath()
const systemBefore = fs.readFileSync(systemHosts, 'utf8')
const systemStatBefore = fs.statSync(systemHosts).mtimeMs

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfpin-optimal-'))
const fakeHosts = path.join(dir, 'hosts')
const IPS = ['162.159.148.1', '162.159.128.1']
const DOMAINS = ['cloudflare.com', 'open-design.ai']
const block = [
  '# >>> CLOUDFLARE-PIN BEGIN (managed by cf_pin.py) >>>',
  ...DOMAINS.flatMap((d) => IPS.map((ip) => `${ip} ${d}`)),
  '# <<< CLOUDFLARE-PIN END <<<',
  '',
].join('\r\n')
fs.writeFileSync(fakeHosts, '# header\r\n' + block, 'utf8')

const makeEngine = () => {
  const e = new Engine({
    dataDir: dir,
    config: { ...defaultConfig(), autoWrite: true },
    log: () => {},
    hostsFile: fakeHosts,          // ← 关键：不碰系统 hosts
  })
  e.loadState()
  e.reloadFromHosts()
  return e
}

const engine = makeEngine()
console.log(`临时 hosts: ${fakeHosts}`)
console.log(`其中的 IP : ${engine.currentIps.join(', ')}`)

console.log('\n== 情况 1：要写的 IP 与 hosts 完全相同 ==')
engine.current = {
  ip: IPS[0], address: 'open-design.ai', p50: 400, p95: 420, loss: 0,
  samples: 6, at: Date.now(), durationMs: 1200, reliable: true,
}
engine.candidates = [{ ip: IPS[0], colo: 'HKG', p50: 100, p95: 200, samples: 40, timeouts: 0, qualified: true, perDomain: {} }]
const before1 = fs.readFileSync(fakeHosts, 'utf8')
// 自动路径（不带 forced）：仍然拦截，不写。
const r1auto = await engine.apply()
check('自动路径：返回 ok', () => assert.equal(r1auto.ok, true))
check('自动路径：标记 alreadyOptimal', () => assert.equal(r1auto.alreadyOptimal, true))
check('自动路径：reason 为「当前已是最优」', () => assert.equal(r1auto.reason, '当前已是最优'))
check('自动路径：临时 hosts 未被改写', () => assert.equal(fs.readFileSync(fakeHosts, 'utf8'), before1))

console.log('\n== 情况 1b：手动点「立即切换」不被「已是最优」拦住 ==')
// 用户 2026-10-28 明确要求：点按钮就要它真的动一次，即使结果一样。
// 所以 forced:true 必须绕过那三个拦截条件。
// （注意：这里 `forced` 以前只控制日志，根本没参与判断——route 传它是无效的。）
const r1manual = await engine.apply({ forced: true })
check('手动路径：不判 alreadyOptimal', () => assert.notEqual(r1manual.alreadyOptimal, true))
check('手动路径：越过了最优拦截，真的写了一次', () => {
  const reason = String(r1manual.reason ?? '')
  if (reason.includes('已是最优')) throw new Error('仍被拦住：' + reason)
  // 这是假 hosts（临时文件），写入成功是预期结果——用户点了就是要它动一次。
  // 它成功也顺带证明：绕过拦截后，后续的证书闸门/写入流程确实跑到了。
  assert.equal(r1manual.ok, true)
  if (!Array.isArray(r1manual.ips) || r1manual.ips.length === 0) {
    throw new Error('没有报告写入的 IP')
  }
})
// 写完之后，同样的内容再点一次**仍然**要放行（用户可能就是想重刷一次）
const r1again = await engine.apply({ forced: true })
check('手动路径：重复点击仍然放行，不被「已是最优」挡回', () => {
  if (String(r1again.reason ?? '').includes('已是最优')) {
    throw new Error('第二次点击被拦住了')
  }
})

console.log('\n== 情况 2：候选不同，但差距不到阈值 ==')
engine.current = {
  ip: IPS[0], address: 'open-design.ai', p50: 300, p95: 320, loss: 0,
  samples: 6, at: Date.now(), durationMs: 1200, reliable: true,
}
engine.candidates = [{ ip: '203.0.113.9', colo: 'HKG', p50: 200, p95: 260, samples: 40, timeouts: 0, qualified: true, perDomain: {} }]
const before2 = fs.readFileSync(fakeHosts, 'utf8')
const r2 = await engine.apply()
check('自动路径：判为已是最优', () => assert.equal(r2.alreadyOptimal, true))
check('自动路径：临时 hosts 未被改写', () => assert.equal(fs.readFileSync(fakeHosts, 'utf8'), before2))
const r2m = await engine.apply({ forced: true })
check('手动路径：同样不被拦住', () => assert.notEqual(r2m.alreadyOptimal, true))

console.log('\n== 情况 3：差距够大 → 不再拦，进入写入流程 ==')
engine.current = {
  ip: IPS[0], address: 'open-design.ai', p50: 500, p95: 520, loss: 0,
  samples: 6, at: Date.now(), durationMs: 1200, reliable: true,
}
engine.candidates = [{ ip: '203.0.113.9', colo: 'HKG', p50: 200, p95: 260, samples: 40, timeouts: 0, qualified: true, perDomain: {} }]
const r3 = await engine.apply({ forced: true })
check('不再判为已是最优', () => assert.notEqual(r3.alreadyOptimal, true))
// 假 IP 过不了证书闸门，所以这里 expected: ok=false 且不改文件
check('被证书闸门拦下（未写入）', () => assert.equal(r3.ok, false))

console.log('\n== 真实系统 hosts 全程未被触碰 ==')
const systemAfter = fs.readFileSync(systemHosts, 'utf8')
check('内容逐字节相同', () => assert.equal(systemAfter, systemBefore))
check('mtime 未变', () => assert.equal(fs.statSync(systemHosts).mtimeMs, systemStatBefore))
// 这条原来写死「恰好 2 个 IP」，但设计允许「仅 1 个合格候选就只写 1 个」
// （写入规则：合格 ≥2 写 2 个，仅 1 个就写 1 个，不拿淘汰项凑数）。
// 插件在真实网络下确实出现过只写 1 个的情况，于是这条断言会因为**正常的写入结果**
// 而失败——它测的其实是「别的进程有没有动 hosts」，不是「必须正好 2 个」。
// 所以真正该钉的是「标记段里有 IP，且数量不超过写入上限 2」。
check('系统 hosts 标记段仍有 1–2 个 IP', () => {
  const ips = currentPin(systemAfter).ips
  assert.ok(ips.length >= 1 && ips.length <= 2, `期望 1–2 个 IP，实际 ${ips.length}：${ips.join(', ')}`)
})

fs.rmSync(dir, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
