/**
 * 真实网络自测：测量口径 + 证书闸门。
 *
 * 为什么必须有这个脚本：
 *   regression-check.mjs 是**离线**的——它注入假的证书闸门，只验证「闸门通过时
 *   写什么、不通过时不写什么」这套决策逻辑。那套测试再绿，也回答不了一个问题：
 *   **真的证书闸门，到底会不会把坏 IP 放过去？**
 *
 *   而证书闸门是整个插件唯一的写前安全边界。用假闸门测它，等于没测。
 *   测量口径（probeDomain / tcpRtt / 百分位）同理：它们是插件存在的理由，
 *   离线测不了。
 *
 * 分层约定：
 *   regression-check.mjs  不联网、可随便跑、进 CI
 *   net-check.mjs         **真实发连接**，要手动跑，网络不通时如实报 SKIP 而不是 FAIL
 *
 * 失败语义（退出码）——「跳过」必须与「全过」可区分：
 *   0  全部通过
 *   1  有真实失败：被测代码不符合契约（网络烂不算）
 *   2  没有失败，但有用例被跳过（链路不通 / 慢到无法区分），覆盖不完整，不能当全绿
 *   链路错误（timeout / ECONNRESET / ECONNREFUSED / ETIMEDOUT / …）一律 SKIP；
 *   只有「连上了但证书被拒」和口径/不变式被破坏才是 FAIL。
 *
 * 用法：
 *   node _tools\net-check.mjs          # 全部
 *   node _tools\net-check.mjs --math   # 只跑纯函数口径（不联网），退出码保持 0/1
 *
 * 连接量：固定 12 次握手（TCP 基线 2 + 粗筛 4 + 证书 5 + 机房 1），
 * 外加 3s 采样窗口里每次探测 1 次连接（节奏 50ms，最多约 60 次）。
 * 正常十几秒；链路烂时单次握手最长会等 8s，最坏一分钟量级。
 */

import {
  buildCandidates,
  certOk,
  FLAKY_LOSS_PCT,
  isBroken,
  PENALTY_MS,
  percentile,
  P95_REJECT_MS,
  probeDomain,
  tcpRtt,
  tlsTrace,
} from '../lib/probe.js'
import { BEGIN_MARK, END_MARK, readHosts } from '../lib/hosts.js'

const MATH_ONLY = process.argv.includes('--math')

let pass = 0
let fail = 0
let skip = 0
const check = (label, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + label) }
  else { fail++; console.log('  FAIL ' + label + (extra ? '  -> ' + extra : '')) }
}
const skipped = (label, why) => { skip++; console.log('  SKIP ' + label + '  (' + why + ')') }

// 0 = 全过；1 = 有真实失败；2 = 没失败但有跳过（覆盖不完整）。
// 旧版只有 0/1，于是「基线不通 -> 全 SKIP」也会 exit 0，和真的全过不可区分。
const finish = () => {
  console.log(`\n失败数：${fail}  通过：${pass}  跳过：${skip}`)
  if (fail > 0) { console.log('退出码 1：有真实失败'); process.exit(1) }
  if (skip > 0) { console.log('退出码 2：没有失败，但有用例被跳过（覆盖不完整，不能当全绿）'); process.exit(2) }
  console.log('退出码 0：全部通过')
  process.exit(0)
}

// ===========================================================================
// 判据（纯函数；--math 用构造读数验证它们真的可证伪）
// ===========================================================================

/**
 * 链路类错误：本机此刻连不上 / 连上又被掐断 / 握手超时。
 * 这些是环境，不是被测代码的 bug——一律 SKIP。
 *
 * 旧判据只认小写 `timeout`（`/timeout/.test(message)`），于是 ECONNRESET /
 * ECONNREFUSED / ETIMEDOUT（大写）/ EHOSTUNREACH / socket hang up 全落到 FAIL（假红）。
 */
const LINK_FAILURE =
  /timeout|timed out|ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENETDOWN|ENOTFOUND|EAI_AGAIN|socket hang up|empty response|EPROTO|handshake fai|unrecognized name/i
const linkError = (message) => LINK_FAILURE.test(String(message ?? ''))

/** certOk 只在这条前缀上说明「证书校验真的拦下了它」；ok===false 本身不算。 */
const CERT_REJECTED = /证书校验失败/

/**
 * 正例结局分类：
 *   ok      闸门放行了健康 IP/域名——符合契约
 *   cert    连上了但证书被拒——真 FAIL（真闸门误杀健康 IP，换线会随机失败）
 *   skip    链路错误（超时 / ECONNRESET / …）——闸门没被触发，是环境问题
 *   unknown 不认识的错误——旧版 GET / 超时误杀就是这种形状，值得人看
 */
function judgePositive(result) {
  if (result?.ok) return 'ok'
  if (CERT_REJECTED.test(String(result?.message ?? ''))) return 'cert'
  if (linkError(result?.message)) return 'skip'
  return 'unknown'
}

/**
 * probeDomain 读数分类（纯函数）：
 *   offline 一次真实响应都没有——链路不通，只能 SKIP，绝不能算「口径通过」
 *   flaky   有响应但 isBroken()：链路时断时续，读数可用但代表不了健康链路
 *   ok      采到可用链路
 */
function judgeProbe(reading) {
  if (!reading || typeof reading !== 'object') return 'offline'
  if (!Number.isFinite(reading.n) || reading.n <= 0) return 'offline'
  const timeouts = Number.isFinite(reading.timeouts) ? reading.timeouts : 0
  if (reading.n - timeouts <= 0) return 'offline'
  return isBroken(reading) ? 'flaky' : 'ok'
}

/**
 * probeDomain 读数的 6 条不变式。
 *
 * 抽成纯函数是为了让 --math 能用坏读数证明它们**会红**：旧版这 6 条在
 * 「100% 超时」下全过，因为超时样本被 push(PENALTY_MS)，于是 n>0 / p50>0 /
 * p95>=p50 / loss 在区间 / timeouts<=n 对全超时读数天然成立，最后一条
 * 「loss 与 timeouts 自洽」又是拿返回值重算返回值。
 *
 * 注意：不变式只证明读数自洽，不证明链路可用。全超时由 judgeProbe() 归到
 * offline，整段 SKIP——只打印 6 个 ok 会重演假绿。
 *
 * @param {{ n: number, p50: number | null, p95: number, loss: number, timeouts: number }} r
 * @returns {Array<[string, boolean, string]>}
 */
function probeInvariants(r) {
  return [
    ['采样条数 n > 0', Number.isFinite(r.n) && r.n > 0, String(r.n)],
    ['p50 是有限正数', Number.isFinite(r.p50) && r.p50 > 0, String(r.p50)],
    ['p95 >= p50', Number.isFinite(r.p95) && r.p95 >= r.p50, `p95=${r.p95} p50=${r.p50}`],
    ['loss ∈ [0,100]', Number.isFinite(r.loss) && r.loss >= 0 && r.loss <= 100, String(r.loss)],
    ['timeouts <= n', Number.isFinite(r.timeouts) && r.timeouts <= r.n, `${r.timeouts}/${r.n}`],
    // 交叉校验，替换旧版那条同公式自证：loss=100 意味着每个样本都是惩罚值，
    // 分位数就必须正好是 PENALTY_MS。loss<100 时该式天然成立，所以不会误红。
    ['loss=100 ⇒ p50/p95 都是惩罚值',
      r.loss !== 100 || (r.p50 === PENALTY_MS && r.p95 === PENALTY_MS),
      `p50=${r.p50} p95=${r.p95}`],
  ]
}

// ===========================================================================
// 第一部分：纯函数口径（不联网）
// ===========================================================================

console.log('\n[口径] 百分位 —— 必须与 numpy method=\'linear\' 一致')
{
  // Python: numpy.percentile([1,2,3,4], 50) == 2.5
  check('[1,2,3,4] p50 = 2.5', percentile([1, 2, 3, 4], 0.5) === 2.5, String(percentile([1, 2, 3, 4], 0.5)))
  // numpy.percentile([1,2,3,4], 95) == 3.85
  check('[1,2,3,4] p95 = 3.85', Math.abs(percentile([1, 2, 3, 4], 0.95) - 3.85) < 1e-9, String(percentile([1, 2, 3, 4], 0.95)))
  check('单元素 p95 = 自身', percentile([10], 0.95) === 10, String(percentile([10], 0.95)))
  check('[1,2] p50 = 1.5', percentile([1, 2], 0.5) === 1.5)
  check('空数组 = NaN', Number.isNaN(percentile([], 0.5)))
  // 升序不变性：把中位数拉大，p50 必须跟着变
  check('p50 对分布敏感', percentile([1, 2, 100], 0.5) === 2, String(percentile([1, 2, 100], 0.5)))
}

console.log('\n[口径] 淘汰边界 —— README 承诺「n=40 时要 3 个超时才淘汰」')
{
  // 40 个样本，其中 k 个是惩罚值 999。线性插值下 p95 触到 999 需要 3 个超时。
  const make = (k) => {
    const normal = Array.from({ length: 40 - k }, (_, i) => 200 + i)
    const timeouts = Array.from({ length: k }, () => PENALTY_MS)
    return [...normal, ...timeouts].sort((a, b) => a - b)
  }
  check('2 个超时 -> p95 < 999（不淘汰）', percentile(make(2), 0.95) < P95_REJECT_MS, String(percentile(make(2), 0.95)))
  check('3 个超时 -> p95 == 999（淘汰）', percentile(make(3), 0.95) === P95_REJECT_MS, String(percentile(make(3), 0.95)))
  check('P95_REJECT_MS 就是 PENALTY_MS', P95_REJECT_MS === PENALTY_MS)
}

console.log('\n[口径] isBroken —— 「断」只看丢包/超时，不看慢')
{
  check('FLAKY_LOSS_PCT = 7.5', FLAKY_LOSS_PCT === 7.5, String(FLAKY_LOSS_PCT))
  // 零丢包、但每次都慢到 1s 以上：这是「慢」，不是「断」。旧 p95=999 口径会误杀它。
  check('零丢包慢样本不算断', isBroken({ loss: 0, timeouts: 0 }) === false)
  check('3/40 超时算断', isBroken({ loss: 7.5, timeouts: 3 }) === true)
  check('2/40 超时不算断', isBroken({ loss: 5, timeouts: 2 }) === false)
  // 边界含等号：7.5 算断，7.4 不算（否则 n=40 时「3 个超时才淘汰」的承诺会漂移）
  check('loss = 7.5 算断（边界含等号）', isBroken({ loss: FLAKY_LOSS_PCT, timeouts: 2 }) === true)
  check('loss = 7.4 不算断', isBroken({ loss: FLAKY_LOSS_PCT - 0.1, timeouts: 2 }) === false)
}

console.log('\n[口径] 候选池构造')
{
  const pool = buildCandidates()
  check('共 256 个', pool.length === 256, String(pool.length))
  check('无重复', new Set(pool).size === 256, String(new Set(pool).size))
  check('全部落在 162.159/16 或 104.26/16', pool.every((ip) => /^(162\.159|104\.26)\.\d+\.1$/.test(ip)))
  check('按数值升序', pool.every((ip, i) => i === 0 || key(pool[i - 1]) < key(ip)))
  check('隔 2 个 /24 取 1（第三段全偶）', pool.every((ip) => Number(ip.split('.')[2]) % 2 === 0))
}
function key(ip) { return ip.split('.').reduce((a, p) => a * 256 + Number(p), 0) }

console.log('\n[口径] probeDomain 读数判据 —— 全超时不得算「通过」')
{
  const allTimeout = { n: 2, p50: PENALTY_MS, p95: PENALTY_MS, loss: 100, timeouts: 2 }
  const healthy = { n: 40, p50: 280, p95: 420, loss: 0, timeouts: 0 }
  // 旧版 6 条断言对全超时读数全过（n>0、p50=999>0、p95>=p50、loss 在区间、
  // timeouts<=n、loss 与 timeouts 同公式自洽），链路断掉时脚本照样全绿。
  check('100% 超时 -> offline（只能 SKIP，不能算通过）', judgeProbe(allTimeout) === 'offline', judgeProbe(allTimeout))
  check('n=0 -> offline（没采到样本同样不能算通过）', judgeProbe({ n: 0, p50: null, p95: PENALTY_MS, loss: 100, timeouts: 0 }) === 'offline')
  check('健康读数 -> ok', judgeProbe(healthy) === 'ok', judgeProbe(healthy))
  check('零丢包慢读数 -> ok（慢不等于断）', judgeProbe({ n: 40, p50: 1_100, p95: 1_400, loss: 0, timeouts: 0 }) === 'ok')
  check('部分超时 -> flaky', judgeProbe({ n: 40, p50: 900, p95: 999, loss: 10, timeouts: 4 }) === 'flaky')
  // 6 条不变式必须可证伪，否则和旧版一样是恒真。
  check('坏读数（p95 < p50）会让不变式变红',
    probeInvariants({ n: 6, p50: 400, p95: 399, loss: 0, timeouts: 0 }).some(([, ok]) => !ok))
  check('坏读数（loss=100 但 p50 不是惩罚值）会让不变式变红',
    probeInvariants({ n: 6, p50: 400, p95: PENALTY_MS, loss: 100, timeouts: 6 }).some(([, ok]) => !ok))
  check('健康读数 6 条不变式全过',
    probeInvariants(healthy).every(([, ok]) => ok),
    JSON.stringify(probeInvariants(healthy).filter(([, ok]) => !ok)))
}

console.log('\n[口径] 链路错误分类 —— 假红都出在漏判这里')
{
  const linkMessages = [
    'tls timeout',
    'connect ECONNREFUSED 127.0.0.1:443',
    'read ECONNRESET',
    'connect ETIMEDOUT 162.159.128.1:443',
    'connect EHOSTUNREACH 162.159.128.1:443',
    'getaddrinfo ENOTFOUND amr-link.open-design.ai',
    'socket hang up',
    'empty response',
  ]
  for (const message of linkMessages) check(`「${message}」判为链路问题`, linkError(message))
  // 证书拒绝不是链路问题：它是真闸门生效的证据，不能被 SKIP 吞掉。
  check('「证书校验失败: …」不算链路问题', !linkError('证书校验失败: Hostname/IP does not match certificate\'s altnames'))
  // 正例结局分类：链路错误 -> SKIP；证书被拒 -> 真 FAIL；不认识 -> 真 FAIL。
  check('正例超时 -> SKIP（旧版假红）', judgePositive({ ok: false, message: 'tls timeout' }) === 'skip')
  check('正例 ECONNRESET -> SKIP（旧版假红）', judgePositive({ ok: false, message: 'read ECONNRESET' }) === 'skip')
  check('正例证书被拒 -> FAIL（真闸门误杀）', judgePositive({ ok: false, message: '证书校验失败: Hostname/IP does not match' }) === 'cert')
  check('正例未分类错误 -> FAIL', judgePositive({ ok: false, message: 'boom' }) === 'unknown')
}

if (MATH_ONLY) {
  console.log(`\n(--math) 跳过联网部分。失败数：${fail}  通过：${pass}`)
  process.exit(fail === 0 ? 0 : 1)
}

// ===========================================================================
// 第二部分：真实网络
// ===========================================================================

console.log('\n[网络] 取一个真实的测试目标')
// 关键：IP 与域名必须**成对**取自 hosts 的标记段。
// Cloudflare anycast IP 是按 SNI 路由的，随便拼一个 IP + 另一个域名可能根本不通
// （实测 162.159.150.1 + cloudflare.com 握手超时，同 IP + amr-link.open-design.ai 却秒过）。
// 那种组合连不上是正常的，不是 bug——拿它当正例只会制造假红。
let targetIp = null
let targetDomain = 'amr-link.open-design.ai'
const pairs = []
try {
  const text = readHosts()
  let inside = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    // 标记段起止从 lib/hosts.js 取，别硬编码——改一个字节两边就不再匹配。
    if (line === BEGIN_MARK) { inside = true; continue }
    if (line === END_MARK) { inside = false; continue }
    if (!inside || !line || line.startsWith('#')) continue
    const [ip, domain] = line.split(/\s+/)
    if (ip && domain) pairs.push([ip, domain])
  }
} catch { /* hosts 读不到就用下面的默认 */ }
// 优先用插件真正服务的那个域名（宿主 baseURL 就在它上面）
pairs.sort((a, b) => (a[1].includes('amr-link') ? -1 : 0) - (b[1].includes('amr-link') ? -1 : 0))
if (pairs.length > 0) [targetIp, targetDomain] = pairs[0]
if (targetIp === null) targetIp = '162.159.146.1'
console.log(`  目标：${targetIp} / ${targetDomain}${pairs.length > 1 ? `（hosts 里共 ${pairs.length} 对，取首对）` : ''}`)

console.log('\n[网络] 先确认基线通不通，不通就如实 SKIP 而不是 FAIL')
let online = false
{
  const r = await tcpRtt(targetIp, { tries: 2, timeoutMs: 1_500 })
  online = r.rtt !== null
  if (online) check(`TCP 能连上 ${targetIp}`, r.rtt > 0, String(r.rtt))
  else skipped('TCP 基线', '连不上目标 IP，本机当前不通')
}

if (!online) {
  // 基线不通时，剩下的用例不是「通过」，也不是「失败」，而是没跑——逐段记 SKIP，
  // 让最后的退出码变成 2。旧版在这里 exit(0)，拔掉网线也能伪装成绿色。
  for (const label of [
    'TCP 粗筛',
    '证书闸门（正例 / 反例 / 握手耗时）',
    'probeDomain 采样',
    'tlsTrace 读机房',
  ]) skipped(label, '基线 TCP 不通，本机此刻没有网络')
  console.log('\n网络不通：联网用例全部跳过。这不是测试失败，是覆盖不完整。')
  finish()
}

console.log('\n[网络] TCP 粗筛：只判存活，量级应是几十~几百 ms')
{
  const r = await tcpRtt(targetIp, { tries: 3, timeoutMs: 1_000 })
  check('tries=3 时 loss ∈ {0, 33.3, 66.7, 100}', [0, 33.3, 66.7, 100].some((v) => Math.abs((r.loss ?? -1) - v) < 0.2), String(r.loss))
  // 旧标签写的是「rtt 是 min() 口径」——这里根本证明不了 min，只能证明读数在超时上限内。
  check('rtt 要么 null，要么在单次超时上限内（< 2s）', r.rtt === null || (r.rtt > 0 && r.rtt < 2_000), String(r.rtt))
  if (r.rtt === null) skipped('TCP 粗筛量级（几十~几百 ms）', 'tries=3 全部丢包，此刻测不出量级')
  // 本机 443 一般没开：这是唯一能确定性构造的「连不上」样本。
  // 若本机真有服务在听，负例不成立——SKIP。旧版用 `|| dead.rtt !== null` 让任意
  // 非 null 都恒过，127.0.0.1:443 有服务时就会假装测过了。
  const dead = await tcpRtt('127.0.0.1', { tries: 1, timeoutMs: 300 })
  if (dead.rtt !== null) skipped('连不上时 rtt=null 且 loss=100', '本机 127.0.0.1:443 有服务在监听，这个负例构造不出来')
  else check('连不上时 rtt=null 且 loss=100', dead.rtt === null && dead.loss === 100, JSON.stringify(dead))
}

console.log('\n[网络] 证书闸门 —— 这是唯一真正的写前安全边界')
{
  // 1) 正例：真实 IP + 匹配域名。必须能完成 TLS 握手且被证书校验放行。
  const good = await certOk(targetIp, targetDomain, { timeoutMs: 8_000 })
  const outcome = judgePositive(good)
  if (outcome === 'ok') {
    check('正例：真实 IP + 匹配域名 -> 通过', true, good.message)
    // 闸门的判据是「TLS 握手能完成」，HTTP 状态码不参与。
    // amr-link 的 GET / 经常压根不回包（实测），所以闸门**不允许**等响应——
    // 这条用例就是在钉住这一点：正例必须在没有任何 HTTP 交互的情况下通过。
    check('正例只做握手、不等 HTTP 响应', !/HTTP/.test(good.message), good.message)
    check('正例报出 TLS 协议与证书到期日', /TLSv1\.[23]/.test(good.message), good.message)
  } else if (outcome === 'skip') {
    // 纯网络错误（超时 / ECONNRESET / ECONNREFUSED / socket hang up …）：
    // 闸门根本没被触发，既不能判它通过，也不能判它失败——如实 SKIP。
    skipped('正例握手', `${targetIp} + ${targetDomain} 此刻握手不通（链路问题，非闸门问题）：${good.message}`)
    skipped('正例只做握手、不等 HTTP 响应', '同上')
    skipped('正例报出 TLS 协议与证书到期日', '同上')
  } else {
    // cert：连上了但证书被拒，真闸门误杀健康 IP（这是本次审计抓过的病根）。
    // unknown：没分类到的错误——旧版 GET / 超时误杀当时就是这种形状，值得人看。
    check('正例：真实 IP + 匹配域名 -> 通过', false,
      (outcome === 'cert' ? '证书校验误杀：' : '未分类错误：') + good.message)
    skipped('正例只做握手、不等 HTTP 响应', '正例未通过，这两条无从验证')
    skipped('正例报出 TLS 协议与证书到期日', '同上')
  }

  // 2) 反例：只断言 ok===false 是假绿——烂网络连不上同样是 false。
  //    必须看到 certOk 报「证书校验失败」才算闸门真的拦下了它；纯网络错误只能 SKIP。
  //    （1.1.1.1 有证书但绝不是 amr-link 的；8.8.8.8 压根不是 CF 边缘。
  //    本机实测这两个地址的 443 都连不上——此时如实 SKIP，不能假装验过。
  //    再补一个本机实测可达、证书绝不可能覆盖 amr-link 的公共 DoH 端点，
  //    让「反例真的被证书拦下」这条路径在当前网络下也有真覆盖，而不是整段 SKIP。）
  const negatives = [
    ['反例：主机名不匹配', await certOk('1.1.1.1', 'amr-link.open-design.ai')],
    ['反例：非 CF IP', await certOk('8.8.8.8', 'amr-link.open-design.ai')],
    // 223.5.5.5 的证书是给 dns.alidns.com 的，SNI 换成 amr-link 必然 altname 不匹配。
    ['反例：证书不覆盖该域名的公网端点', await certOk('223.5.5.5', 'amr-link.open-design.ai')],
  ]
  for (const [label, result] of negatives) {
    if (result.ok) check(label + ' -> 拦下', false, '闸门放行了：' + result.message)
    else if (CERT_REJECTED.test(result.message)) check(label + ' -> 被证书拦下', true)
    else skipped(label + ' -> 被证书拦下',
      (linkError(result.message) ? '链路问题，闸门未被触发：' : '不是证书拒绝：') + result.message)
  }

  // 3) 关键回归：amr-link 的 GET / 会超时，但证书是好的。
  //    旧实现（发 GET / 等响应）会把它判成失败，从而随机误杀所有候选。
  const started = performance.now()
  const slowPath = await certOk(targetIp, 'amr-link.open-design.ai')
  const elapsed = performance.now() - started
  if (slowPath.ok) {
    check('amr-link 域名握手通过（曾被 GET / 超时误杀）', true)
    // 3s 是「只做一次握手」的上界：旧实现要等满 8s。只有真测到 <3s 才能证明这一点；
    // 慢链路上握手本身就可能超过 3s，此时无法区分，如实 SKIP 而不是制造假红。
    if (elapsed < 3_000) check('握手耗时 < 3s（不再等 8s 超时）', true, Math.round(elapsed) + 'ms')
    else skipped('握手耗时 < 3s（不再等 8s 超时）',
      `本次 ${Math.round(elapsed)}ms：慢链路上无法区分「等超时」和「握手本来就慢」`)
  } else if (CERT_REJECTED.test(slowPath.message)) {
    check('amr-link 域名握手通过（曾被 GET / 超时误杀）', false, slowPath.message)
  } else {
    skipped('amr-link 域名握手', '此刻不通：' + slowPath.message)
  }
}

console.log('\n[网络] probeDomain 真实采样（3s 窗口，缩短以加快自测）')
{
  const r = await probeDomain(targetIp, targetDomain, { windowMs: 3_000, intervalMs: 50, timeoutMs: 1_500 })
  const verdict = judgeProbe(r)
  console.log(`   实测 p50=${r.p50}ms p95=${r.p95}ms n=${r.n} loss=${r.loss}% timeouts=${r.timeouts}`)
  if (verdict === 'offline') {
    // 一次真实响应都没有：6 条不变式在数值上仍然自洽（这正是旧版全绿的原因），
    // 但它们证明不了「链路可用」。全超时是环境，只能 SKIP，一条 ok 都不打。
    skipped('probeDomain 采样口径', `窗口内 ${r.n} 次全部超时（loss=${r.loss}%），链路不通，测不出采样口径`)
  } else {
    for (const [label, ok, extra] of probeInvariants(r)) check(label, ok, extra)
    if (verdict === 'flaky') {
      skipped('probeDomain 采样（健康链路）',
        `loss=${r.loss}% timeouts=${r.timeouts}/${r.n}：链路时断时续，读数可用但代表不了健康链路`)
    }
  }
}

console.log('\n[网络] tlsTrace 读机房')
{
  const t = await tlsTrace(targetIp, { timeoutMs: 8_000 })
  if (t.colo === null) skipped('读到 colo', 'trace 未完成或解析失败：' + (t.error ?? 'unknown'))
  else {
    check('colo 是 3 位大写机房码', /^[A-Z]{3}$/.test(t.colo), t.colo)
    check('totalMs 是有限数', Number.isFinite(t.totalMs) && t.totalMs > 0, String(t.totalMs))
    console.log(`   colo=${t.colo} totalMs=${t.totalMs}`)
  }
}

finish()
