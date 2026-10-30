/**
 * 测量原语：与 cf_pin.py 同一套口径。
 *
 * 这里的每个常量都是实测校准出来的，不是估计值；改动前请先看 cf_pin.py 的注释：
 *
 *   20s 硬窗口       —— 约 40 个样本，p95 才真正代表「1/20 的偶发卡顿」
 *   超时记 999       —— 不丢弃。丢弃会让「10 次卡 1 次」的 IP 看起来完美
 *   单次 HTTPS 1.5s  —— 完整请求正常约 500ms，用 TCP 的 0.3s 会把健康请求误判成超时
 *   TCP 只做粗筛     —— SYN 的 min() 是幸运值，不能排序、更不能判死
 *
 * @module @local/dsh-cf-pin/lib/probe
 */

import net from 'node:net'
import tls from 'node:tls'

/** 超时样本计入的固定惩罚值，参与 p50 / p95 计算。 */
export const PENALTY_MS = 999
/** 每个「IP × 地址」组合的采样窗口，硬上限。不开放配置。 */
export const WINDOW_MS = 20_000
/** 两次探测之间的最小间隔（实际节奏受 RTT 约束）。 */
export const INTERVAL_MS = 50
/** 单次完整 HTTPS 的耐心。 */
export const DOMAIN_TIMEOUT_MS = 1_500
/** 单次 TCP 握手的耐心：超过就当 SYN 丢了，不再干等。 */
export const TCP_TIMEOUT_MS = 300
/** 粗筛单次超时。 */
export const SCAN_TCP_TIMEOUT_MS = 1_000
/**
 * 旧口径的淘汰阈值，**保留只为与 cf_pin.py 的口径对齐和历史测试**。
 *
 * 它把「慢」和「断」混成了同一个数：p95 触到 999 既可能是 5% 硬超时，
 * 也可能是一次都没超时、只是每次都慢到 1 秒以上（DOMAIN_TIMEOUT_MS 是 1500，
 * 成功样本本来就可以 > 999）。坏网络下后者是常态，用它淘汰会把整条链路
 * 判成「全劣化」，然后一条都不写。判定请改用 isBroken()。
 */
export const P95_REJECT_MS = PENALTY_MS

/**
 * 「断」的判据：丢包率。与「慢」分开——慢是相对的，断才是绝对的。
 *
 * n=40（20s 窗口的典型样本数）时 7.5% 恰好是 3 次超时，与旧口径
 * 「3 个超时才淘汰」等价；但零超时、只是慢的 IP 不再被误杀。
 */
export const FLAKY_LOSS_PCT = 7.5

/**
 * 这个读数是不是「时断时续」——即真的在丢包，而不是单纯慢。
 *
 * 两个条件任一成立就算断：
 *   - 超时次数 ≥ 3（小样本窗口下也成立，避免 2 个样本里 1 个超时被漏掉）
 *   - 丢包率 ≥ FLAKY_LOSS_PCT
 *
 * 注意：这里**不看** p95 的绝对值。一个每次都要 1.1s、但零丢包的 IP
 * 是「慢」，不是「断」；该不该换成它由相对 p50 的阈值决定。
 *
 * @param {{ loss?: number, timeouts?: number, samples?: number }} reading
 * @returns {boolean}
 */
export function isBroken(reading) {
  if (reading === null || typeof reading !== 'object') return true
  if (typeof reading.timeouts === 'number' && Number.isFinite(reading.timeouts) && reading.timeouts >= 3) return true
  if (typeof reading.loss === 'number' && Number.isFinite(reading.loss) && reading.loss >= FLAKY_LOSS_PCT) return true
  return false
}

/**
 * 候选的三级分档。**级联降级靠它，不靠 p95 的数值。**
 *
 * 为什么不能用 p95 分档：超时样本记 `PENALTY_MS`（999），但**成功样本也可以 >999**
 * ——一次请求慢到 1 秒以上照样是成功的。于是「p95 >= 999」既可能是真的丢了 5% 请求，
 * 也可能一次没丢、只是慢。实测过：某个 IP `p95 = 1401ms` 而 `loss = 0%`。
 * 拿 p95 当「是否超时」的判据，会把「慢但健康」的线路打成「断」——这正是
 * 「慢 = 断」这个回归的形状。
 *
 * 所以分档只看两个可区分的量：`timeouts`（真的超时了几次）与 `loss`（丢包率）。
 *
 *   clean    —— 一个超时都没有，且零丢包。级联的最优档。
 *   ok       —— 有零星超时/丢包，但仍在 isBroken 的容忍范围内。可用。
 *   degraded —— 判为「断」。只在没有前两档时才轮到它。
 */
export const TIER = /** @type {const} */ ({
  clean: 'clean',
  ok: 'ok',
  degraded: 'degraded',
})

/** 档位优劣：数字越小越好。排序与比较都用它。 */
export const TIER_RANK = /** @type {const} */ ({
  clean: 0,
  ok: 1,
  degraded: 2,
})

/**
 * 给一个候选读数分档。
 *
 * @param {{ loss?: number, timeouts?: number, samples?: number, n?: number } | null} reading
 * @returns {'clean' | 'ok' | 'degraded'}
 */
export function tierOf(reading) {
  if (reading === null || typeof reading !== 'object') return TIER.degraded
  if (isBroken(reading)) return TIER.degraded
  const timeouts = typeof reading.timeouts === 'number' ? reading.timeouts : null
  const loss = typeof reading.loss === 'number' ? reading.loss : null
  // 没有超时计数就退一档：宁可当成「有零星丢包」，也不谎称完美。
  if (timeouts === 0 && loss === 0) return TIER.clean
  return TIER.ok
}

/**
 * 这个读数是不是「一个成功样本都没有」——即整条线路全超时。
 *
 * 级联的最后一档（重新粗筛）就靠它触发。注意判据是
 * `timeouts >= samples`，**不是**看 p50/p95 的数值。
 *
 * @param {{ timeouts?: number, samples?: number, n?: number } | null} reading
 * @returns {boolean}
 */
export function isAllTimeouts(reading) {
  if (reading === null || typeof reading !== 'object') return false
  const samples = typeof reading.samples === 'number' ? reading.samples : reading.n
  const timeouts = reading.timeouts
  if (typeof samples !== 'number' || typeof timeouts !== 'number') return false
  return samples > 0 && timeouts >= samples
}

/**
 * 候选排序：先按档位（clean → ok → degraded），同一档内按 p50，
 * p50 相同再按 p95。**p95 只做 tiebreak，绝不进判定**。
 *
 * 为什么 p95 不能当主键：实测同一批候选连跑 4 个 6s 窗口，
 * p50 的跨窗口极差平均 **7ms**，p95 是 **220ms**（32 倍）。
 * 用一个波动 32 倍的量去排一个波动 7ms 的量，名次基本是抛硬币。
 *
 * 返回新数组，不改动入参。
 *
 * @template {{ p50: number, p95: number, loss: number, timeouts: number }} T
 * @param {readonly T[]} list
 * @returns {T[]}
 */
export function sortCandidates(list) {
  return [...list].sort((left, right) => {
    const byTier = TIER_RANK[tierOf(left)] - TIER_RANK[tierOf(right)]
    if (byTier !== 0) return byTier
    // 同一档内：丢包少的优先（只有 ok/degraded 档会不同），再按 p50，最后 p95。
    if (left.loss !== right.loss) return left.loss - right.loss
    if (left.p50 !== right.p50) return left.p50 - right.p50
    return left.p95 - right.p95
  })
}
/** 近端机房。远端不是「慢一点」，是差一个数量级。 */
export const NEAR_COLOS = new Set(['HKG', 'NRT', 'KIX', 'ICN', 'SIN', 'TPE', 'BKK', 'MNL', 'SGN'])
/** 粗筛候选池：两段各隔 2 个 /24 取 1，合计 256 个。 */
export const PRIORITY_RANGES = /** @type {const} */ ([['162.159.0.0', 2], ['104.26.0.0', 2]])
/** 探测机房用的 SNI/Host。 */
export const SNI_FALLBACK = 'cloudflare.com'

/**
 * 线性插值百分位，与 numpy 默认口径（method='linear'）一致。
 *
 * 输入必须已升序排序。这里刻意不用 nearest-rank：n=40 时它会在
 * k=2 就判淘汰，而这份口径要到 k=3，边界差整整一个样本。
 *
 * @param {readonly number[]} sorted
 * @param {number} q
 * @returns {number}
 */
export function percentile(sorted, q) {
  if (sorted.length === 0) return Number.NaN
  if (sorted.length === 1) return sorted[0]
  const pos = (sorted.length - 1) * q
  const lo = Math.trunc(pos)
  const hi = Math.min(lo + 1, sorted.length - 1)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

/** 与 Python `round(x, 1)` 等价的保留一位小数（银行家舍入的一半场景由 toFixed 兜住）。 */
function round1(value) {
  return Math.round(value * 10) / 10
}

/**
 * 构造粗筛候选：162.159/16 与 104.26/16，各隔 2 个 /24 取 1，主机位固定 .1。
 *
 * @returns {string[]} 256 个，按数值升序
 */
export function buildCandidates() {
  /** @type {string[]} */
  const out = []
  for (const [base] of PRIORITY_RANGES) {
    const [a, b] = base.split('.').map(Number)
    for (let third = 0; third < 256; third += 2) out.push(`${a}.${b}.${third}.1`)
  }
  const key = (ip) => ip.split('.').reduce((acc, part) => acc * 256 + Number(part), 0)
  return out.sort((left, right) => key(left) - key(right))
}

/**
 * TCP 握手 RTT：多次尝试取最小值，并给出失败率。
 *
 * 只用于「存活粗筛 + 决定先测谁」。**绝不用于排名或淘汰**：
 * 实测 8 个 IP 的 TCP 全在 78~103ms（跨度在噪声内），而 HTTPS p50 是 257~385ms，
 * TCP 第一名在 HTTPS 排第四。
 *
 * @param {string} ip
 * @param {{ tries?: number, timeoutMs?: number }} [options]
 * @returns {Promise<{ rtt: number | null, loss: number }>}
 */
export async function tcpRtt(ip, options = {}) {
  const tries = options.tries ?? 3
  const timeoutMs = options.timeoutMs ?? 1_200
  /** @type {number[]} */
  const times = []
  let fail = 0
  for (let i = 0; i < tries; i++) {
    const started = performance.now()
    try {
      await tcpConnect(ip, 443, timeoutMs)
      times.push(performance.now() - started)
    } catch {
      fail += 1
    }
  }
  if (times.length === 0) return { rtt: null, loss: 100 }
  return { rtt: Math.min(...times), loss: (100 * fail) / tries }
}

/**
 * 一次 TCP 连接，成功即关闭。
 *
 * @param {string} ip
 * @param {number} port
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
function tcpConnect(ip, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: ip, port })
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (error) reject(error)
      else resolve()
    }
    const timer = setTimeout(() => finish(new Error('tcp timeout')), timeoutMs)
    socket.once('connect', () => finish())
    socket.once('error', (error) => finish(error))
  })
}

/**
 * 对一个「IP × 地址」做完整 HTTPS 采样，返回 p50 / p95 / loss。
 *
 * 语义要点（都与 cf_pin.domain_p95 对齐）：
 *   - 窗口是**墙钟**硬上限，到点立刻收工，绝不为了多采几个样本而超时占用
 *   - 超时不丢弃，按 999ms 计入统计——那一次卡顿正是用户实际会感知到的
 *   - 计时覆盖 connect + TLS + send + 首字节，不读完整个响应
 *   - 不做证书校验（只为测速，写 hosts 前的安全判定是另一件事）
 *
 * 与 Python 的差异只有一处：样本在「收到首块数据」时结束，而不是在 socket
 * 析构之后。Python 的 close() 是同步 syscall，Node 的 destroy() 要等下一次
 * 事件循环，把销毁等待算进延迟会凭空多出一次往返。
 *
 * @param {string} ip
 * @param {string} domain
 * @param {{ windowMs?: number, intervalMs?: number, timeoutMs?: number }} [options]
 * @returns {Promise<{ domain: string, colo: string | null, n: number, p50: number | null, p95: number, loss: number, timeouts: number }>}
 */
export async function probeDomain(ip, domain, options = {}) {
  const windowMs = options.windowMs ?? WINDOW_MS
  const intervalMs = options.intervalMs ?? INTERVAL_MS
  const timeoutMs = options.timeoutMs ?? DOMAIN_TIMEOUT_MS

  /** @type {number[]} */
  const samples = []
  let timeouts = 0
  /** @type {string | null} */
  let colo = null
  const deadline = performance.now() + windowMs

  while (performance.now() < deadline) {
    const started = performance.now()
    try {
      const head = await httpsFirstByte(ip, domain, timeoutMs)
      samples.push(performance.now() - started)
      if (colo === null) {
        const match = /^colo=(\S+)$/m.exec(head)
        if (match) colo = match[1]
      }
    } catch {
      timeouts += 1
      samples.push(PENALTY_MS)
    }

    const rest = intervalMs - (performance.now() - started)
    if (rest > 0 && performance.now() + rest < deadline) await delay(rest)
  }

  if (samples.length === 0) {
    return { domain, colo, n: 0, p50: null, p95: PENALTY_MS, loss: 100, timeouts: 0 }
  }
  samples.sort((left, right) => left - right)
  return {
    domain,
    colo,
    n: samples.length,
    p50: round1(percentile(samples, 0.5)),
    p95: round1(percentile(samples, 0.95)),
    loss: round1((100 * timeouts) / samples.length),
    timeouts,
  }
}

/**
 * 完整 HTTPS 请求到首字节，返回头部文本（用于解析 colo）。
 *
 * 手工拼 HTTP/1.1 而不是用 fetch/http.request：
 *   - fetch 会协商 h2，测的就不是同一个协议了
 *   - http.request 会加 Accept / keep-alive，还可能复用 socket
 * 服务端看到的字节不同，TTFB 就不可比。
 *
 * @param {string} ip
 * @param {string} domain
 * @param {number} timeoutMs
 * @returns {Promise<string>}
 */
function httpsFirstByte(ip, domain, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: ip,
      port: 443,
      servername: domain,
      rejectUnauthorized: false,
      // 不声明 ALPN：Python 侧不声明，服务端就用 HTTP/1.1
    })
    let settled = false
    let received = false
    const finish = (error, head) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (error) reject(error)
      else resolve(head ?? '')
    }
    const timer = setTimeout(() => finish(new Error('https timeout')), timeoutMs)

    socket.once('secureConnect', () => {
      socket.write(
        `GET /cdn-cgi/trace HTTP/1.1\r\nHost: ${domain}\r\n` +
        'User-Agent: cf-pin\r\nConnection: close\r\n\r\n',
      )
    })
    socket.on('data', (chunk) => {
      if (received) return
      received = true
      // 首块数据到达即停，不读完整个响应：这里量的是 TTFB
      finish(null, chunk.toString('latin1'))
    })
    socket.once('end', () => {
      // 连上但一个字节都没有：按超时记账，不是「成功但很慢」
      if (!received) finish(new Error('empty response'))
    })
    socket.once('error', (error) => finish(error))
  })
}

/**
 * 读候选的落地机房。走 `cloudflare.com` 的 trace 端点。
 *
 * @param {string} ip
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ colo: string | null, totalMs: number | null, error?: string }>}
 */
export async function tlsTrace(ip, options = {}) {
  const timeoutMs = options.timeoutMs ?? 6_000
  const started = performance.now()
  try {
    const head = await httpsRead(ip, SNI_FALLBACK, timeoutMs, '/cdn-cgi/trace', SNI_FALLBACK, 8_192)
    const totalMs = performance.now() - started
    /** @type {Record<string, string>} */
    const info = {}
    for (const match of head.matchAll(/^([a-z_]+)=(\S+)$/gm)) info[match[1]] = match[2]
    return { colo: info.colo ?? null, totalMs: round1(totalMs) }
  } catch (error) {
    return { colo: null, totalMs: null, error: String(/** @type {any} */ (error)?.message ?? error).slice(0, 70) }
  }
}

/**
 * 链路类错误：本机此刻连不上 / 连上又被掐断 / 握手超时。
 *
 * 与 `_tools/net-check.mjs` 里的同名判据一致，但**生产代码不再自己复制一份**
 * ——以前它只活在测试工具里，于是 `runApply` 把「网络超时」和「证书不匹配」
 * 当成同一件事，都是硬否决。结果是网络越差、闸门越容易超时、写入越被挡住。
 *
 * @type {RegExp}
 */
export const LINK_FAILURE_PATTERN =
  /timeout|timed out|ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE|ETIMEDOUT|EHOSTUNREACH|EHOSTDOWN|ENETUNREACH|ENETDOWN|ENETRESET|ENOTFOUND|EAI_AGAIN|ERR_SOCKET_CLOSED|ERR_STREAM_PREMATURE_CLOSE|premature close|socket hang up|empty response|EPROTO|handshake fai|unrecognized name/i

/**
 * `certOk` 只在这条前缀上说明「证书真的被拒」；`ok === false` 本身不算。
 *
 * 这个前缀是 `certOk` 自己在证书类错误码上拼的（见下面的 catch 分支），
 * 所以它是一份**契约**，不是靠猜错误文本。
 */
export const CERT_REJECTED_PATTERN = /证书校验失败/

/** 闸门结论：通过 / 真证书问题 / 临时链路问题 / 不认识。 */
export const CERT_VERDICT = /** @type {const} */ ({
  ok: 'ok',
  cert: 'cert',
  link: 'link',
  unknown: 'unknown',
})

/**
 * 把一次闸门结论分成四类。
 *
 * 为什么要分：`certOk` 的 `ok === false` 有两种完全不同的成因，
 * 处置也相反——
 *   - **真证书问题**（hostname 不匹配、链不可信）：这个 IP 对该域名就是不可用，
 *     应当剔除，并在本次运行的剩余时间里避开它。
 *   - **临时链路问题**（超时、ECONNRESET、空响应）：它什么都没证明。网络抖动
 *     不是「证书不行」的证据，拿它否决写入等于让烂网络把自己锁死。
 *
 * @param {{ ok?: boolean, message?: string } | null} verdict
 * @returns {'ok' | 'cert' | 'link' | 'unknown'}
 */
export function classifyCertVerdict(verdict) {
  if (verdict?.ok === true) return CERT_VERDICT.ok
  const message = String(verdict?.message ?? '')
  if (CERT_REJECTED_PATTERN.test(message)) return CERT_VERDICT.cert
  if (LINK_FAILURE_PATTERN.test(message)) return CERT_VERDICT.link
  return CERT_VERDICT.unknown
}

/**
 * 写 hosts 前的安全闸门：用**真实证书链 + 主机名**校验连一次。
 *
 * 判定标准就是「TLS 握手能完成」。HTTP 状态码不参与判定：
 * API 子域（amr-link.open-design.ai）根路径返回 404 是正常行为，
 * 据此认为该 IP 不可信会误杀掉所有可用候选。
 *
 * **实现必须真的只做握手。** 早先的实现是「发一个 GET / 并等响应」，
 * 于是闸门除了证书还隐含依赖了「HTTP 响应会回来」——这与上面的契约矛盾，
 * 而且实测会误杀：amr-link.open-design.ai 的 GET / 在这条链路上经常
 * 几十毫秒不回包（同一 IP 换 /v1/models 或 /cdn-cgi/trace 就有响应），
 * 结果健康 IP 被随机判成「证书校验失败」。宿主自己的 baseURL 就挂在这个
 * 子域上，所以这个误杀会直接表现成「换线总是失败」。
 *
 * 现在：连上、等 secureConnect（Node 在这之前已经完成证书链 + servername
 * 的 altname 校验，rejectUnauthorized 默认 true），成功即通过，随后立刻断开。
 * 不写请求、不等响应，耗时从「最多 8s」降到「一次握手」。
 *
 * @param {string} ip
 * @param {string} domain
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
export async function certOk(ip, domain, options = {}) {
  const timeoutMs = options.timeoutMs ?? 8_000
  try {
    const detail = await tlsHandshake(ip, domain, timeoutMs)
    return { ok: true, message: `证书校验通过 · ${detail}` }
  } catch (error) {
    const anyError = /** @type {any} */ (error)
    const code = String(anyError?.code ?? '')
    const text = String(anyError?.message ?? error).slice(0, 80)
    if (code.startsWith('ERR_TLS_CERT') || code === 'CERT_HAS_EXPIRED' ||
        code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
        code === 'SELF_SIGNED_CERT_IN_CHAIN' || code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
      return { ok: false, message: `证书校验失败: ${text.slice(0, 60)}` }
    }
    return { ok: false, message: text }
  }
}

/**
 * 只做 TLS 握手，成功返回一行摘要（协议版本 + 证书到期日）。
 *
 * 证书链与主机名由 Node 在 secureConnect 之前校验完；这里不额外信任任何东西。
 *
 * @param {string} ip
 * @param {string} domain
 * @param {number} timeoutMs
 * @returns {Promise<string>}
 */
function tlsHandshake(ip, domain, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: ip,
      port: 443,
      servername: domain,
      rejectUnauthorized: true,
    })
    let settled = false
    const finish = (error, detail) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (error) reject(error)
      else resolve(detail ?? '')
    }
    const timer = setTimeout(() => finish(new Error('tls timeout')), timeoutMs)
    socket.once('secureConnect', () => {
      let detail = socket.getProtocol() ?? 'tls'
      const cert = socket.getPeerCertificate()
      if (cert && cert.valid_to) detail += ' · 至 ' + new Date(cert.valid_to).toISOString().slice(0, 10)
      finish(null, detail)
    })
    socket.once('error', (error) => finish(error))
  })
}

/**
 * 手工 TLS + HTTP/1.1 读取，供 trace 使用（读 `colo` 要响应正文）。
 *
 * 注意：证书闸门**不再**走这里。它只需要握手，不需要响应——见 certOk 的注释。
 * 所以 `verify` 参数已经去掉了：这里永远不校验证书（纯测速/读字段用途）。
 *
 * @param {string} ip
 * @param {string} domain
 * @param {number} timeoutMs
 * @param {string} requestPath
 * @param {string} hostHeader
 * @param {number} maxBytes
 * @returns {Promise<string>}
 */
function httpsRead(ip, domain, timeoutMs, requestPath, hostHeader, maxBytes) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: ip,
      port: 443,
      servername: domain,
      rejectUnauthorized: false,
    })
    let settled = false
    /** @type {Buffer[]} */
    const chunks = []
    let size = 0
    const finish = (error, body) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (error) reject(error)
      else resolve(body ?? '')
    }
    const timer = setTimeout(() => finish(new Error('tls timeout')), timeoutMs)

    socket.once('secureConnect', () => {
      socket.write(
        `GET ${requestPath} HTTP/1.1\r\nHost: ${hostHeader}\r\n` +
        'User-Agent: cf-pin\r\nConnection: close\r\n\r\n',
      )
    })
    socket.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      chunks.push(buffer)
      size += buffer.length
      if (size >= maxBytes) finish(null, Buffer.concat(chunks).toString('latin1'))
    })
    socket.once('end', () => {
      // 空响应在证书闸门里算通过（握手已经成功），在 trace 里由调用方判空
      finish(null, Buffer.concat(chunks).toString('latin1'))
    })
    socket.once('error', (error) => finish(error))
  })
}

/** @param {number} ms */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 限制并发的遍历。结果顺序与输入一致——排序稳定性依赖这一点。
 *
 * @template T, R
 * @param {readonly T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} task
 * @returns {Promise<R[]>}
 */
export async function mapLimit(items, limit, task) {
  /** @type {R[]} */
  const results = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      results[index] = await task(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}
