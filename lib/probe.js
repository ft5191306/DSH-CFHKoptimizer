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
 * **`connRetries` 参与分档（2026-11-04 加，修审计发现的高危问题）**：
 *
 * 每次采样的连接层失败会重试一次（见 `probeDomain` 的 `retryLinkOnce`），
 * 于是样本级丢包率 ≈ p²（p = 单次尝试失败率）。后果是：
 *
 *   单次失败率 p = 27% 时，样本级 loss 只有约 7.3%，刚好卡在
 *   `FLAKY_LOSS_PCT=7.5` 的判定线下 → `isBroken()` 判「通」。
 *
 * 极端反例（审计用假 transport 构造并实测）：**首连 100% 失败、靠重试才能连上**
 * 的线路，旧口径给出 `loss=0, timeouts=0, tier=clean, broken=false` —— 会被
 * 写进 hosts，而用户侧（undici/浏览器）没有这层重试，每次新建连接都要吃满超时。
 *
 * 修法：**只要这一轮出现过连接层重试，最高只能到 `ok`，永不给 `clean`。**
 * 不给 `degraded` 是因为重试确实救回来了、1/3 的失败率也够不上「断」的阈值；
 * 但「完美」这个词必须留给一次都没卡过的线路。
 *
 * 注意：`clean` 参与 `sortCandidates` 里「同属可用」的比较（clean 与 ok 现在
 * 按 p50 排，见该函数注释），所以这条修正不会再把快线路压死；它的作用是
 * **让界面/快照如实说出「这条线靠重试活着」**，而不是靠档位改变名次。
 *
 * @param {{ loss?: number, timeouts?: number, samples?: number, n?: number, connRetries?: number } | null} reading
 * @returns {'clean' | 'ok' | 'degraded'}
 */
export function tierOf(reading) {
  if (reading === null || typeof reading !== 'object') return TIER.degraded
  if (isBroken(reading)) return TIER.degraded
  const timeouts = typeof reading.timeouts === 'number' ? reading.timeouts : null
  const loss = typeof reading.loss === 'number' ? reading.loss : null
  const retries = typeof reading.connRetries === 'number' ? reading.connRetries : 0
  // 只要重试过，就不是「一次都没卡过」——绝不谎称 clean。
  if (retries > 0) return TIER.ok
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
 * 候选排序：**先保安全，再比速度**。
 *
 * 规则：
 *   1. `degraded`（判为「断」）永远垫底 —— 这是唯一严格的安全闸门，
 *      不能为了快 400ms 去选一条真在丢包的线。
 *   2. `clean` 与 `ok` 之间**按 p50 排**，不按档位。
 *   3. 同 p50 才比 p95（p95 只做 tiebreak，绝不进判定）。
 *
 * 为什么 `clean`/`ok` 不再档位优先（2026-11-04 改，来自扩充 SJC 候选池后的实测冲突）：
 *
 * 旧实现在 clean 与 ok 之间也是严格字典序，于是 **一次超时就能把一条快 200–450ms
 * 的线永久压到一条慢线后面**。这在只有 HKG 候选时几乎无害（HKG 之间 p90 极差
 * 只有 195ms，档位与速度大体同向）；但加入 SJC 段后它变成了**结构性问题**：
 *
 *   SJC 有 5–40% 的 SYN 挂死（按 IP 分化，实测 104.17.140.1 达 20–35%，
 *   而 104.17.128.1 仅 0–5%），一个 20s 窗口里几乎必然撞上 1 次超时 →
 *   `tier=ok`（loss 2.9%，远低于 7.5% 的「断」阈值）。
 *   而 HKG 的 162.159.138.1 实测多轮 0 挂死 → 稳定 `clean`。
 *
 * 结果：插件会把 hosts 从 SJC 改回 HKG，即使 HKG 慢 200–450ms。
 * 2026-11-04 线上实测复现：`CF-RAY: ...-HKG`，而同期 SJC 候选 p50 494ms
 * 对 HKG 700–900ms。这不是「选更稳的线」，是**拿 450ms 去换 1 次超时**。
 *
 * 为什么把安全边界划在 `degraded` 而不是 `ok`：
 * `ok` 的定义就是「有零星超时，但仍在 isBroken 的容忍范围内，可用」
 * （见 TIER 的注释）。既然按定义可用，那么两条可用线路之间该由速度决定；
 * 拿「1 次超时 vs 0 次超时」去压 450ms，是把噪声当成了可靠性。
 * 真正需要一票否决的是 `degraded`（loss ≥ 7.5% 或 timeouts ≥ 3）。
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
    // 1. 只有 degraded 是严格的：它代表「真在丢包」，绝不能被速度翻盘。
    const leftDead = tierOf(left) === TIER.degraded ? 1 : 0
    const rightDead = tierOf(right) === TIER.degraded ? 1 : 0
    if (leftDead !== rightDead) return leftDead - rightDead
    // 2. 都可用（clean/ok）→ 比速度。丢包只做 tiebreak：
    //    同为可用线路时，1% 与 3% 的差别不值得换掉几百毫秒。
    if (left.p50 !== right.p50) return left.p50 - right.p50
    if (left.loss !== right.loss) return left.loss - right.loss
    return left.p95 - right.p95
  })
}
/** 近端机房。远端不是「慢一点」，是差一个数量级。 */
export const NEAR_COLOS = new Set(['HKG', 'NRT', 'KIX', 'ICN', 'SIN', 'TPE', 'BKK', 'MNL', 'SGN'])
/**
 * 「可接受机房」= 近端机房 ∪ 回源落点。
 *
 * 为什么不能直接把 SJC 塞进 `NEAR_COLOS`（2026-11-03 修）：
 *
 * 这个名字的语义是「离用户近」。SJC 恰恰**不是**——它比 HKG 远（TCP p50 170ms vs 200ms，
 * 冷请求还更慢一点）。它胜出的原因完全不同：`amr-link` 的**回源在美西**，实测
 * `Server-Timing: cfOrigin;dur=232/241`，边缘 HKG 自己只花 7–9ms。边缘挂 HKG 意味着
 * CF 必须把请求从香港再送回美西源站，白绕一个跨太平洋往返。
 *
 * 实测（2026-11-03，交织 60 vs 60 请求）：
 *   keep-alive 每请求 p50 —— SJC 277ms / HKG 475ms（−42%）
 *   冷请求 p50           —— SJC 596/634ms / HKG 879/894ms（−35%）
 *
 * 所以判定候选该看两个**独立**的问题：
 *   1. 它在不在「延迟不会差一个数量级」的机房里？（`ACCEPTABLE_COLOS`）
 *   2. 远端机房（LAX 等）无论多快都不补位。
 *
 * 把 SJC 并进 `NEAR_COLOS` 会让「近端」这个词撒谎，也会让后来的人以为
 * SJC 与 HKG 的取舍是延迟问题——而它是**拓扑**问题（回源在哪里）。
 * 两者必须分开命名。
 */
export const ACCEPTABLE_COLOS = new Set([...NEAR_COLOS, 'SJC'])
/**
 * 粗筛候选池：`[网段前缀, /24 步长, 起始第三段, 终止第三段(开区间)]`。
 *
 * 2026-11-03 加入 `104.17.128-159`（**步长 1，32 个全取**）：
 * 实测扫遍 24 个 CF /16 共 768 个地址后，**SJC 只出现在这一段**，
 * 其他 23 个 /16 一个 SJC 都没有。原池（162.159/16 + 104.26/16）里没有这个段，
 * 所以插件从结构上永远测不到 SJC。
 *
 * 为什么整段 32 个全取、而不是隔一个取（步长 2 会只取 16 个）：
 * 三轮独立探测确认 **128-159 段内 32/32 全部是 SJC，边界干净**
 * （`104.17.127.1` 与 `104.17.160.1` 三轮全是 LAX，段内没有任何一个返回 LAX）。
 * 这段本来就是一座 SJC 边缘的完整 /27，逐个取等于把这一楼的可用出口全拿到手；
 * 隔一个取等于自己扔掉一半候选，而粗筛的成本只是每地址一次 TCP 握手。
 *
 * 为什么是 128 而不是 `104.17.0.0`：`104.17.0-127` 逐段实测全是 LAX，
 * 加进来只是让粗筛白跑 128 次。
 *
 * **2026-11-06 收窄（288 → 56）**：把 162.159/16 + 104.26/16 共 256 个候选
 * 逐个实测 colo 后发现，真正能用的只有 24 个 HKG：
 *   - `162.159.128-158` 偶数 /24（16 个）：稳定 HKG，从未见过其它 colo；
 *   - `104.26.0-14` 偶数 /24（8 个）：HKG，且 `.6/.8/.14` 实测曾在 NRT 窗口翻过去。
 * 其余 232 个全是浪费，逐段归属已查清：
 *   - `162.159.0-126` 偶数 64 个：45 个 LAX + 19 个不可达；
 *   - `162.159.160-254` 偶数 48 个：45 个不可达 + FRA(.160)/AMS-DOG(.204)/DEN(.224)；
 *   - `104.26.16-254` 偶数 120 个：TCP 443 三次全 SYN 超时（不是别的机房，是根本不服务），
 *     `104.26.16.1` 起就不可达，对照 `.0.1` 3/3 通。
 * 所以两段都只保留实测为 HKG 的区间，池子 288 → 56（16 + 8 + 32），粗筛 TCP 探测少 80%。
 *
 * 注意池子只取每个 /24 的 `.1`，且只取偶数第三段——香港楼其实是
 * `162.159.128-159` 全 32 个 /24 与 `104.26.0-15` 全 16 个（奇数段实测也是 HKG），
 * 这里刻意不取，是为了把粗筛成本压在最小；要扩大香港出口覆盖时把 step 改 1 即可，
 * 但必须排除 `162.159.143.1`（该主机位实测 403 `error code: 1034`，同 /24 其它主机位正常）。
 */
export const PRIORITY_RANGES = /** @type {const} */ ([
  ['162.159.128.0', 2, 128, 160],
  ['104.26.0.0', 2, 0, 16],
  ['104.17.128.0', 1, 128, 160],
])
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
 * 构造粗筛候选：每段按 `[起始第三段, 终止第三段)` 隔 `step` 个第三段取 1，主机位固定 `.1`。
 *
 * 现在 56 个：162.159.128-158 偶数 ×16 + 104.26.0-14 偶数 ×8 + 104.17.128-159 ×32。
 *
 * @returns {string[]} 按数值升序
 */
export function buildCandidates() {
  /** @type {string[]} */
  const out = []
  for (const [base, step, from, to] of PRIORITY_RANGES) {
    const [a, b] = base.split('.').map(Number)
    for (let third = from; third < to; third += step) out.push(`${a}.${b}.${third}.1`)
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
 * **连接层失败重试一次（2026-11-03 加）**：见 `retryLinkOnce` 的注释。
 *
 * @param {string} ip
 * @param {string} domain
 * @param {{ windowMs?: number, intervalMs?: number, timeoutMs?: number, transport?: Function, retryLinkOnce?: boolean }} [options]
 * @returns {Promise<{ domain: string, colo: string | null, n: number, p50: number | null, p95: number, loss: number, timeouts: number, connRetries: number }>}
 */
export async function probeDomain(ip, domain, options = {}) {
  const windowMs = options.windowMs ?? WINDOW_MS
  const intervalMs = options.intervalMs ?? INTERVAL_MS
  const timeoutMs = options.timeoutMs ?? DOMAIN_TIMEOUT_MS
  /**
   * 传输层注入口，默认就是真的 httpsFirstByte。
   *
   * 为什么留这个口：边缘拒绝（403 / error code 1034）这条判定在
   * `probeDomain` 内部，而它是「受限 IP 会被当成又快又健康」这个缺陷的
   * 发生地。只测 `inspectEdgeResponse` 这个纯函数证明不了调用真的接上了
   * ——把调用删掉，纯函数断言照样全绿。留出注入口，测试才能不联网地
   * 真正跑一遍这条分支。
   */
  const transport = options.transport ?? httpsFirstByte
  const retryLinkOnce = options.retryLinkOnce ?? true

  /** @type {number[]} */
  const samples = []
  let timeouts = 0
  /** 连接层失败过、但重试救回来的次数。 */
  let connRetries = 0
  /** @type {string | null} */
  let colo = null
  /** 这个 IP 是否被边缘拒绝服务（403 / error code: 10xx）。 */
  let edgeRefused = false
  /** @type {string} */
  let edgeNote = ''
  const deadline = performance.now() + windowMs

  while (performance.now() < deadline) {
    const started = performance.now()
    try {
      let head
      try {
        head = await transport(ip, domain, timeoutMs)
      } catch (first) {
        /**
         * 连接层失败 → 重试一次，而不是直接记 999。
         *
         * 为什么要改（2026-11-03 实测）：SJC 候选有 5–20% 的 SYN 挂死
         * （SYN 发出去 12s 无任何响应，且**不是**速率触发的——同 180s 窗口
         * 内 2/s 通道 6.7%、0.25/s 通道 7.3%，两者几乎相同）。
         *
         * 但同一批实测里有个决定性事实：**挂死后立刻重试同一个 IP，
         * 7 次挂死 7 次成功（100%）**。而且 40 轮 ×4 个 IP 的交织探测里，
         * 挂死从不同时落在两个 IP 上（0/7）。说明它是**单次 SYN 的瞬时丢弃**，
         * 不是链路稳定丢包。
         *
         * 旧口径把这种瞬时事件按 `PENALTY_MS`（999）计入 loss，于是
         * SJC 的 loss 被算成 12–27%，越过 `FLAKY_LOSS_PCT`(7.5) →
         * `isBroken()=true` → `degraded`，被 clean 的 HKG 稳压一头。
         * 而 DSH 实际用 undici `fetch()` 复用连接，keep-alive 下实测
         * **0/70 失败**——插件在测一个用户碰不到的场景，并据此否决了
         * 用户真正该走的路（SJC 每请求快 42%，见 ACCEPTABLE_COLOS）。
         *
         * 所以：重试一次。仍然失败才算真的丢包（那时 loss 如实计入）。
         * 计时**包含**这次失败尝试——用户如果真遇到，等的就是这个时间，
         * 把它藏掉会让 p95 撒谎。
         *
         * 注意只在「连接层」失败时重试。`transport` 抛出的错误里，证书类
         * 与边缘拒绝都不该重试：前者重试一百次也是同一个结果，后者是
         * `probeDomain` 在 try 内部自己判的（走 edgeRefused 分支，不抛）。
         */
        if (!retryLinkOnce) throw first
        head = await transport(ip, domain, timeoutMs)
        connRetries += 1
      }
      // 关键修复：403 / `error code: 1034` 这类「边缘拒绝服务」的响应体极小、
      // 回得比正常响应还快。以前它会被当成一个**又健康又快的样本**记进去，
      // 于是受限 IP 在 p50 排序里排到最前，最后被写进 hosts，用户的 API
      // 请求随即 403（看起来像密钥失效）。这里必须把它判成不可用。
      const edge = inspectEdgeResponse(head)
      if (edge.refused) {
        edgeRefused = true
        edgeNote = edge.note
        timeouts += 1
        samples.push(PENALTY_MS)
        // 已经证明这个 IP 对本域名不可用，再采下去只是浪费窗口。
        break
      }
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
    return { domain, colo, n: 0, p50: null, p95: PENALTY_MS, loss: 100, timeouts: 0, edgeRefused, edgeNote, connRetries }
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
    edgeRefused,
    edgeNote,
    connRetries,
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
 * Cloudflare「边缘拒绝服务」的响应特征（HTTP 403 + `error code: 10xx`）。
 *
 * 为什么必须单独识别：`162.159.0.0/16` 与 `104.26.0.0/16` 里并不是每个地址都在
 * 为这个 zone 服务。实测 256 个候选里有 14 个返回 `403 error code: 1034`
 * （Edge IP Restricted）——**TLS 握手完全正常、证书也匹配**，只是这个边缘
 * 拒绝为该 zone 提供服务。
 *
 * 这类地址有两个致命性质：
 *   1. 证书闸门（只做 TLS 握手）**必然放行**它，因为它本来就是合法边缘；
 *   2. 403 响应体极小、回得比正常响应还快，于是 `probeDomain` 量到的 TTFB
 *      反而**更低**，在按 p50 排序时容易排到最前。
 *
 * 两者叠加的结果：插件会把用户钉到这种 IP 上，用户的 API 请求随即收到 403。
 * 界面拿不到 Cloudflare 的边缘错误原文，看起来就像「密钥失效」——但这是
 * IP 不可用，跟密钥毫无关系（同一把密钥打正常 IP 是 200）。
 *
 * 判据只认两个**结构化事实**，不靠猜：
 *   - HTTP 状态行不是 2xx/3xx（`error code: 1034` 的 403 正文没有 HTML）；
 *   - 或者正文里出现 `error code: 10xx`（Cloudflare 被拦截时的纯文本响应）。
 *
 * 注意 `error code: 1034` 的正文里**没有**英文 "Forbidden" 之类的字样，
 * 只有一行 `error code: 1034`，所以不能靠关键词猜，必须解析状态行。
 *
 * 这里不锚定行首：`/cdn-cgi/trace` 的健康正文只含 `colo=`、`tls=`、`http=`
 * 这类字段，绝不会出现 `error code:`，所以不会误杀健康候选。
 *
 * @type {RegExp}
 */
export const EDGE_REFUSED_PATTERN = /error code:\s*\d{4}\b/i

/**
 * 从一个 HTTPS 响应里解析状态码。拿不到状态行时返回 null。
 *
 * @param {string} head 响应头部（latin1 解码）
 * @returns {number | null}
 */
export function statusOfHead(head) {
  const match = /^HTTP\/1\.[01]\s+(\d{3})/.exec(String(head ?? ''))
  return match ? Number(match[1]) : null
}

/**
 * 这个响应是不是「边缘拒绝服务」——即这个 IP 对本 zone 不可用。
 *
 * 既认 Cloudflare 的 `error code: 10xx` 纯文本，也认任何非 2xx/3xx 状态：
 * 候选是为 API 子域服务的边缘，它对这个域名的合法响应绝不会是 4xx/5xx。
 *
 * **注意边界**：`probeDomain` 用的是 `/cdn-cgi/trace`，合法响应必然是
 * `colo=…` 的纯文本 200。所以这里对 4xx 一律判死，不会误杀健康候选。
 *
 * @param {string} head
 * @returns {{ refused: boolean, status: number | null, note: string }}
 */
export function inspectEdgeResponse(head) {
  const text = String(head ?? '')
  const status = statusOfHead(text)
  const body = text.slice(Math.max(0, text.indexOf('\r\n\r\n') + 4))
  if (EDGE_REFUSED_PATTERN.test(text) || EDGE_REFUSED_PATTERN.test(body)) {
    const match = /error code:\s*(\d{4})/i.exec(text) ?? /error code:\s*(\d{4})/i.exec(body)
    return { refused: true, status, note: `error code: ${match?.[1] ?? '?'}` }
  }
  if (status !== null && status >= 400) {
    return { refused: true, status, note: `HTTP ${status}` }
  }
  return { refused: false, status, note: '' }
}

/**
 * `certOk` 只在这条前缀上说明「证书真的被拒」；`ok === false` 本身不算。
 *
 * 这个前缀是 `certOk` 自己在证书类错误码上拼的（见下面的 catch 分支），
 * 所以它是一份**契约**，不是靠猜错误文本。
 */
export const CERT_REJECTED_PATTERN = /证书校验失败/

/** 闸门结论：通过 / 真证书问题 / 临时链路问题 / 边缘拒绝服务 / 不认识。 */
export const CERT_VERDICT = /** @type {const} */ ({
  ok: 'ok',
  cert: 'cert',
  link: 'link',
  edge: 'edge',
  unknown: 'unknown',
})

/**
 * `certOk` 在这条前缀上说明「这个边缘拒绝为该 zone 服务」。
 *
 * 与证书失败**必须分开**：证书失败是「这个 IP 不认这个域名」，边缘拒绝是
 * 「它是合法的 Cloudflare 边缘，但不为这个 zone 服务」。两者都要剔除，
 * 但文案不同——前者会让人去查证书，后者要让人知道是 IP 不可用。
 */
export const EDGE_REFUSED_MESSAGE = /边缘拒绝服务/

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
  // 边缘拒绝必须先判：它的文案里也可能带上状态码，不能让 link 规则先吃掉。
  if (EDGE_REFUSED_MESSAGE.test(message)) return CERT_VERDICT.edge
  if (CERT_REJECTED_PATTERN.test(message)) return CERT_VERDICT.cert
  if (LINK_FAILURE_PATTERN.test(message)) return CERT_VERDICT.link
  return CERT_VERDICT.unknown
}

/**
 * 写 hosts 前的安全闸门：用**真实证书链 + 主机名**校验连一次，
 * 并确认这个边缘**真的在为该 zone 服务**。
 *
 * 判定标准是两件事同时成立：
 *   1. TLS 握手能完成（证书链 + servername altname，rejectUnauthorized 默认 true）；
 *   2. 该边缘对这个域名返回的不是「拒绝服务」（403 / `error code: 10xx`）。
 *
 * 为什么第 2 条必须加（2026-11-02 实测）：只做握手时，`error code: 1034`
 * （Edge IP Restricted）的地址**必然通过**——它本来就是合法 Cloudflare 边缘，
 * TLS 和证书都正常，只是拒绝为这个 zone 提供服务。实测 256 个候选里有 14 个
 * 是这种地址。插件把它们写进 hosts 之后，用户的 API 请求直接 403；界面拿不到
 * Cloudflare 的边缘错误原文，看起来就像「密钥失效」。
 *
 * 这一条不是「拿 HTTP 状态码当证书判据」——那件事以前做过，而且确实会误杀
 * （见下面的历史注释）。区别在于**路径**：这里探的是 `/cdn-cgi/trace`，
 * 合法响应必然是纯文本 `colo=…` 的 200，任何 4xx/5xx 都只可能来自边缘拒绝。
 * 以前误杀的成因是拿根路径 `GET /` 当探针，而根路径在这条链路上经常不回包。
 *
 * @param {string} ip
 * @param {string} domain
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
export async function certOk(ip, domain, options = {}) {
  const timeoutMs = options.timeoutMs ?? 8_000
  let detail
  try {
    detail = await tlsHandshake(ip, domain, timeoutMs)
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

  // 第 2 条：握手已经通过，再确认这个边缘真的在为该域名服务。
  // 探测失败（超时/重置）不当作拒绝——那属于 link，由调用方重试一次。
  let head = ''
  try {
    head = await httpsRead(ip, domain, timeoutMs, '/cdn-cgi/trace', domain, 4_096)
  } catch (error) {
    return { ok: false, message: String(/** @type {any} */ (error)?.message ?? error).slice(0, 80) }
  }
  const edge = inspectEdgeResponse(head)
  if (edge.refused) {
    return { ok: false, message: `边缘拒绝服务: ${edge.note}（${domain}）` }
  }
  return { ok: true, message: `证书校验通过 · ${detail}` }
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
