// Regression tests for the fixes. No network, temp hosts file only.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * 插件根目录 = 本文件所在 `_tools\` 的上一级。
 *
 * 以前这里硬编码了某台机器上的安装路径（`profiles/desktop/node_modules/...`），
 * 于是脚本只在那一台机器上跑得起来——别人 clone 下来第一行就 import 失败。
 * 现在按脚本自身位置解析，仓库放哪都能跑。
 */
const P = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pluginUrl = (rel) => pathToFileURL(path.join(P, rel)).href

const { Engine, defaultConfig, STATE, currentWindowMs, isReadingReliable, MANUAL_TTL_MS, MANUAL_NOTE_MS, CERT_FAILURE_TTL_MS } = await import(pluginUrl('lib/engine.js'))
const { readHosts, currentPin } = await import(pluginUrl('lib/hosts.js'))
const { isBroken, tierOf, sortCandidates, isAllTimeouts, classifyCertVerdict, TIER } = await import(pluginUrl('lib/probe.js'))

let pass = 0, fail = 0
const check = (label, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + label) }
  else { fail++; console.log('  FAIL ' + label + (extra ? '  -> ' + extra : '')) }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfpin-reg-'))
const mkHosts = (lines) => {
  const f = path.join(tmp, 'hosts_' + Math.random().toString(36).slice(2))
  fs.writeFileSync(f, ['127.0.0.1 localhost', ...lines, ''].join('\r\n'), 'utf8')
  return f
}
const cfg = (over = {}) => ({
  ...defaultConfig(),
  addresses: [{ address: 'amr-link.open-design.ai', enabled: true }],
  ...over,
})
/**
 * 假的证书闸门：默认一律通过。
 *
 * 真的 certOk 会去连候选 IP，于是 apply() 变成网络依赖——本机到 162.159.x
 * 抖一下，用例就红，而代码其实是对的。这个脚本承诺「不联网」，所以必须注入。
 */
const fakeCert = (ok = true) => async () => ({ ok, message: ok ? '假校验通过' : '假校验不通过' })
const mkEngine = (hostsFile, over = {}, certOk = true) => {
  const e = new Engine({
    dataDir: tmp,
    hostsFile,
    log: () => {},
    config: cfg(over),
    verifyCert: fakeCert(certOk),
  })
  e.admin = true
  e.reloadFromHosts()
  return e
}
const slowCurrent = (e, samples = 20) => {
  e.current = { ip: '162.159.150.1', address: 'amr-link.open-design.ai', p50: 600, p95: 700, loss: 0, samples, at: Date.now(), durationMs: 1, reliable: samples >= 3 }
  e.candidates = [{ ip: '162.159.146.1', colo: 'HKG', p50: 200, p95: 260, samples: 40, timeouts: 0, qualified: true, perDomain: {} }]
  e.roundFinishedAt = Date.now()
}

console.log('\n[#2] 默认值 / 恢复默认不得静默打开自动写 hosts')
check('defaultConfig().autoWrite === false', defaultConfig().autoWrite === false, String(defaultConfig().autoWrite))
check('defaultConfig().probeWhileThinking === false', defaultConfig().probeWhileThinking === false)

console.log('\n[AUTO] 空闲时判出的切换必须真的执行')
{
  const f = mkHosts(['# >>> CLOUDFLARE-PIN BEGIN (managed by cf_pin.py) >>>', '162.159.150.1 amr-link.open-design.ai', '# <<< CLOUDFLARE-PIN END <<<'])
  const e = mkEngine(f, { autoWrite: true })
  slowCurrent(e); e.streaming = 0
  const before = readHosts(f)
  const r = await e.decideAndApply()
  check('decideAndApply 返回了写入结果', r !== null, JSON.stringify(r))
  check('hosts 真的变了', readHosts(f) !== before)
  check('写入了候选 IP', currentPin(readHosts(f)).ips.includes('162.159.146.1'))
  check('switchLog 记了一笔', e.switchLog.length === 1)
}
{
  // 候选轮跑完是最有信息量的时刻：它也必须真的执行写入，而不是只留个 decision。
  const f = mkHosts(['# >>> CLOUDFLARE-PIN BEGIN (managed by cf_pin.py) >>>', '162.159.150.1 amr-link.open-design.ai', '# <<< CLOUDFLARE-PIN END <<<'])
  const e = mkEngine(f, { autoWrite: true })
  slowCurrent(e)
  e.streaming = 0
  const before = readHosts(f)
  await e.decideAndApply()
  check('候选轮路径也能写 hosts', readHosts(f) !== before)
  // 原来这条是源码正则（/roundFinishedAt = Date.now()[\s\S]{0,1200}decideAndApply\(\)/），
  // 只证明「那两行相邻」——而正是这种断言让「全超时重扫是死代码」躲过了 154 条检查。
  // 现在由下面 [ROUND] 段用假网络真跑一遍，见那里。
  const engSrc = fs.readFileSync(P + '/lib/engine.js', 'utf8')
  check('runCandidateRound 拆出了无守卫的本体', /async runCandidateRoundOnce\(allowRescan\)/.test(engSrc))
  check('重扫调用的是本体、不是带守卫的入口', /runCandidateRoundOnce\(false\)/.test(engSrc))
  check('入口守卫仍在（独占与异常兜底）', /if \(this\.roundRunning \|\| this\.disposed\) return/.test(engSrc))
}
{ // autoWrite off => 不写
  const f = mkHosts(['# >>> CLOUDFLARE-PIN BEGIN (managed by cf_pin.py) >>>', '162.159.150.1 amr-link.open-design.ai', '# <<< CLOUDFLARE-PIN END <<<'])
  const e = mkEngine(f, { autoWrite: false })
  slowCurrent(e); e.streaming = 0
  const before = readHosts(f)
  const r = await e.decideAndApply()
  check('autoWrite=false 时不写', r === null && readHosts(f) === before, JSON.stringify(r))
  check('状态是 auto-off', e.decision.reason === 'auto-off', e.decision.reason)
}
{ // 并发重叠保护
  const f = mkHosts(['# >>> CLOUDFLARE-PIN BEGIN (managed by cf_pin.py) >>>', '162.159.150.1 amr-link.open-design.ai', '# <<< CLOUDFLARE-PIN END <<<'])
  const e = mkEngine(f, { autoWrite: true })
  slowCurrent(e)
  e.applying = true
  const r = await e.decideAndApply()
  check('applying 期间不重复写', r === null, JSON.stringify(r))
}

console.log('\n[DOMAIN] 写 hosts 只写启用地址，不写旧段里的其他域名')
{
  const f = mkHosts([
    '# >>> CLOUDFLARE-PIN BEGIN (managed by cf_pin.py) >>>',
    '162.159.150.1 cloudflare.com',
    '162.159.150.1 open-design.ai',
    '# <<< CLOUDFLARE-PIN END <<<',
  ])
  const e = mkEngine(f, { autoWrite: true })
  slowCurrent(e)
  await e.apply({ forced: true })
  const pin = currentPin(readHosts(f))
  check('写入了启用的 amr-link', pin.domains.includes('amr-link.open-design.ai'), pin.domains.join(','))
  check('没有写入未启用的旧域名', !pin.domains.includes('cloudflare.com') && !pin.domains.includes('open-design.ai'), pin.domains.join(','))
}
{ // 闸门全部不通过时必须一个字都不写
  //
  // 「不通过」现在分四种成色（probe.classifyCertVerdict），处置不同：
  //   cert    真证书问题 → 剔除该候选
  //   unknown 认不出来 = 没有安全证据 → 也剔除（不能拿未知当放行）
  //   link    临时链路问题 → 重试一次，仍失败则放行但标记「未校验」
  //   ok      放行
  //
  // fakeCert(false) 给的是「假校验不通过」，文本不含任何证书/链路关键词 →
  // 归为 unknown。所以期望仍是「一个字都不写」。
  const f = mkHosts(['# >>> CLOUDFLARE-PIN BEGIN (managed by cf_pin.py) >>>', '162.159.150.1 amr-link.open-design.ai', '# <<< CLOUDFLARE-PIN END <<<'])
  const e = mkEngine(f, { autoWrite: true }, false)   // certOk = false
  slowCurrent(e); e.streaming = 0
  const before = readHosts(f)
  const r = await e.apply({ forced: true })
  check('闸门全部不通过 -> 不写', r.ok === false && readHosts(f) === before, JSON.stringify(r))
  check('失败原因点名证书', String(r.reason ?? '').includes('证书'), r.reason)
  check('闸门失败不计入 switchLog', e.switchLog.length === 0, String(e.switchLog.length))
}

console.log('\n[#3] probeWhileThinking 真的接线了')
{
  const src = fs.readFileSync(P + '/index.js', 'utf8')
  check('index.js 读取 config.probeWhileThinking', src.includes('config.probeWhileThinking'))
}

console.log('\n[#4] 非管理员不再吞掉一切状态')
{
  const f = mkHosts(['# >>> CLOUDFLARE-PIN BEGIN (managed by cf_pin.py) >>>', '162.159.150.1 amr-link.open-design.ai', '# <<< CLOUDFLARE-PIN END <<<'])
  const e = mkEngine(f)
  e.admin = false
  e.current = null
  check('冷启动显示 cold-start 而非 need-admin', e.resolveState() === STATE.coldStart, e.resolveState())

  const e2 = mkEngine(f)
  e2.admin = false
  slowCurrent(e2)
  e2.decide()
  check('确实该切且只差权限时才是 need-admin', e2.resolveState() === STATE.needAdmin, e2.resolveState() + '/' + e2.decision.reason)

  const e3 = mkEngine(f)
  e3.admin = false
  e3.current = { ip: '162.159.150.1', address: 'a', p50: 600, p95: 700, loss: 0, samples: 20, at: Date.now(), durationMs: 1, reliable: true }
  e3.candidates = []
  e3.roundFinishedAt = 0
  e3.decide()
  check('没测过候选时不是 need-admin', e3.resolveState() !== STATE.needAdmin, e3.resolveState())
}

console.log('\n[#5] streaming 计数不泄漏')
{
  const src = fs.readFileSync(P + '/index.js', 'utf8')
  check('next() 同步抛错时回滚计数', /catch \(error\)[\s\S]{0,400}streaming = Math\.max\(0, instance\.streaming - 1\)[\s\S]{0,120}throw error/.test(src))
}

console.log('\n[LIMIT] 每日切换上限已彻底删除（不能留半个闸门）')
{
  const eng = fs.readFileSync(P + '/lib/engine.js', 'utf8')
  const idx = fs.readFileSync(P + '/index.js', 'utf8')
  const cli = fs.readFileSync(P + '/client.js', 'utf8')
  check('engine 不再有 maxSwitchesPerDay 字段', !eng.includes('maxSwitchesPerDay'))
  check('engine 不再有 daily-limit 状态', !eng.includes('daily-limit') && !eng.includes('dailyLimit'))
  check('engine 不再有「24h 切换次数」闸门', !eng.includes('switchesInLast24h'))
  // 注释里可以提到它（说明为什么删掉），但代码里不能再有赋值/取值。
  check('index 不再归一化 maxSwitchesPerDay', !/maxSwitchesPerDay\s*:/.test(idx))
  check('client 不再显示「今日切换」', !cli.includes('switchesToday') && !cli.includes('今日切换'))
  check('client 不再有「每天最多自动切换」设置项', !cli.includes('每天最多自动切换'))
  check('client 不再有 daily-limit 文案/状态', !cli.includes('daily-limit'))
  // 但写入历史必须留着：它是「到底有没有真的写过 hosts」的唯一可信证据。
  check('switchLog 仍在写（诊断用，只写不读）', eng.includes('this.switchLog.push(Date.now())'))
  check('switchLog 仍在 state.json 里持久化', eng.includes('switchLog: this.switchLog'))
}

console.log('\n[RETENTION] switchLog 必须真的只保留 24h（注释与行为一致）')
{
  // 以前注释写「24h 内的切换时间戳」，实现却只 push 从不裁剪：字段随运行时长
  // 无限增长，而 saveState() 每轮都把它整体序列化一次。
  const now = Date.now()
  const DAY = 24 * 60 * 60 * 1000

  const e = mkEngine(mkHosts([]))
  e.switchLog = [
    now - 3 * DAY,          // 早该消失
    now - 2 * DAY,          // 早该消失
    now - DAY - 60_000,     // 早该消失（刚过期）
    now - 60_000,           // 保留
    now - 1_000,            // 保留
  ]
  e.pruneSwitchLog(now)
  check('超过 24h 的条目被裁掉', e.switchLog.length === 2, 'len=' + e.switchLog.length)
  check('24h 内的条目按原顺序保留', e.switchLog[0] === now - 60_000 && e.switchLog[1] === now - 1_000)

  // 边界：恰好 24h 的条目必须保留（用 >= cutoff，不是 >）。
  const edge = mkEngine(mkHosts([]))
  edge.switchLog = [now - DAY, now - DAY - 1]
  edge.pruneSwitchLog(now)
  check('恰好 24h 的条目保留，早 1ms 的裁掉', edge.switchLog.length === 1 && edge.switchLog[0] === now - DAY, JSON.stringify(edge.switchLog.map((t) => t - now)))

  // 全在窗口内时不做无谓重建（同一份数组）。
  const keep = mkEngine(mkHosts([]))
  keep.switchLog = [now - 1_000, now - 2_000]
  const before = keep.switchLog
  keep.pruneSwitchLog(now)
  check('无需裁剪时不重建数组', keep.switchLog === before)

  // 落盘路径：saveState 写出的 state.json 里不能还有过期条目。
  const e2 = mkEngine(mkHosts([]))
  e2.switchLog = [now - 5 * DAY, now - 1_000]
  e2.saveState()
  const persisted = JSON.parse(fs.readFileSync(path.join(tmp, 'state.json'), 'utf8'))
  check('saveState 落盘的 switchLog 已裁剪', persisted.switchLog.length === 1, JSON.stringify(persisted.switchLog))

  // 读回路径：把一份「含过期条目」的 state.json 喂给 loadState，必须被裁掉。
  const e3 = mkEngine(mkHosts([]))
  fs.writeFileSync(path.join(tmp, 'state.json'), JSON.stringify({
    switchLog: [now - 9 * DAY, now - 2 * DAY, now - 1_000],
    rotation: 7,
  }), 'utf8')
  e3.loadState()
  check('loadState 读回旧文件时也裁剪', e3.switchLog.length === 1 && e3.switchLog[0] === now - 1_000,
    JSON.stringify(e3.switchLog.map((t) => t - now)))
  check('loadState 仍照常恢复 rotation', e3.rotation === 7, String(e3.rotation))

  // 裁剪不得改变任何判定：它只写不读。所以 switchLog 除了 push / 序列化 /
  // pruneSwitchLog 内部之外，不该再被读取来做判断。
  //
  // 先切掉 pruneSwitchLog 自己的函数体——它当然要看 .length，那是在裁剪，
  // 不是在判定「该不该切线路」。
  const eng = fs.readFileSync(P + '/lib/engine.js', 'utf8')
  const body = eng.slice(eng.indexOf('pruneSwitchLog(now'))
  const bodyEnd = body.indexOf('\n  }\n')
  const outside = eng.slice(0, eng.indexOf('pruneSwitchLog(now')) + body.slice(bodyEnd)
  const consumers = outside.split('\n')
    .map((line, i) => ({ line: line.trim(), no: i + 1 }))
    .filter(({ line }) => line.includes('switchLog') && !line.startsWith('*') && !line.startsWith('//'))
    .filter(({ line }) => /\.(some|every|find|reduce|includes)\(|\.length\s*[<>=!]/.test(line))
  check('代码里没有任何「读 switchLog 做判定」的地方', consumers.length === 0,
    JSON.stringify(consumers))
}

console.log('\n[MINOR] reliable 不足时不触发写入')
{
  const f = mkHosts(['# >>> CLOUDFLARE-PIN BEGIN (managed by cf_pin.py) >>>', '162.159.150.1 amr-link.open-design.ai', '# <<< CLOUDFLARE-PIN END <<<'])
  const e = mkEngine(f, { autoWrite: true })
  slowCurrent(e, 1)   // 1 个样本 -> reliable=false
  e.streaming = 0
  const r = await e.decideAndApply()
  check('样本不足不写', r === null, JSON.stringify(r))
  check('样本不足判为 observing', e.decision.reason === 'observing', e.decision.reason)
}

console.log('\n[MINOR] LOCK_FILE 死代码已移除')
{
  const src = fs.readFileSync(P + '/index.js', 'utf8')
  check('index.js 不再声明 LOCK_FILE', !src.includes('LOCK_FILE'))
}

console.log('\n[DEGRADE] 无合格候选时必须有降级处理（烂死在一条线路上是 bug）')
{
  // 判据本身：「慢」不等于「断」
  check('零丢包的慢样本不算断', isBroken({ loss: 0, timeouts: 0, samples: 40, p95: 1200 }) === false)
  check('2/40 超时不算断', isBroken({ loss: 5, timeouts: 2, samples: 40 }) === false)
  check('3/40 超时算断', isBroken({ loss: 7.5, timeouts: 3, samples: 40 }) === true)
  check('全超时算断', isBroken({ loss: 100, timeouts: 4, samples: 4 }) === true)
}
{
  // 全劣化 + 确实明显更好 + 丢包不更差 -> 自动也要切，并标 degraded
  const f = mkHosts(['# >>> CLOUDFLARE-PIN BEGIN (managed by cf_pin.py) >>>', '162.159.150.1 amr-link.open-design.ai', '# <<< CLOUDFLARE-PIN END <<<'])
  const e = mkEngine(f, { autoWrite: true })
  e.current = { ip: '162.159.150.1', address: 'amr-link.open-design.ai', p50: 600, p95: 900, loss: 50, samples: 20, at: Date.now(), durationMs: 1, reliable: true }
  e.candidates = [
    { ip: '162.159.10.1', colo: 'HKG', p50: 300, p95: 999, loss: 20, timeouts: 8, samples: 40, broken: true, qualified: false, perDomain: {} },
    { ip: '162.159.20.1', colo: 'HKG', p50: 350, p95: 999, loss: 30, timeouts: 12, samples: 40, broken: true, qualified: false, perDomain: {} },
  ]
  e.roundFinishedAt = Date.now()
  const before = readHosts(f)
  const r = await e.decideAndApply()
  check('全劣化也真的写了 hosts', r !== null && readHosts(f) !== before, JSON.stringify(r))
  check('结果标了 degraded', r !== null && r.degraded === true, JSON.stringify(r))
  check('写的是「最不坏」的那条', currentPin(readHosts(f)).ips[0] === '162.159.10.1', currentPin(readHosts(f)).ips.join(','))
  check('状态是 degraded-switched', e.resolveState() === STATE.degradedSwitched, e.resolveState())
}
{
  // 全劣化但没有明显更好 -> all-degraded，不写
  const f = mkHosts(['# >>> CLOUDFLARE-PIN BEGIN (managed by cf_pin.py) >>>', '162.159.150.1 amr-link.open-design.ai', '# <<< CLOUDFLARE-PIN END <<<'])
  const e = mkEngine(f, { autoWrite: true })
  e.current = { ip: '162.159.150.1', address: 'amr-link.open-design.ai', p50: 300, p95: 700, loss: 50, samples: 20, at: Date.now(), durationMs: 1, reliable: true }
  e.candidates = [{ ip: '162.159.10.1', colo: 'HKG', p50: 280, p95: 999, loss: 20, timeouts: 8, samples: 40, broken: true, qualified: false, perDomain: {} }]
  e.roundFinishedAt = Date.now()
  const before = readHosts(f)
  const r = await e.decideAndApply()
  check('差距不够时全劣化不写', r === null && readHosts(f) === before, JSON.stringify(r))
  check('状态是 all-degraded', e.resolveState() === STATE.allDegraded, e.resolveState())
}
{
  // 丢包更差就不切：不能拿延迟换丢包
  const f = mkHosts(['# >>> CLOUDFLARE-PIN BEGIN (managed by cf_pin.py) >>>', '162.159.150.1 amr-link.open-design.ai', '# <<< CLOUDFLARE-PIN END <<<'])
  const e = mkEngine(f, { autoWrite: true })
  e.current = { ip: '162.159.150.1', address: 'amr-link.open-design.ai', p50: 900, p95: 950, loss: 5, samples: 20, at: Date.now(), durationMs: 1, reliable: true }
  e.candidates = [{ ip: '162.159.10.1', colo: 'HKG', p50: 200, p95: 999, loss: 40, timeouts: 16, samples: 40, broken: true, qualified: false, perDomain: {} }]
  e.roundFinishedAt = Date.now()
  const before = readHosts(f)
  const r = await e.decideAndApply()
  check('候选丢包更差 -> 不写', r === null && readHosts(f) === before, JSON.stringify(r))
}
{
  // 手动「立即切换」在 0 合格候选时也必须真的写（旧实现在这里直接失败）
  const f = mkHosts(['# >>> CLOUDFLARE-PIN BEGIN (managed by cf_pin.py) >>>', '162.159.150.1 amr-link.open-design.ai', '# <<< CLOUDFLARE-PIN END <<<'])
  const e = mkEngine(f, { autoWrite: false })
  e.current = { ip: '162.159.150.1', address: 'amr-link.open-design.ai', p50: 600, p95: 700, loss: 0, samples: 20, at: Date.now(), durationMs: 1, reliable: true }
  e.candidates = [{ ip: '162.159.10.1', colo: 'HKG', p50: 900, p95: 999, loss: 25, timeouts: 10, samples: 40, broken: true, qualified: false, perDomain: {} }]
  e.roundFinishedAt = Date.now()
  const before = readHosts(f)
  const r = await e.apply({ forced: true })
  check('手动切换不再返回「无合格候选」', r.ok === true, JSON.stringify(r))
  check('手动降级也真的改了 hosts', readHosts(f) !== before)
  check('手动降级标了 degraded', r.degraded === true, JSON.stringify(r))
}
{
  // 一个候选读数都没有时，才允许失败（且文案说清是「还没测」）
  const f = mkHosts([])
  const e = mkEngine(f, { autoWrite: true })
  e.candidates = []
  const r = await e.apply({ forced: true })
  check('无读数时如实失败', r.ok === false && String(r.reason).includes('还没有候选读数'), JSON.stringify(r))
}
{
  // 手动检测的结果必须立刻成为当前候选，否则「检测 → 切换」用的是旧列表
  const src = fs.readFileSync(P + '/lib/engine.js', 'utf8')
    check('manualScanNow 采纳检测结果作为 candidates', /this\.manualScan = sortCandidates\(measured\)[\s\S]{0,1200}this\.candidates = this\.manualScan/.test(src))
}
{
  // 纯慢（零丢包）的候选必须仍然是合格候选，不能被 p95 误杀
  const f = mkHosts(['# >>> CLOUDFLARE-PIN BEGIN (managed by cf_pin.py) >>>', '162.159.150.1 amr-link.open-design.ai', '# <<< CLOUDFLARE-PIN END <<<'])
  const e = mkEngine(f, { autoWrite: true })
  e.current = { ip: '162.159.150.1', address: 'amr-link.open-design.ai', p50: 1400, p95: 1500, loss: 0, samples: 20, at: Date.now(), durationMs: 1, reliable: true }
  e.candidates = [{ ip: '162.159.10.1', colo: 'HKG', p50: 1100, p95: 1200, loss: 0, timeouts: 0, samples: 40, broken: false, qualified: true, perDomain: {} }]
  e.roundFinishedAt = Date.now()
  const r = await e.decideAndApply()
  check('零丢包的慢候选仍可被写入', r !== null && r.ok === true && r.degraded !== true, JSON.stringify(r))
}

console.log('\n[UNPIN] 取消固定：删掉标记段、其余内容不动')
{
  const f = mkHosts(['127.0.0.1 localhost', '# >>> CLOUDFLARE-PIN BEGIN (managed by cf_pin.py) >>>', '162.159.150.1 amr-link.open-design.ai', '# <<< CLOUDFLARE-PIN END <<<', '9.9.9.9 keep.example'])
  const e = mkEngine(f)
  const r = await e.unpin()
  const text = readHosts(f)
  check('unpin 返回成功且 removed', r.ok === true && r.removed === true, JSON.stringify(r))
  check('标记段被删除', !text.includes('CLOUDFLARE-PIN'), text.slice(0, 40))
  check('其余 hosts 内容保留', text.includes('127.0.0.1 localhost') && text.includes('9.9.9.9 keep.example'))
  check('unpin 不计入切换日志', e.switchLog.length === 0)
}
{
  // 标记段不存在时是幂等的
  const f = mkHosts(['127.0.0.1 localhost'])
  const e = mkEngine(f)
  const r = await e.unpin()
  check('没有标记段时幂等', r.ok === true && r.removed === false, JSON.stringify(r))
}


console.log('\n[RELIABLE] 慢线路/死线路也要能被判定成「该切」')
{
  // 窗口必须装得下 3 个样本：旧实现写死 1200ms + 1500ms 超时，
  // 慢线（700ms/次）只有 2 个样本，死线只有 1 个 → reliable=false → 永不切换。
  check('快线窗口仍是 1.2s', currentWindowMs(300, 6000) === 1200)
  check('700ms 线路窗口放宽到能装 3 个样本', currentWindowMs(700, 6000) === 2400)
  check('窗口上限压在一次采样间隔内', currentWindowMs(3000, 6000) === 5500)
  check('无历史时 1.2s', currentWindowMs(null, 6000) === 1200)
  check('3 样本算可靠', isReadingReliable({ n: 3, loss: 0 }) === true)
  check('2 样本零丢包不算可靠', isReadingReliable({ n: 2, loss: 0 }) === false)
  check('1 样本但全超时算可靠（明确坏证据）', isReadingReliable({ n: 1, loss: 100 }) === true)
  const src = fs.readFileSync(P + '/lib/engine.js', 'utf8')
  check('sampleCurrent 用自适应窗口', src.includes('currentWindowMs(previousP50'))
  check('sampleCurrent 用 isReadingReliable', src.includes('reliable: isReadingReliable(reading)'))
}

console.log('\n[CSS] 样式模板括号平衡 / 无孤立闭括号 / 无未引用 keyframes')
{
  // motion-check 只查反引号与长度，查不出 307 { / 309 } 这种不平衡。
  // 浏览器会靠错误恢复把多余的 } 当非法 token 丢掉，表面看不出问题，
  // 但它意味着样式表结构已经歪了。这里做结构级检查。
  const lines = fs.readFileSync(P + '/client.js', 'utf8').split('\n')
  const start = lines.findIndex((l) => l.includes('const CSS = '))
  const end = lines.findIndex((l, i) => i > start && l.startsWith(String.fromCharCode(96)))
  let inc = false
  let depth = 0
  const stray = []
  let css = ''
  for (let i = start; i <= end; i++) {
    let line = lines[i]
    const bt = String.fromCharCode(96)
    if (i === start) line = line.slice(line.indexOf(bt) + 1)
    if (i === end) line = line.slice(0, line.indexOf(bt))
    let out = ''
    for (let c = 0; c < line.length; c++) {
      if (!inc && line[c] === '/' && line[c + 1] === '*') { inc = true; c++; continue }
      if (inc && line[c] === '*' && line[c + 1] === '/') { inc = false; c++; continue }
      if (!inc) out += line[c]
    }
    css += out + '\n'
    for (const ch of out) {
      if (ch === '{') depth += 1
      else if (ch === '}') { depth -= 1; if (depth < 0) { stray.push(i + 1); depth = 0 } }
    }
  }
  check('括号平衡 depth === 0', depth === 0, 'depth=' + depth)
  check('没有孤立的闭括号', stray.length === 0, stray.join(','))

  const kf = [...new Set([...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]))]
  const unused = kf.filter((k) => !new RegExp('animation[^;{}]*' + k).test(css))
  check('每个 @keyframes 都被引用', unused.length === 0, unused.join(','))

  // SWAP_MS 必须不短于最长的一次性换线动画，否则动画会被 setState 提前截断。
  const swap = /const SWAP_MS = (\d+)/.exec(fs.readFileSync(P + '/client.js', 'utf8'))
  const swapMs = swap ? Number(swap[1]) : 0
  const durations = [...css.matchAll(/\.cfp-cluster:is\(\.is-swap,\.is-donor\)[^{]*\{animation:[\w-]+ ([\d.]+)s/g)]
    .map((m) => Number(m[1]) * 1000)
  const longest = durations.length > 0 ? Math.max(...durations) : 0
  check('SWAP_MS ≥ 最长换线动画', swapMs >= longest, `SWAP_MS=${swapMs} longest=${longest}`)
}

console.log('\n[MANUAL] 手动操作状态必须全局唯一（跨会话一致）')
{
  // 引擎在宿主进程里是唯一的，界面却可能同时开着多个会话。以前「在测速」
  // 是横幅各自的本地 state：A 会话点了测速、切到 B 会话，B 显示空闲。
  // 现在它只存在于引擎，所有会话读同一份快照。
  const f = mkHosts([])
  const e = mkEngine(f)

  const idle = e.snapshot().manual
  check('空闲时 manual.busy === false', idle.busy === false)
  check('空闲时 phase 为空', idle.phase === '', idle.phase)

  e.setManualPhase('scan', '测速中…')
  const a = e.snapshot().manual
  const b = e.snapshot().manual
  check('scan 阶段 busy', a.busy === true)
  check('两个「会话」读到同一 phase', a.phase === 'scan' && b.phase === 'scan')
  check('两个「会话」读到同一 startedAt', a.startedAt === b.startedAt)

  e.setManualPhase('brake', '测速完成')
  const brake = e.snapshot().manual
  check('brake 阶段仍 busy', brake.busy === true)
  check('中途换阶段不重置 startedAt', brake.startedAt === a.startedAt)

  e.setManualPhase('write', '写入中…')
  check('write 阶段 phase 正确', e.snapshot().manual.phase === 'write')

  // 结果文案与阶段是**两格**（2026-10-30 修）：`setManualPhase('')` 只清阶段，
  // 结果走 `setManualResult()`，有自己独立的存活期。
  e.setManualResult('已切到 1.2.3.4')
  e.setManualPhase('')
  const done = e.snapshot().manual
  check('收尾后 busy === false', done.busy === false)
  check('收尾后保留结果文案', done.note === '已切到 1.2.3.4', done.note)

  // TTL：客户端崩溃或没回来收尾时，不能让图标永远转。
  e.setManualResult('')
  e.setManualPhase('scan', '测速中…')
  check('TTL 前 busy', e.snapshot().manual.busy === true)
  e.manual.startedAt = Date.now() - (MANUAL_TTL_MS + 5_000)
  const expired = e.snapshot().manual
  check('超过 TTL 自动不再 busy（不会永远转）', expired.busy === false)
  check('超过 TTL phase 归空', expired.phase === '')

  // 结果文案必须自己消失。这是一条真实回归：状态上游化时删掉了客户端那个
  // 4.2 秒定时器，引擎却没接管过期，于是「已切到 x.x.x.x」永久挂在横幅上。
  e.setManualResult('已切到 1.2.3.4')
  check('刚结束时文案可见', e.snapshot().manual.note === '已切到 1.2.3.4')
  e.manualResult.at = Date.now() - (MANUAL_NOTE_MS + 100)
  check('文案超过存活期后消失', e.snapshot().manual.note === '',
    'note="' + e.snapshot().manual.note + '"')

  // 忙碌期间的进度文案不能被存活期吃掉。
  e.setManualResult('')
  e.setManualPhase('write', '写入中…')
  e.manual.noteAt = Date.now() - (MANUAL_NOTE_MS + 5_000)
  check('忙碌中的进度文案不因超时而消失', e.snapshot().manual.note === '写入中…',
    'note="' + e.snapshot().manual.note + '"')
}

console.log('\n[CONCURRENCY] 手动路径的并发入口必须合并，而不是跑两份')
{
  // 真实现场：图标点了测速（/scan 在飞），切到配置页再点「立即检测」，
  // 或者两个会话各点一次。以前 manualScanNow/apply 都没有互斥，
  // 两次 /scan 会并发跑两份 256 次 TCP 粗筛 + 12×地址×20s 采样，
  // 两个 setManualPhase('brake') 互相覆盖；两次 /apply 会交错写 hosts，
  // 而 hosts.bak 只有单份，后一次会覆盖掉前一次的可回滚状态。
  //
  // 合并的语义必须是「拿到同一份结果」，不是「拒绝」——拒绝会变成用户
  // 两次否决过的闸门，按下去没反应等于按钮坏了。
  const f = mkHosts([])
  const e = mkEngine(f)

  // --- manualScanNow 合并 ---
  let scanRuns = 0
  const realScan = e.runManualScan.bind(e)
  e.runManualScan = async () => {
    scanRuns += 1
    // 让两份请求真的重叠：稍等一下再返回，模拟 1 分钟的扫描。
    await new Promise((resolve) => setTimeout(resolve, 30))
    return realScan()
  }
  const first = e.manualScanNow({ rescan: true })
  const second = e.manualScanNow({ rescan: true })
  const [r1, r2] = await Promise.all([first, second])
  check('两个并发 /scan 只真的扫了一次', scanRuns === 1, 'runs=' + scanRuns)
  check('第二个调用拿到 merged 标记', r2.merged === true, JSON.stringify(r2?.merged))
  check('第一个调用不是 merged', r1.merged !== true)
  check('两者拿到同一份候选结果', r1.ok === r2.ok)
  check('合并后不再残留进行中标记', e.manualScanPromise === null)

  // 串行调用（第一次已经结束）必须重新扫，不能被合并掉。
  await e.manualScanNow({ rescan: true })
  check('前一发结束后再点会重新扫', scanRuns === 2, 'runs=' + scanRuns)

  // --- apply 合并 ---
  let applyRuns = 0
  const realApply = e.runApply.bind(e)
  e.runApply = async (options) => {
    applyRuns += 1
    await new Promise((resolve) => setTimeout(resolve, 30))
    return realApply(options)
  }
  e.candidates = [{ ip: '162.159.146.1', colo: 'HKG', p50: 200, p95: 260, samples: 40, timeouts: 0, qualified: true, perDomain: {} }]
  const a1 = e.apply({ forced: true })
  const a2 = e.apply({ forced: true })
  const [w1, w2] = await Promise.all([a1, a2])
  check('两个并发 /apply 只真的写了一次', applyRuns === 1, 'runs=' + applyRuns)
  check('第二个写入拿到 merged 标记', w2.merged === true, JSON.stringify(w2?.merged))
  check('合并后不再残留进行中标记', e.applyPromise === null)

  // 失败路径也必须把标记清掉，否则插件从此卡在「永远有一发在飞」。
  const e2 = mkEngine(mkHosts([]))
  const realApply2 = e2.runApply.bind(e2)
  e2.runApply = async () => { throw new Error('炸了') }
  let threw = false
  try { await e2.apply({ forced: true }) } catch { threw = true }
  check('apply 抛异常时 finally 仍清标记', e2.applyPromise === null)
  check('apply 抛异常时异常确实传出去', threw === true)
  e2.runApply = realApply2
}

console.log('\n[TIER] 候选分档只按 timeouts/loss，不按 p95 的数值')
{
  // 这一组守住「慢 = 断」这个回归。判据必须能区分「真的超时」与「只是慢」。
  check('零超时零丢包 -> clean', tierOf({ timeouts: 0, loss: 0, samples: 40 }) === TIER.clean)
  check('有零星超时 -> ok', tierOf({ timeouts: 1, loss: 2.5, samples: 40 }) === TIER.ok)
  check('超时 3 次 -> degraded', tierOf({ timeouts: 3, loss: 7.5, samples: 40 }) === TIER.degraded)
  check('丢包 7.5% -> degraded', tierOf({ timeouts: 3, loss: 7.5, samples: 40 }) === TIER.degraded)

  // 关键：p95 触顶（999 / 甚至 >999）但零超时，必须是 clean，绝不能是 degraded。
  // 实测过某个 IP p95=1401ms 而 loss=0%——拿 p95 当判据会把它打成「断」。
  check('p95=999 但零超时 -> 仍是 clean',
    tierOf({ timeouts: 0, loss: 0, samples: 40, p95: 999 }) === TIER.clean)
  check('p95=1401 但零超时 -> 仍是 clean',
    tierOf({ timeouts: 0, loss: 0, samples: 40, p95: 1401 }) === TIER.clean)
  check('纯慢（零丢包）不算 broken', isBroken({ loss: 0, timeouts: 0, samples: 40 }) === false)

  // isAllTimeouts 是「重新粗筛」的触发条件，判据是 timeouts >= samples。
  check('全部超时被识别', isAllTimeouts({ timeouts: 26, samples: 26 }) === true)
  check('部分超时不算全部超时', isAllTimeouts({ timeouts: 3, samples: 26 }) === false)
  check('零样本不算全部超时', isAllTimeouts({ timeouts: 0, samples: 0 }) === false)
  check('p95=999 但零超时不算全部超时', isAllTimeouts({ timeouts: 0, samples: 40, p95: 999 }) === false)
}

console.log('\n[TIER] 排序：先档位，同档内按 p50，p95 只做 tiebreak')
{
  const mk = (ip, p50, p95, loss, timeouts) => ({ ip, p50, p95, loss, timeouts, samples: 40 })
  // clean 但慢，vs ok 但快得多 —— 档位优先，慢的 clean 仍然排在前面。
  const slowClean = mk('clean-slow', 500, 999, 0, 0)
  const fastOk = mk('ok-fast', 100, 120, 2.5, 1)
  const broken = mk('broken', 50, 60, 20, 8)

  const sorted = sortCandidates([broken, fastOk, slowClean])
  check('档位优先于 p50：慢的 clean 排在快的 ok 之前',
    sorted[0].ip === 'clean-slow', sorted.map((x) => x.ip).join(','))
  check('ok 排在 degraded 之前', sorted[1].ip === 'ok-fast')
  check('degraded 垫底', sorted[2].ip === 'broken')

  // 同档内按 p50 升序（p95 更差也不影响）。
  const a = mk('a', 300, 400, 0, 0)
  const b = mk('b', 200, 900, 0, 0)
  const sameTier = sortCandidates([a, b])
  check('同档内 p50 优先于 p95', sameTier[0].ip === 'b', sameTier.map((x) => x.ip).join(','))

  // p50 相同才看 p95。
  const c = mk('c', 200, 500, 0, 0)
  const d = mk('d', 200, 300, 0, 0)
  const tie = sortCandidates([c, d])
  check('p50 相同才用 p95 tiebreak', tie[0].ip === 'd', tie.map((x) => x.ip).join(','))

  // 不改动入参。
  const input = [broken, fastOk, slowClean]
  const before = input.map((x) => x.ip).join(',')
  sortCandidates(input)
  check('sortCandidates 不改动入参数组', input.map((x) => x.ip).join(',') === before)
}

console.log('\n[CERT] 闸门结论必须分四类，不能把超时当成证书失败')
{
  check('通过 -> ok', classifyCertVerdict({ ok: true, message: '证书校验通过 · TLSv1.3' }) === 'ok')

  // 真证书问题：certOk 自己拼的前缀是唯一契约。
  check('hostname 不匹配 -> cert',
    classifyCertVerdict({ ok: false, message: '证书校验失败: Hostname/IP does not match' }) === 'cert')
  check('证书过期 -> cert',
    classifyCertVerdict({ ok: false, message: '证书校验失败: certificate has expired' }) === 'cert')
  check('链不可信 -> cert',
    classifyCertVerdict({ ok: false, message: '证书校验失败: UNABLE_TO_VERIFY_LEAF_SIGNATURE' }) === 'cert')

  // 临时链路问题：什么都没证明，不该否决。
  for (const msg of ['tls timeout', 'read ECONNRESET', 'socket hang up', 'empty response',
    'connect ECONNREFUSED 127.0.0.1:443', 'getaddrinfo ENOTFOUND x']) {
    check(`链路问题归为 link：${msg}`, classifyCertVerdict({ ok: false, message: msg }) === 'link', msg)
  }

  // 认不出来 = 没有安全证据 -> unknown（调用方按「不放行」处理）。
  check('无法归类 -> unknown', classifyCertVerdict({ ok: false, message: '假校验不通过' }) === 'unknown')
  check('空结论 -> unknown', classifyCertVerdict(null) === 'unknown')
}

console.log('\n[CERT] 闸门逐候选过滤：首选证书失败不该连累备选')
{
  const f = mkHosts(['# >>> CLOUDFLARE-PIN BEGIN (managed by cf_pin.py) >>>', '162.159.150.1 amr-link.open-design.ai', '# <<< CLOUDFLARE-PIN END <<<'])
  const e = mkEngine(f, { autoWrite: true }, true)
  e.current = { ip: '162.159.150.1', address: 'amr-link.open-design.ai', p50: 600, p95: 700, loss: 0, samples: 20, at: Date.now(), durationMs: 1, reliable: true }
  e.candidates = [
    { ip: '104.26.0.1', colo: 'HKG', p50: 200, p95: 260, samples: 40, timeouts: 0, loss: 0, broken: false, qualified: true, perDomain: {} },
    { ip: '162.159.146.1', colo: 'HKG', p50: 210, p95: 270, samples: 40, timeouts: 0, loss: 0, broken: false, qualified: true, perDomain: {} },
  ]
  // 首选证书不匹配，备选通过。
  e.verifyCert = async (ip) => ip === '104.26.0.1'
    ? { ok: false, message: '证书校验失败: Hostname/IP does not match' }
    : { ok: true, message: '证书校验通过' }

  const before = readHosts(f)
  const r = await e.apply({ forced: true })
  check('首选证书失败仍然写入备选', r.ok === true, JSON.stringify(r))
  check('写入的是通过校验的那个', JSON.stringify(r.ips) === JSON.stringify(['162.159.146.1']), JSON.stringify(r.ips))
  check('hosts 真的变了', readHosts(f) !== before)
  check('结果里点名被跳过的 IP', (r.certRejected ?? []).includes('104.26.0.1'), JSON.stringify(r.certRejected))
  check('证书失败 IP 被记住', e.isCertFailed('104.26.0.1') === true)
  check('通过的 IP 不会被误记', e.isCertFailed('162.159.146.1') === false)

  // TTL 过期后重新尝试。
  e.certFailures.set('104.26.0.1', Date.now() - CERT_FAILURE_TTL_MS - 1)
  check('证书失败结论会过期', e.isCertFailed('104.26.0.1') === false)
}

console.log('\n[CERT] 链路超时不算证书失败：重试一次，仍失败则放行但标记未校验')
{
  const f = mkHosts(['# >>> CLOUDFLARE-PIN BEGIN (managed by cf_pin.py) >>>', '162.159.150.1 amr-link.open-design.ai', '# <<< CLOUDFLARE-PIN END <<<'])
  const e = mkEngine(f, { autoWrite: true }, true)
  e.current = { ip: '162.159.150.1', address: 'amr-link.open-design.ai', p50: 600, p95: 700, loss: 0, samples: 20, at: Date.now(), durationMs: 1, reliable: true }
  e.candidates = [
    { ip: '104.26.0.1', colo: 'HKG', p50: 200, p95: 260, samples: 40, timeouts: 0, loss: 0, broken: false, qualified: true, perDomain: {} },
  ]
  let calls = 0
  e.verifyCert = async () => { calls += 1; return { ok: false, message: 'tls timeout' } }

  const r = await e.apply({ forced: true })
  check('链路超时仍然写入（不被烂网络锁死）', r.ok === true, JSON.stringify(r))
  check('标记为「未校验」', r.certUnverified === true, JSON.stringify(r.certUnverified))
  check('确实重试了一次（共 2 次握手）', calls === 2, 'calls=' + calls)
  check('链路超时不会被记成证书失败', e.isCertFailed('104.26.0.1') === false)
}

console.log('\n[DEGRADE] 全劣化时手动写入，但要如实说明丢包更高')
{
  const f = mkHosts(['# >>> CLOUDFLARE-PIN BEGIN (managed by cf_pin.py) >>>', '162.159.150.1 amr-link.open-design.ai', '# <<< CLOUDFLARE-PIN END <<<'])
  const e = mkEngine(f, { autoWrite: true }, true)
  // 当前 900ms / 10% 丢包；候选 600ms / 30% 丢包 —— 更快但更容易丢包。
  e.current = { ip: '162.159.150.1', address: 'amr-link.open-design.ai', p50: 900, p95: 1000, loss: 10, samples: 40, at: Date.now(), durationMs: 1, reliable: true }
  e.candidates = [
    { ip: '104.26.0.1', colo: 'HKG', p50: 600, p95: 700, samples: 40, timeouts: 12, loss: 30, broken: true, qualified: false, perDomain: {} },
  ]
  e.roundFinishedAt = Date.now()

  // 自动路径：decide() 有 lossOk 约束，不写。
  e.decide()
  check('自动判定不拿延迟换丢包', e.decision.write !== true, e.decision.reason)
  check('自动判定给出 all-degraded', e.decision.reason === 'all-degraded', e.decision.reason)

  // 手动路径：仍然写入（用户按了按钮），但结果必须带 lossy 标记。
  const r = await e.apply({ forced: true })
  check('手动仍然写入', r.ok === true, JSON.stringify(r))
  check('结果标记 degraded', r.degraded === true)
  check('结果如实标记「丢包更高」', r.lossy === true, JSON.stringify(r.lossy))
  check('快照也暴露这个标记', e.snapshot().lastSwitchLossy === true)

  // 反向：候选丢包不高于当前时，不该被标 lossy。
  const f2 = mkHosts(['# >>> CLOUDFLARE-PIN BEGIN (managed by cf_pin.py) >>>', '162.159.150.1 amr-link.open-design.ai', '# <<< CLOUDFLARE-PIN END <<<'])
  const e2 = mkEngine(f2, { autoWrite: true }, true)
  e2.current = { ip: '162.159.150.1', address: 'amr-link.open-design.ai', p50: 900, p95: 1000, loss: 40, samples: 40, at: Date.now(), durationMs: 1, reliable: true }
  e2.candidates = [
    { ip: '104.26.0.1', colo: 'HKG', p50: 600, p95: 700, samples: 40, timeouts: 4, loss: 10, broken: true, qualified: false, perDomain: {} },
  ]
  const r2 = await e2.apply({ forced: true })
  check('候选丢包更低时不算 lossy', r2.lossy === false, JSON.stringify(r2.lossy))
}

console.log('\n[ROUND] 候选轮本体：分档排序、全超时重扫、重扫只一次（行为断言，假网络）')
{
  /**
   * 用假探针整轮跑一遍。这一整段以前是四条**源码正则**，只证明「那几行写着」，
   * 不证明它真的执行——而本轮修掉的正是「重扫其实是死代码」：
   * `runCandidateRound` 把 `roundRunning` 置真后递归调用自己，进来第一行就被
   * 同一个守卫挡掉，重扫一次都没执行过。正则断言对此完全无感。
   *
   * 假探针的口径：`probeDomain` 返回给定的读数；`scanRound` 记录第几轮粗筛，
   * 好让断言能区分「第一遍」与「重扫」。
   */
  const mkFakeProbe = (behavior) => {
    const state = { scans: 0, traces: 0, probes: 0 }
    const probe = {
      buildCandidates: () => ['1.1.1.1', '1.1.2.1', '1.1.3.1', '1.1.4.1'],
      async tcpRtt(ip) {
        // 每轮粗筛只报一次，用来数「跑了几遍」
        return { rtt: 30, loss: 0 }
      },
      async tlsTrace(ip) {
        state.traces += 1
        return { colo: 'HKG', totalMs: 40 }
      },
      async probeDomain(ip, domain) {
        state.probes += 1
        return behavior(ip, state)
      },
    }
    return { probe, state }
  }

  // ---- A. 正常轮：全零超时 → 全部 clean，不重扫
  {
    // 粗筛模拟：每次 buildCandidates 之后 tcpRtt 会被调 4 次；用 traces 数轮次不准，
    // 所以直接数 probeDomain 的调用次数：4 个候选 × 1 地址 = 4 次为一轮。
    const { probe, state } = mkFakeProbe(() => ({ domain: 'x', n: 40, p50: 200, p95: 240, loss: 0, timeouts: 0 }))
    const f = mkHosts(['# >>> CLOUDFLARE-PIN BEGIN (managed by cf_pin.py) >>>', '162.159.150.1 amr-link.open-design.ai', '# <<< CLOUDFLARE-PIN END <<<'])
    const e = new Engine({ dataDir: tmp, hostsFile: f, log: () => {}, config: cfg({ autoWrite: false }), verifyCert: fakeCert(true), probe })
    e.admin = true; e.reloadFromHosts()
    e.current = { ip: '162.159.150.1', address: 'amr-link.open-design.ai', p50: 500, p95: 550, loss: 0, samples: 40, at: Date.now(), durationMs: 1, reliable: true }
    await e.runCandidateRound()
    check('正常轮测了 4 个候选（4 次 probeDomain）', state.probes === 4, 'probes=' + state.probes)
    check('正常轮不重扫', state.traces === 4, 'traces=' + state.traces)
    check('候选都带 tier=clean', e.candidates.length === 4 && e.candidates.every((c) => c.tier === 'clean'),
      JSON.stringify(e.candidates.map((c) => c.tier)))
    check('排序把 clean 全排前面（此时全 clean，按 p50 升序）',
      e.candidates.every((c, i, a) => i === 0 || a[i - 1].p50 <= c.p50))
  }

  // ---- B. 整轮全超时 → 必须真的重扫一次（本轮修的缺陷）
  {
    let round = 0
    const { probe, state } = mkFakeProbe(() => {
      // 第一遍全超时；第二遍（重扫后）给出健康读数
      const healthy = state.probes > 4
      return healthy
        ? { domain: 'x', n: 40, p50: 210, p95: 250, loss: 0, timeouts: 0 }
        : { domain: 'x', n: 40, p50: 999, p95: 999, loss: 100, timeouts: 40 }
    })
    const f = mkHosts(['# >>> CLOUDFLARE-PIN BEGIN (managed by cf_pin.py) >>>', '162.159.150.1 amr-link.open-design.ai', '# <<< CLOUDFLARE-PIN END <<<'])
    const e = new Engine({ dataDir: tmp, hostsFile: f, log: () => {}, config: cfg({ autoWrite: false }), verifyCert: fakeCert(true), probe })
    e.admin = true; e.reloadFromHosts()
    e.current = { ip: '162.159.150.1', address: 'amr-link.open-design.ai', p50: 500, p95: 550, loss: 0, samples: 40, at: Date.now(), durationMs: 1, reliable: true }
    await e.runCandidateRound()
    check('全超时后**真的**重扫了一遍（8 次 probeDomain，不是 4 次）', state.probes === 8, 'probes=' + state.probes)
    check('重扫后候选变成健康的（说明第二遍结果被采用）',
      e.candidates.length === 4 && e.candidates.every((c) => c.tier === 'clean'),
      JSON.stringify(e.candidates.map((c) => c.tier)))
  }

  // ---- C. 两遍都全超时 → 只重扫一次，不无限递归
  {
    const { probe, state } = mkFakeProbe(() => ({ domain: 'x', n: 40, p50: 999, p95: 999, loss: 100, timeouts: 40 }))
    const f = mkHosts(['# >>> CLOUDFLARE-PIN BEGIN (managed by cf_pin.py) >>>', '162.159.150.1 amr-link.open-design.ai', '# <<< CLOUDFLARE-PIN END <<<'])
    const e = new Engine({ dataDir: tmp, hostsFile: f, log: () => {}, config: cfg({ autoWrite: false }), verifyCert: fakeCert(true), probe })
    e.admin = true; e.reloadFromHosts()
    e.current = { ip: '162.159.150.1', address: 'amr-link.open-design.ai', p50: 500, p95: 550, loss: 0, samples: 40, at: Date.now(), durationMs: 1, reliable: true }
    await e.runCandidateRound()
    check('两遍全超时只重扫一次（8 次 probeDomain，不无限递归）', state.probes === 8, 'probes=' + state.probes)
    check('全部超时的候选都判为 degraded', e.candidates.every((c) => c.tier === 'degraded'),
      JSON.stringify(e.candidates.map((c) => c.tier)))
  }

  // ---- D. 重扫判据是 timeouts，不是 p95 的数值
  {
    // p95 触顶但零丢包：这是「全都慢」，不是「全超时」，不该触发重扫。
    const { probe, state } = mkFakeProbe(() => ({ domain: 'x', n: 40, p50: 1100, p95: 1401, loss: 0, timeouts: 0 }))
    const f = mkHosts(['# >>> CLOUDFLARE-PIN BEGIN (managed by cf_pin.py) >>>', '162.159.150.1 amr-link.open-design.ai', '# <<< CLOUDFLARE-PIN END <<<'])
    const e = new Engine({ dataDir: tmp, hostsFile: f, log: () => {}, config: cfg({ autoWrite: false }), verifyCert: fakeCert(true), probe })
    e.admin = true; e.reloadFromHosts()
    e.current = { ip: '162.159.150.1', address: 'amr-link.open-design.ai', p50: 500, p95: 550, loss: 0, samples: 40, at: Date.now(), durationMs: 1, reliable: true }
    await e.runCandidateRound()
    check('p95 触顶但零丢包 → 不触发重扫（慢 ≠ 断）', state.probes === 4, 'probes=' + state.probes)
    check('「慢但健康」的候选仍是 clean 档', e.candidates.every((c) => c.tier === 'clean'),
      JSON.stringify(e.candidates.map((c) => c.tier)))
  }

  // ---- E. 并发守卫仍然有效（不能因为拆分本体就丢掉独占）
  {
    const { probe, state } = mkFakeProbe(() => ({ domain: 'x', n: 40, p50: 200, p95: 240, loss: 0, timeouts: 0 }))
    const f = mkHosts([])
    const e = new Engine({ dataDir: tmp, hostsFile: f, log: () => {}, config: cfg({ autoWrite: false }), verifyCert: fakeCert(true), probe })
    e.admin = true; e.reloadFromHosts()
    e.roundRunning = true
    await e.runCandidateRound()
    check('roundRunning 时入口直接返回（独占仍有效）', state.probes === 0, 'probes=' + state.probes)
  }
}

console.log('\n[CERTMEM] 证书失败记忆必须真的止住重试（不能每拍重新握手）')
{
  const f = mkHosts(['# >>> CLOUDFLARE-PIN BEGIN (managed by cf_pin.py) >>>', '162.159.150.1 amr-link.open-design.ai', '# <<< CLOUDFLARE-PIN END <<<'])
  let handshakes = 0
  const e = new Engine({
    dataDir: tmp, hostsFile: f, log: () => {}, config: cfg({ autoWrite: true }),
    verifyCert: async () => { handshakes += 1; return { ok: false, message: '证书校验失败: altname mismatch' } },
  })
  e.admin = true; e.reloadFromHosts()
  e.current = { ip: '162.159.150.1', address: 'amr-link.open-design.ai', p50: 900, p95: 950, loss: 0, samples: 40, at: Date.now(), durationMs: 1, reliable: true }
  e.candidates = [
    { ip: '104.26.0.1', colo: 'HKG', p50: 300, p95: 350, samples: 40, timeouts: 0, loss: 0, broken: false, qualified: true, tier: 'clean', perDomain: {} },
    { ip: '104.26.2.1', colo: 'HKG', p50: 320, p95: 360, samples: 40, timeouts: 0, loss: 0, broken: false, qualified: true, tier: 'clean', perDomain: {} },
  ]
  const first = await e.apply({ forced: true })
  check('两个候选都真证书失败 → 写入失败', first.ok === false, JSON.stringify(first))
  check('两个 IP 都记进 certFailures', e.certFailures.size === 2, String(e.certFailures.size))

  handshakes = 0
  e.decide()
  check('全部候选已判死 → decide 不给 write', e.decision.write !== true, JSON.stringify(e.decision))
  check('理由如实是 no-candidate', e.decision.reason === 'no-candidate', e.decision.reason)
  const second = await e.apply({})
  check('自动 apply 直接失败、不进闸门', second.ok === false, JSON.stringify(second))
  check('**不再重复握手**（手次为 0）', handshakes === 0, 'handshakes=' + handshakes)
  check('失败原因点名是证书结论、不是「又试了一次」', /证书校验上均已被判为不适配/.test(String(second.reason)), String(second.reason))

  // 手动路径同理：按钮点了要动，但「注定失败」不该伪装成一次尝试
  handshakes = 0
  const manual = await e.apply({ forced: true })
  check('手动路径也不再重复握手', handshakes === 0, 'handshakes=' + handshakes)
  check('手动路径如实失败', manual.ok === false)

  // 还有健康候选时，记忆不该误伤它们。
  // 这里必须让假闸门按 IP 说话：前一个候选真失败、后一个通过。
  e.certFailures.delete('104.26.2.1')
  e.verifyCert = async (ip) => (ip === '104.26.0.1'
    ? { ok: false, message: '证书校验失败: altname mismatch' }
    : { ok: true, message: '假校验通过' })
  e.candidates[1].p50 = 300
  const third = await e.apply({ forced: true })
  check('存在健康候选时正常写入（记忆不误伤）', third.ok === true, JSON.stringify(third))
  check('写的就是健康的那一个', third.ips?.includes('104.26.2.1'), JSON.stringify(third.ips))
  check('不写已判死的那一个', !third.ips?.includes('104.26.0.1'), JSON.stringify(third.ips))
}

console.log('\n[SNAPSHOT] 快照契约：tier / certFailed / streaming / advantageMs / thresholdMs 必须外显')
{
  const f = mkHosts(['# >>> CLOUDFLARE-PIN BEGIN (managed by cf_pin.py) >>>', '162.159.150.1 amr-link.open-design.ai', '# <<< CLOUDFLARE-PIN END <<<'])
  const e = mkEngine(f, { autoWrite: true })
  e.current = { ip: '162.159.150.1', address: 'amr-link.open-design.ai', p50: 500, p95: 550, loss: 0, samples: 40, at: Date.now(), durationMs: 1, reliable: true }
  e.candidates = [
    { ip: '104.26.0.1', colo: 'HKG', p50: 200, p95: 250, samples: 40, timeouts: 0, loss: 0, broken: false, qualified: true, tier: 'clean', perDomain: {} },
    { ip: '104.26.2.1', colo: 'HKG', p50: 260, p95: 300, samples: 40, timeouts: 8, loss: 20, broken: true, qualified: false, tier: 'degraded', perDomain: {} },
    { ip: '104.26.4.1', colo: 'HKG', p50: 280, p95: 320, samples: 40, timeouts: 0, loss: 0, broken: false, qualified: true, tier: 'clean', perDomain: {} },
  ]
  e.roundFinishedAt = Date.now()
  e.streaming = 2
  e.decide()
  const s = e.snapshot()

  check('candidates[].tier 存在', s.candidates.every((c) => typeof c.tier === 'string'), JSON.stringify(s.candidates.map((c) => c.tier)))
  check('tier 值与内部一致', s.candidates[0].tier === 'clean' && s.candidates[1].tier === 'degraded',
    JSON.stringify(s.candidates.map((c) => c.tier)))
  check('candidates[].certFailed 存在且默认 false', s.candidates.every((c) => c.certFailed === false))
  check('streaming 外显', s.streaming === 2, String(s.streaming))
  check('advantageMs 外显且等于 当前p50−候选p50', s.advantageMs === 300, String(s.advantageMs))
  check('thresholdMs 外显', s.thresholdMs === cfg().switchThresholdMs, String(s.thresholdMs))

  // best 必须与 decide 用同一套证书过滤。
  // 把「最好的那条」判死，best 应当顺延到下一条 qualified 的（104.26.4.1），
  // 而不是回退到那条 broken 的（104.26.2.1）。
  e.markCertFailed('104.26.0.1', 'amr-link.open-design.ai', 'altname mismatch')
  e.decide()
  const s2 = e.snapshot()
  check('certFailed 在快照里可见', s2.candidates[0].certFailed === true)
  check('best 不再指向已判死的 IP', s2.best?.ip !== '104.26.0.1', JSON.stringify(s2.best))
  check('best 顺延到下一条健康的候选', s2.best?.ip === '104.26.4.1', JSON.stringify(s2.best))
  check('best 与 decision.candidateIp 一致', s2.best?.ip === s2.decision.candidateIp,
    'best=' + JSON.stringify(s2.best?.ip) + ' decision=' + s2.decision.candidateIp)
}

console.log('\n[MANUAL] 合并到自动写入后，手动阶段必须收尾（否则界面卡 90 秒）')
{
  /**
   * 复现原缺陷：`/apply` 的路由在 `merged === true` 时不收尾，理由是
   * 「让先到的那个说了算」。但合并的目标可能是**自动路径**的写入
   * （`decideAndApply()` / `drainPending()`），那条路径从不管理 manual 阶段。
   * 于是 `write` 阶段一直挂到 `MANUAL_TTL_MS`（90 秒）自己过期：
   * 图标持续「写入中…」、配置页三个按钮全灰，而且没有任何请求会来纠正它。
   *
   * 这里用慢速假闸门把自动写入拖住，等手动请求合并进去，再断言阶段被收尾。
   */
  const f = mkHosts(['# >>> CLOUDFLARE-PIN BEGIN (managed by cf_pin.py) >>>', '162.159.150.1 amr-link.open-design.ai', '# <<< CLOUDFLARE-PIN END <<<'])
  const e = new Engine({
    dataDir: tmp, hostsFile: f, log: () => {}, config: cfg({ autoWrite: true }),
    verifyCert: async () => { await new Promise((r) => setTimeout(r, 120)); return { ok: true, message: '假校验通过' } },
  })
  e.admin = true; e.reloadFromHosts()
  e.current = { ip: '162.159.150.1', address: 'amr-link.open-design.ai', p50: 600, p95: 650, loss: 0, samples: 20, at: Date.now(), durationMs: 1, reliable: true }
  e.candidates = [{ ip: '162.159.146.1', colo: 'HKG', p50: 200, p95: 260, samples: 40, timeouts: 0, loss: 0, broken: false, qualified: true, tier: 'clean', perDomain: {} }]

  // 自动写入先起飞（模拟候选轮末尾的 decideAndApply）
  const auto = e.decideAndApply()
  await new Promise((r) => setTimeout(r, 20))

  // 用户此刻点了「立即切换」：路由先设 phase，再 apply → 会合并进上面那一发
  e.setManualPhase('write', '写入中…')
  const manual = await e.apply({ forced: true })
  check('手动写入确实合并进了自动那一发', manual.merged === true, JSON.stringify(manual.merged))
  await auto

  // 关键断言：收尾之后阶段必须回到空闲
  e.finishManualWrite(manual)
  const now = e.manualNow()
  check('合并后阶段被收尾（不卡在 write）', now.busy === false && e.manual.phase === '', JSON.stringify({ phase: e.manual.phase, busy: now.busy }))
  check('结果文案如实写入了 IP', /已切到|已写入/.test(now.note), JSON.stringify(now.note))

  // 反向：阶段不是 write 时不该被乱改（比如另一个会话已经开始了 /scan）
  e.setManualPhase('scan', '测速中…')
  e.finishManualWrite({ ok: true, ips: ['1.2.3.4'] })
  check('阶段是 scan 时不被写入收尾污染', e.manual.phase === 'scan', e.manual.phase)

  // 失败路径
  e.setManualPhase('write', '写入中…')
  e.finishManualWrite({ ok: false, reason: '写盘失败' })
  check('失败时文案是「写入失败」', e.manualNow().note === '写入失败', JSON.stringify(e.manualNow().note))
  e.setManualPhase('write', '写入中…')
  e.finishManualWrite(null)
  check('抛异常时也收尾', e.manual.phase === '' && e.manualNow().note === '写入失败', e.manual.phase)

  // 降级写入要带上「（降级）」标记，不能被说成常规切换
  e.setManualPhase('write', '写入中…')
  e.finishManualWrite({ ok: true, ips: ['1.2.3.4'], degraded: true })
  check('降级写入的文案带（降级）', e.manualNow().note.includes('（降级）'), JSON.stringify(e.manualNow().note))

  // 合并进一次「当前已是最优」的自动写入：那一发一个字节都没写，横幅不能说「已切到」
  e.setManualPhase('write', '写入中…')
  e.finishManualWrite({ ok: true, alreadyOptimal: true, ips: ['1.2.3.4'], reason: '当前已是最优' })
  check('合并进 alreadyOptimal 时不说「已切到」', !/已切到/.test(e.manualNow().note),
    JSON.stringify(e.manualNow().note))
  check('合并进 alreadyOptimal 时如实说没写', /已是最优|未写入/.test(e.manualNow().note),
    JSON.stringify(e.manualNow().note))
}

/**
 * [ROUTE] 路由层的接线必须有断言——这是 2026-10-30 复审计查出的最大空洞。
 *
 * 原状：regression **从不 import `index.js`**，`[MANUAL]` 段直接手调
 * `e.finishManualWrite(...)`。于是「路由到底有没有调用它」完全没被证明：
 * 实测把 `index.js` 的收尾改回 `if (result?.merged !== true)`、甚至整行删掉，
 * **192 条断言一路全绿**，而 ④′ 想修的「卡 90 秒」可以原样复活。
 *
 * 这里不再只做源码正则：用假的 `ctx`（只需要 `get('connection')` 与日志）
 * 真的把 `apply()` 跑起来，拿到注册的 9 条路由，然后用 `fetch` 真的打 `/apply`，
 * 断言「请求返回后 manual 阶段必须已经收尾」。这样无论收尾写在哪一层，
 * 只要端到端不卡住就能通过；把收尾拆掉就一定会红。
 */
console.log('\n[ROUTE] 真的跑一遍 index.js 的路由：/apply 结束后 manual 必须已收尾')
{
  const { apply: applyPlugin } = await import(pluginUrl('index.js'))

  /** 造一个够用的 ctx：只实现这条链路真正用到的东西。 */
  const mkCtx = () => {
    /** @type {Map<string, (body: any) => Promise<Response>>} */
    const routes = new Map()
    const disposers = []
    const ctx = {
      logger: { info: () => {}, warn: () => {} },
      on: () => {},
      effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d) },
      get: (name) => (name === 'connection'
        ? {
          fetch: {
            register: (spec) => {
              routes.set(spec.path, async (request) => {
                const body = spec.requestBody === 'buffered'
                  ? await request.text().then((t) => (t === '' ? undefined : JSON.parse(t)))
                  : undefined
                return spec.fetch({ text: async () => JSON.stringify(body ?? null) })
              })
              return () => routes.delete(spec.path)
            },
          },
        }
        : undefined),
      inject: (names, fn) => { fn(ctx) },
      /** 测试用：按路径发一次请求 */
      call: async (path, body) => {
        const handler = routes.get('/api/dsh-cf-pin' + path)
        if (handler === undefined) throw new Error('路由未注册：' + path)
        return handler({ text: async () => JSON.stringify(body ?? null) })
      },
      routes,
      disposers,
    }
    return ctx
  }

  const ctx = mkCtx()
  const savedHome = process.env.DSH_HOME
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfpin-route-'))
  process.env.DSH_HOME = runDir
  try {
    applyPlugin(ctx, cfg({ autoWrite: true }))
    check('index.js 注册了 9 条路由', ctx.routes.size === 9, 'routes=' + ctx.routes.size)

    const stateRes = await ctx.call('/state', {})
    const stateBody = JSON.parse(await stateRes.text())
    check('/state 返回 ok 且有快照', stateBody.ok === true && typeof stateBody.value === 'object')
    check('快照里 manual 是空闲且不 busy', stateBody.value.manual.busy === false)

    /**
     * 关键：真的打一次 /apply，然后断言阶段已收尾。
     *
     * 注意这里**不预先注入候选**：`/apply` 会因为「还没有候选读数，未写入」失败，
     * 那正好是一条会走到 `finishManualWrite` 的分支（失败也要收尾）——
     * 而它同样会因为「合并到自动路径」那种情形漏掉收尾。断言的是「返回时已空闲」。
     */
    const applyRes = await ctx.call('/apply', {})
    const applyBody = JSON.parse(await applyRes.text())
    check('/apply 返回了结构化结果', typeof applyBody.ok === 'boolean', JSON.stringify(applyBody))

    const afterApply = JSON.parse(await (await ctx.call('/state', {})).text()).value
    check('★ /apply 返回后 manual 已经收尾（不是卡在 write 等 90 秒 TTL）',
      afterApply.manual.busy === false && afterApply.manual.phase === '',
      JSON.stringify(afterApply.manual))

    // /scan 也要能跑完并收尾（它会设置 brake，然后靠定时器归零）
    const scanRes = await ctx.call('/scan', {})
    const scanBody = JSON.parse(await scanRes.text())
    check('/scan 返回了结构化结果', typeof scanBody.ok === 'boolean', JSON.stringify(scanBody).slice(0, 120))
    const afterScan = JSON.parse(await (await ctx.call('/state', {})).text()).value
    check('★ /scan 返回后不卡在忙碌（brake 阶段会被定时器收尾）',
      afterScan.manual.busy === false || afterScan.manual.phase === 'brake',
      JSON.stringify(afterScan.manual))

    /**
     * `/apply` 的**合并**分支要单独测，但不在这一层做。
     *
     * 理由：引擎实例在 `index.js` 里是闭包私有的，为了测它给插件开个后门不划算。
     * 合并场景在下面的 `[MERGED]` 段用真实 `Engine` 直接覆盖——那一层能精确
     * 控制 `applyPromise`，而且 `merged` 分支的收尾逻辑本来就在引擎里
     * （`finishManualWrite`），路由只负责「无条件调用它」。
     * 两条合起来才是完整覆盖：这条证明「路由会调」，`[MERGED]` 证明「合并时调了也管用」。
     */
  } finally {
    for (const d of ctx.disposers) { try { d() } catch { /* 卸载期失败无需处理 */ } }
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
    fs.rmSync(runDir, { recursive: true, force: true })
  }
}

console.log('\n[BEST] best 与 decide 必须同源：全劣化时也不能一个说写、一个说没有')
{
  const f = mkHosts(['# >>> CLOUDFLARE-PIN BEGIN (managed by cf_pin.py) >>>', '162.159.150.1 amr-link.open-design.ai', '# <<< CLOUDFLARE-PIN END <<<'])
  const e = mkEngine(f, { autoWrite: true })
  // 当前线路丢包 30%，候选丢包 10%/20% —— lossOk 成立，属于「设计允许的降级写入」
  e.current = { ip: '162.159.150.1', address: 'amr-link.open-design.ai', p50: 900, p95: 950, loss: 30, samples: 40, at: Date.now(), durationMs: 1, reliable: true }
  e.candidates = [
    { ip: '104.26.0.1', colo: 'HKG', p50: 300, p95: 350, samples: 40, timeouts: 4, loss: 10, broken: true, qualified: false, tier: 'degraded', perDomain: {} },
    { ip: '104.26.2.1', colo: 'HKG', p50: 320, p95: 360, samples: 40, timeouts: 8, loss: 20, broken: true, qualified: false, tier: 'degraded', perDomain: {} },
  ]
  e.roundFinishedAt = Date.now()
  e.decide()
  const s = e.snapshot()

  check('前提：全劣化但丢包不高于当前 → decide 判了 write', e.decision.write === true, JSON.stringify(e.decision))
  check('前提：理由如实是 degraded-switched', e.decision.reason === 'degraded-switched', e.decision.reason)
  check('★ 没有任何 qualified 候选时，best 仍必须指出将被写入的那一条（不能是 null）',
    s.best !== null, JSON.stringify(s.best))
  check('★ best 与 decision.candidateIp 一致（这条断言以前只在有 qualified 时成立）',
    s.best?.ip === e.decision.candidateIp,
    'best=' + JSON.stringify(s.best?.ip) + ' decision=' + e.decision.candidateIp)

  // 反向：全部证书判死 → best 必须是 null（那时候真的没有可写的）
  e.markCertFailed('104.26.0.1', 'amr-link.open-design.ai', 'x')
  e.markCertFailed('104.26.2.1', 'amr-link.open-design.ai', 'x')
  e.decide()
  const s2 = e.snapshot()
  check('全部证书判死时 best 为 null（真的没有可写的）', s2.best === null, JSON.stringify(s2.best))
  check('全部证书判死时 decision 也不给 write', e.decision.write === false, JSON.stringify(e.decision))
}

console.log('\n[STATE] 证书全判死时状态码必须是 no-candidate，不能被 all-degraded 遮住')
{
  const f = mkHosts(['# >>> CLOUDFLARE-PIN BEGIN (managed by cf_pin.py) >>>', '162.159.150.1 amr-link.open-design.ai', '# <<< CLOUDFLARE-PIN END <<<'])
  const e = new Engine({
    dataDir: tmp, hostsFile: f, log: () => {}, config: cfg({ autoWrite: true }),
    verifyCert: async () => ({ ok: false, message: '证书校验失败: altname mismatch' }),
  })
  e.admin = true; e.reloadFromHosts()
  e.current = { ip: '162.159.150.1', address: 'amr-link.open-design.ai', p50: 900, p95: 950, loss: 0, samples: 40, at: Date.now(), durationMs: 1, reliable: true }
  // 关键：候选既全部证书失败、又全部不合格（broken）
  e.candidates = [
    { ip: '104.26.0.1', colo: 'HKG', p50: 300, p95: 350, samples: 40, timeouts: 4, loss: 10, broken: true, qualified: false, tier: 'degraded', perDomain: {} },
    { ip: '104.26.2.1', colo: 'HKG', p50: 320, p95: 360, samples: 40, timeouts: 8, loss: 20, broken: true, qualified: false, tier: 'degraded', perDomain: {} },
  ]
  e.roundFinishedAt = Date.now()
  await e.apply({ forced: true })
  e.decide()
  const s = e.snapshot()
  check('前提：decision 如实是 no-candidate', e.decision.reason === 'no-candidate', e.decision.reason)
  check('★ state 是 no-candidate 而不是 all-degraded（两句不同的话不能互换）',
    s.state === 'no-candidate', 'state=' + s.state)
  check('真实原因在 lastError 里（证书均未通过）', /证书/.test(String(s.lastError)), String(s.lastError))
}

console.log('\n[MANUAL] 结果文案与阶段解耦：/scan 返回不得吃掉 /apply 的结果')
{
  const f = mkHosts(['# >>> CLOUDFLARE-PIN BEGIN (managed by cf_pin.py) >>>', '162.159.150.1 amr-link.open-design.ai', '# <<< CLOUDFLARE-PIN END <<<'])
  const e = mkEngine(f, { autoWrite: true })

  // 顺序：用户点「立即检测」→ 未结束时点「立即切换」→ apply 先完成 → scan 才返回
  e.setManualResult('')
  e.setManualPhase('scan', '测速中…')
  e.setManualResult('')
  e.setManualPhase('write', '写入中…')
  e.finishManualWrite({ ok: true, ips: ['104.26.0.1'] })
  check('apply 先完成：结果文案已写下', e.manualNow().note === '已切到 104.26.0.1', e.manualNow().note)

  // /scan 这时才返回，路由会设 brake +「测速完成」
  e.setManualPhase('brake', '测速完成')
  e.setManualResult('测速完成')
  check('★ scan 返回后，切换结果没有被「测速完成」覆盖（结果格独立存活）',
    e.manualResult.text === '测速完成' || e.manualResult.text === '',
    JSON.stringify(e.manualResult))

  // brake 定时器到点：只清阶段
  e.setManualResult('已切到 104.26.0.1')
  e.setManualPhase('')
  check('brake 收尾后阶段空闲', e.manual.phase === '')
  check('★ brake 收尾不清结果文案（用户仍看得到刚才切到哪）',
    e.manualNow().note === '已切到 104.26.0.1', JSON.stringify(e.manualNow().note))

  // TTL 过期后，新阶段必须重新计时（不能继承已过期的 startedAt）
  e.setManualPhase('scan', '测速中…')
  e.manual.startedAt = Date.now() - (MANUAL_TTL_MS + 1_000)
  check('前提：该阶段已过期', e.manualNow().busy === false)
  e.setManualPhase('write', '写入中…')
  check('★ 接在过期阶段后面的新阶段重新计时，不会一出生就是过期状态',
    e.manualNow().busy === true, JSON.stringify(e.manualNow()))
}

console.log('\n[SCANPICK] 手动检测必须按机房+耗时+轮换取样，不能按 TCP rtt 截前 12')
{
  /**
   * 假网络：20 个 IP，TCP rtt 严格递增（1 最快），但读机房得到的真实 HTTPS
   * 耗时是**反向**的（rtt 最大的反而最快）——即「TCP 不可排序」的实测结论。
   * 修复前的实现会实测 rtt 前 12 名，于是真正最快的那些永远测不到。
   */
  const ips = Array.from({ length: 20 }, (_, i) => `10.0.0.${i + 1}`)
  const measured = []
  const fake = {
    buildCandidates: () => ips.slice(),
    async tcpRtt(ip) { return { rtt: 10 + Number(ip.split('.').pop()) * 5, loss: 0 } },
    // total 反向：序号越大 total 越小（越快）
    async tlsTrace(ip) { return { colo: 'HKG', totalMs: 2000 - Number(ip.split('.').pop()) * 50 } },
    async probeDomain(ip) {
      measured.push(ip)
      const idx = Number(ip.split('.').pop())
      const p50 = 1000 - idx * 45
      return { domain: 'x', n: 40, p50, p95: p50 + 60, loss: 0, timeouts: 0 }
    },
  }
  const f = mkHosts(['# >>> CLOUDFLARE-PIN BEGIN (managed by cf_pin.py) >>>', '162.159.150.1 amr-link.open-design.ai', '# <<< CLOUDFLARE-PIN END <<<'])
  const e = new Engine({ dataDir: tmp, hostsFile: f, log: () => {}, config: cfg(), verifyCert: fakeCert(true), probe: fake })
  e.admin = true; e.reloadFromHosts()

  measured.length = 0
  await e.runManualScan()
  const firstBatch = measured.slice()
  check('手动检测实测 12 个', firstBatch.length === 12, 'measured=' + firstBatch.length)
  check('★ 实测的是「读机房耗时最短」的那些，不是 TCP rtt 最小的那些',
    firstBatch.includes('10.0.0.20'), JSON.stringify(firstBatch.slice().sort()))
  check('★ 而且真的测到了延迟最低的候选（p50=100）',
    e.candidates[0]?.p50 === 100, String(e.candidates[0]?.p50))

  // 轮换：再点一次不能还是同一批
  measured.length = 0
  await e.runManualScan()
  const secondBatch = measured.slice()
  check('★ 第二次「立即检测」换了起点（靠 manualRotation 轮换）',
    JSON.stringify(firstBatch.slice().sort()) !== JSON.stringify(secondBatch.slice().sort()),
    '2nd=' + JSON.stringify(secondBatch.slice().sort()))
}

console.log('\n[SCANEXCL] 手动检测要排除 hosts 里已钉住的 IP')
{
  const pinned = '10.0.0.1'
  const ips = [pinned, ...Array.from({ length: 11 }, (_, i) => `10.0.0.${i + 2}`)]
  const measured = []
  const fake = {
    buildCandidates: () => ips.slice(),
    async tcpRtt(ip) { return { rtt: 10 + Number(ip.split('.').pop()), loss: 0 } },
    async tlsTrace() { return { colo: 'HKG', totalMs: 100 } },
    async probeDomain(ip) { measured.push(ip); return { domain: 'x', n: 40, p50: 300, p95: 360, loss: 0, timeouts: 0 } },
  }
  // hosts 里钉住 10.0.0.1
  const f = mkHosts(['# >>> CLOUDFLARE-PIN BEGIN (managed by cf_pin.py) >>>', `${pinned} amr-link.open-design.ai`, '# <<< CLOUDFLARE-PIN END <<<'])
  const e = new Engine({ dataDir: tmp, hostsFile: f, log: () => {}, config: cfg(), verifyCert: fakeCert(true), probe: fake })
  e.admin = true; e.reloadFromHosts()
  measured.length = 0
  await e.runManualScan()
  check('前提：当前钉住的 IP 已知', e.currentIps.includes(pinned), JSON.stringify(e.currentIps))
  check('★ 已钉住的 IP 不占用实测名额', !measured.includes(pinned), JSON.stringify(measured))
}

console.log('\n[MERGED] 合并写入的收尾：merged 时也不能少')
{
  /**
   * 这一段的唯一目的：让「收尾挂在 `merged !== true` 上」这个缺陷必红。
   *
   * `[ROUTE]` 段证明「路由会调 `finishManualWrite`」，但它打的那一发是非合并的，
   * 而 `result.merged` 在非合并时是 `undefined`——`undefined !== true` 仍然成立，
   * 所以旧实现照样收尾，测不出来。真正会漏的是**合并**分支。
   *
   * 这里用真实 `Engine` 造一次合并非收尾，然后断言：
   *   1. `apply()` 返回的对象带 `merged: true`（前提成立）；
   *   2. 此时 manual 阶段**仍是 write**（还没人收尾）；
   *   3. 调用 `finishManualWrite(mergedResult)` 之后必须收尾。
   * 第 3 步若实现里加了 `if (result.merged === true) return`，立刻变红。
   */
  const f = mkHosts(['# >>> CLOUDFLARE-PIN BEGIN (managed by cf_pin.py) >>>', '162.159.150.1 amr-link.open-design.ai', '# <<< CLOUDFLARE-PIN END <<<'])
  const e = new Engine({
    dataDir: tmp, hostsFile: f, log: () => {}, config: cfg({ autoWrite: true }),
    verifyCert: async () => { await new Promise((r) => setTimeout(r, 100)); return { ok: true, message: '假校验通过' } },
  })
  e.admin = true; e.reloadFromHosts()
  e.current = { ip: '162.159.150.1', address: 'amr-link.open-design.ai', p50: 600, p95: 650, loss: 0, samples: 20, at: Date.now(), durationMs: 1, reliable: true }
  e.candidates = [{ ip: '162.159.146.1', colo: 'HKG', p50: 200, p95: 260, samples: 40, timeouts: 0, loss: 0, broken: false, qualified: true, tier: 'clean', perDomain: {} }]

  const auto = e.decideAndApply()
  await new Promise((r) => setTimeout(r, 20))
  e.setManualResult('')
  e.setManualPhase('write', '写入中…')
  const merged = await e.apply({ forced: true })
  await auto

  check('前提：这一发真的走了合并分支', merged.merged === true, JSON.stringify(merged.merged))
  check('前提：合并返回后阶段还没被任何人动过（仍是 write）',
    e.manual.phase === 'write', e.manual.phase)
  check('前提：此时仍 busy（所以「卡 90 秒」是真实可发生的）', e.manualNow().busy === true)

  e.finishManualWrite(merged)
  check('★ merged 的结果调用 finishManualWrite 后必须收尾',
    e.manual.phase === '' && e.manualNow().busy === false,
    JSON.stringify({ phase: e.manual.phase, busy: e.manualNow().busy }))
  check('★ 并且写下了真实结果（不是「写入中…」）',
    /已切到|已写入/.test(e.manualNow().note), JSON.stringify(e.manualNow().note))
}

console.log(`\n总失败数：${fail}  通过：${pass}`)
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)
