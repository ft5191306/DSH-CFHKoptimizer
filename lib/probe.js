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
/** 淘汰阈值：p95 触到惩罚值 = 至少 5% 请求硬超时 = 时断时续，不能进 hosts。 */
export const P95_REJECT_MS = PENALTY_MS
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
 * 写 hosts 前的安全闸门：用**真实证书链 + 主机名**校验连一次。
 *
 * 判定标准就是「TLS 握手能完成」。HTTP 状态码不参与判定：
 * API 子域（amr-link.open-design.ai）根路径返回 404 是正常行为，
 * 据此认为该 IP 不可信会误杀掉所有可用候选。
 *
 * @param {string} ip
 * @param {string} domain
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
export async function certOk(ip, domain, options = {}) {
  const timeoutMs = options.timeoutMs ?? 8_000
  try {
    const head = await httpsRead(ip, domain, timeoutMs, '/', domain, 512, true)
    const status = /^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1]
    return { ok: true, message: `证书校验通过 · HTTP ${status ?? '?'}` }
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
 * 手工 TLS + HTTP/1.1 读取，供 trace 与证书闸门共用。
 *
 * @param {string} ip
 * @param {string} domain
 * @param {number} timeoutMs
 * @param {string} requestPath
 * @param {string} hostHeader
 * @param {number} maxBytes
 * @param {boolean} [verify]
 * @returns {Promise<string>}
 */
function httpsRead(ip, domain, timeoutMs, requestPath, hostHeader, maxBytes, verify = false) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: ip,
      port: 443,
      servername: domain,
      rejectUnauthorized: verify,
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
