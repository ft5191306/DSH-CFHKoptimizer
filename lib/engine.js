/**
 * 探测与判定的引擎。
 *
 * 这一层只做三件事：维持两条节奏（当前 IP 快probe、候选轮慢probe）、
 * 按 cf_pin 的口径统计、在劣化时按设计好的规则决定写不写。
 * 它不认识 HTTP，也不认识界面；对外只有一个 snapshot() 和几个动作方法。
 *
 * 两条节奏为什么必须分开：
 *   当前 IP 每 6 秒一次，取**最新一次**值（无滚动窗口）——它要能立刻反映
 *   用户此刻的感受。
 *   候选轮 150 秒一轮，覆盖 12 个候选——它要能排出一个可信的名次。
 *   两者新鲜度差 25 倍，所以任何「当前 vs 候选」的展示都必须带上时间。
 *
 * @module @local/dsh-cf-pin/lib/engine
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import {
  certOk,
  buildCandidates,
  mapLimit,
  NEAR_COLOS,
  PENALTY_MS,
  P95_REJECT_MS,
  probeDomain,
  tcpRtt,
  tlsTrace,
} from './probe.js'
import { composeHosts, currentPin, flushDns, readHosts, writeHosts } from './hosts.js'
import { isAdmin } from './admin.js'

/** 采样槽位：20s 采样 + 5s 余量。不开放配置。 */
export const SLOT_MS = 25_000
/** 候选轮里参与实测的候选数。 */
export const CANDIDATE_COUNT = 12
/** 一轮候选数，写 hosts 时最多取 2 个。 */
export const MAX_WRITE_IPS = 2

/** 状态码。客户端据此选文案，不要靠猜。 */
export const STATE = /** @type {const} */ ({
  coldStart: 'cold-start',
  normal: 'normal',
  switched: 'switched',
  observing: 'observing',
  /** 差距够了，但用户关掉了自动切换。与 observing（差距不够）不是一件事。 */
  autoOff: 'auto-off',
  waitingWrite: 'waiting-write',
  noCandidate: 'no-candidate',
  allDegraded: 'all-degraded',
  offline: 'offline',
  probeFailed: 'probe-failed',
  dailyLimit: 'daily-limit',
  needAdmin: 'need-admin',
})

/**
 * 默认配置。与设计文档逐项对应。
 * @returns {import('./types.js').PinConfig}
 */
export function defaultConfig() {
  return {
    // 以下每一项都按用户 2026-10-28 的截图定稿：
    //   自动切换 开 / 每日 48 次 / 阈值 150ms / 回复中也探测 开
    //   并发 2 / 采样 6 秒 / 只勾选 amr-link.open-design.ai
    autoWrite: true,
    currentProbeMs: 6_000,
    candidateConcurrency: 2,
    // 推导值，不从输入取；这里只是让默认对象形状完整。
    roundIntervalMin: minRoundIntervalMin(2),
    switchThresholdMs: 150,
    maxSwitchesPerDay: 48,
    probeWhileThinking: true,
    // 默认同心环：插件装完第一眼就是它。三格点阵已删除，fan 不再是合法值。
    skin: 'ring',
    addresses: defaultAddresses(),
  }
}

/**
 * 探测地址：每项带启用勾选，启用项才参与探测 / cert_ok / 写入。
 *
 * 默认只开 amr-link 一条（用户截图定的）。另两条仍列出、但默认不勾选——
 * 勾选错地址会让所有状态看起来像「没测到」，所以默认只留确实要用的那条。
 *
 * @returns {import('./types.js').ProbeAddress[]}
 */
export function defaultAddresses() {
  return [
    { address: 'open-design.ai', enabled: false },
    { address: 'www.open-design.ai', enabled: false },
    { address: 'amr-link.open-design.ai', enabled: true },
  ]
}

/**
 * 一轮候选实测要多久 —— 由并发推导，是派生读数而不是配置项。
 *
 * 12 个候选 ÷ 并发，向上取整，每组占一个 25s 槽位。
 *
 * @param {number} concurrency
 * @returns {number} 毫秒
 */
export function roundDurationMs(concurrency) {
  const groups = Math.ceil(CANDIDATE_COUNT / Math.max(1, concurrency))
  return groups * SLOT_MS
}

/**
 * 候选轮间隔。**不是配置项，是推导值**。
 *
 * 规则（用户 2026-10-28 定）：只由并发数决定，采样间隔不参与。
 *
 *   并发 2 → ceil(12/2)=6 组 × 25s = 150s → 3 分钟
 *   并发 4 → 3 组 × 25s = 75s → 2 分钟
 *
 * 用户只需要调并发，间隔自己跟着变——设置页里它是只读的。
 *
 * @param {number} concurrency
 * @returns {number} 分钟
 */
export function minRoundIntervalMin(concurrency) {
  return Math.ceil(roundDurationMs(concurrency) / 60_000)
}

/**
 * 引擎。
 */
export class Engine {
  /**
   * @param {{ dataDir: string, config: import('./types.js').PinConfig, log: (message: string) => void, hostsFile?: string }} options
   */
  constructor(options) {
    this.dataDir = options.dataDir
    this.log = options.log
    /**
     * hosts 文件路径。默认是系统 hosts；**测试必须注入一个临时文件**——
     * 曾经有一次自测因为没有这个注入口，直接改掉了真实的系统 hosts。
     * 任何会写盘的路径都必须能在测试里被替换掉。
     */
    this.hostsFile = options.hostsFile ?? defaultHostsPath()
    /** @type {import('./types.js').PinConfig} */
    this.config = options.config
    this.admin = isAdmin()

    /** 当前 hosts 标记段里的 IP（唯一真相）。 */
    this.currentIps = []
    /** 当前 hosts 标记段里的域名。 */
    this.currentDomains = []

    /** 当前 IP 的最新一次读数。 */
    this.current = /** @type {import('./types.js').CurrentReading | null} */ (null)
    /** 最近一轮候选结果（按合格优先 + p50 排序）。 */
    this.candidates = /** @type {import('./types.js').CandidateReading[]} */ ([])
    this.roundStartedAt = 0
    this.roundFinishedAt = 0
    this.roundRunning = false

    /** 正在飞的思考流计数。>0 时即使判定该写也先等着。 */
    this.streaming = 0
    /** 判定结果：要不要写、写谁、为什么。 */
    this.decision = /** @type {import('./types.js').Decision} */ ({ write: false, reason: 'cold-start' })
    /** 最近一次切换的时间与 IP。 */
    this.lastSwitch = /** @type {{ at: number, ips: string[] } | null} */ (null)
    /** 最近一次手动「检测」的时间。 */
    this.lastManualScanAt = 0
    /** 最近一次错误。 */
    this.lastError = /** @type {string | null} */ (null)
    /** 当前处于哪一种失败：断网 / 没测成。 */
    this.probeFailed = false

    /** 24h 内的切换时间戳（持久化，重启不清零）。 */
    this.switchLog = /** @type {number[]} */ ([])
    /** 手动「检测」的结果缓存：同会话内不重复扫 256。 */
    this.manualScan = /** @type {import('./types.js').CandidateReading[] | null} */ (null)
    /** 候选轮换指针。 */
    this.rotation = 0

    this.disposed = false
  }

  /** 读持久化状态（切换日志 + 轮换指针）。 */
  loadState() {
    try {
      const file = path.join(this.dataDir, 'state.json')
      if (!fs.existsSync(file)) return
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (Array.isArray(raw.switchLog)) {
        this.switchLog = raw.switchLog.filter((value) => typeof value === 'number' && Number.isFinite(value))
      }
      if (typeof raw.rotation === 'number' && Number.isFinite(raw.rotation)) this.rotation = raw.rotation
    } catch (error) {
      this.log(`读 state.json 失败，按空状态继续：${String(/** @type {any} */ (error)?.message ?? error)}`)
    }
  }

  /** 写持久化状态。失败不抛：状态丢了只影响每日上限的计数，不该打断探测。 */
  saveState() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true })
      fs.writeFileSync(
        path.join(this.dataDir, 'state.json'),
        JSON.stringify({ switchLog: this.switchLog, rotation: this.rotation }, null, 2),
        'utf8',
      )
    } catch (error) {
      this.log(`写 state.json 失败：${String(/** @type {any} */ (error)?.message ?? error)}`)
    }
  }

  /** 24h 滚动窗口内的切换次数。 */
  switchesInLast24h() {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000
    return this.switchLog.filter((at) => at >= cutoff).length
  }

  /**
   * 与 hosts 对齐：hosts 是唯一真相，不信任何缓存。
   *
   * 标记段第一行就是「当前 IP」。state.json 里的轮换指针与计数冲突时以 hosts 为准。
   */
  reloadFromHosts() {
    try {
      const text = readHosts(this.hostsFile)
      const { ips, domains } = currentPin(text)
      this.currentIps = ips
      this.currentDomains = domains
      return { ok: true }
    } catch (error) {
      this.lastError = `读 hosts 失败：${String(/** @type {any} */ (error)?.message ?? error)}`
      return { ok: false }
    }
  }

  /** 启用的探测地址。 */
  enabledAddresses() {
    return this.config.addresses.filter((item) => item.enabled && item.address.trim().length > 0)
  }

  /**
   * 当前 IP 的一次快速读数。
   *
   * 6 秒一次、取最新值、不做滚动平均：用户此刻的感受不能被历史样本抹平。
   * 这里用 TCP 握手 + TLS 首字节的短采样，而不是 20s 窗口——20s 窗口是
   * 为了「排名」，当前值只是为了「现在有多慢」。
   */
  async sampleCurrent() {
    const addresses = this.enabledAddresses()
    if (addresses.length === 0) return
    // 以标记段第一行为准。若 hosts 里没有段，就没有「当前」，不猜。
    const ip = this.currentIps[0]
    if (ip === undefined) {
      this.current = null
      return
    }
    const domain = addresses[0].address
    const started = performance.now()
    try {
      const reading = await probeDomain(ip, domain, {
        windowMs: 1_200,
        intervalMs: 100,
        timeoutMs: 1_500,
      })
      this.probeFailed = false
      this.current = {
        ip,
        address: domain,
        p50: reading.p50,
        p95: reading.p95,
        loss: reading.loss,
        samples: reading.n,
        at: Date.now(),
        durationMs: performance.now() - started,
        // 单次采样可能撞上冷启动尖峰，所以把「本次采到几个样本」一起交出去：
        // 样本数过少时界面不该把这个数当成结论。
        reliable: reading.n >= 3,
      }
    } catch (error) {
      this.probeFailed = true
      this.lastError = `采样失败：${String(/** @type {any} */ (error)?.message ?? error)}`
    }
  }

  /**
   * 一轮候选实测。
   *
   * 流程严格按 cf_pin 的两段式：
   *   1. 粗筛 256 个（TCP ×2 取 min，超时 1.0s，并发 8）——只判存活
   *   2. 存活者读 colo，过滤远端机房
   *   3. 轮换取 12 个（TCP 只决定先测谁，不排名），排除当前 IP
   *   4. 每个候选 × 每个启用地址：20s 硬窗口
   *   5. 先按 p95 淘汰，再按各地址 p50 平均排序
   */
  async runCandidateRound() {
    if (this.roundRunning || this.disposed) return
    this.roundRunning = true
    this.roundStartedAt = Date.now()
    try {
      const addresses = this.enabledAddresses().map((item) => item.address)
      if (addresses.length === 0) {
        this.lastError = '没有启用的探测地址'
        this.candidates = []
        return
      }

      // ---- 1. 粗筛
      const pool = buildCandidates()
      const hits = []
      await mapLimit(pool, 8, async (ip) => {
        const { rtt, loss } = await tcpRtt(ip, { tries: 2, timeoutMs: 1_000 })
        // 两次里至少成功一次就算存活。粗筛的 rtt 是 min() 出来的幸运值，不可排序。
        if (rtt !== null && loss < 100) hits.push({ ip, rtt })
      })
      if (hits.length === 0) {
        this.candidates = []
        this.decision = { write: false, reason: 'offline' }
        this.probeFailed = true
        return
      }
      hits.sort((left, right) => left.rtt - right.rtt)

      // ---- 2. 读机房，远端出局
      const traced = await mapLimit(hits.slice(0, 40), 6, async (hit) => {
        const trace = await tlsTrace(hit.ip)
        return { ...hit, colo: trace.colo, total: trace.totalMs }
      })
      const near = traced.filter((item) => item.colo !== null && NEAR_COLOS.has(item.colo) && item.total !== null)
      // 近端候选不够时，用「机房没识别出来」的补位（识别失败常是 TLS 探测超时，与远近无关）。
      // 确认是远端的（LAX 等）永不补位：那不是慢一点，是差一个数量级。
      const unknown = traced.filter((item) => item.colo === null && item.total !== null)
      const pool2 = [...near, ...unknown].slice(0, Math.max(CANDIDATE_COUNT, near.length))

      // ---- 3. 轮换取 12 个，排除当前 IP
      const eligible = pool2.filter((item) => !this.currentIps.includes(item.ip))
      if (eligible.length === 0) {
        this.candidates = []
        this.decision = { write: false, reason: 'no-candidate' }
        return
      }
      const rotated = []
      for (let i = 0; i < Math.min(CANDIDATE_COUNT, eligible.length); i++) {
        rotated.push(eligible[(this.rotation + i) % eligible.length])
      }
      this.rotation = (this.rotation + Math.min(CANDIDATE_COUNT, eligible.length)) % Math.max(1, eligible.length)
      this.saveState()

      // ---- 4. 每个候选 × 每个地址，同候选的地址并发
      const measured = await mapLimit(rotated, this.config.candidateConcurrency, async (item) => {
        const per = await mapLimit(addresses, addresses.length, (address) =>
          probeDomain(item.ip, address))
        /** @type {Record<string, { p50: number | null, p95: number, loss: number, n: number }>} */
        const perDomain = {}
        for (const reading of per) {
          perDomain[reading.domain] = {
            p50: reading.p50,
            p95: reading.p95,
            loss: reading.loss,
            n: reading.n,
          }
        }
        const p95s = per.map((reading) => reading.p95).filter((value) => Number.isFinite(value))
        const p50s = per.map((reading) => reading.p50).filter((value) => value !== null && Number.isFinite(value))
        const samples = per.reduce((sum, reading) => sum + reading.n, 0)
        const timeouts = per.reduce((sum, reading) => sum + reading.timeouts, 0)
        return {
          ip: item.ip,
          colo: item.colo,
          // p95 取最差地址：任何一个地址卡，用户在那个地址上就会遇到
          p95: p95s.length > 0 ? Math.max(...p95s) : PENALTY_MS,
          // p50 取各地址平均：代表典型体感，样本多、最稳定
          p50: p50s.length > 0 ? p50s.reduce((sum, value) => sum + value, 0) / p50s.length : PENALTY_MS,
          samples,
          timeouts,
          perDomain,
        }
      })

      // ---- 5. 先淘汰、再排序
      const kept = measured.filter((item) => item.p95 < P95_REJECT_MS)
      const rejected = measured.filter((item) => item.p95 >= P95_REJECT_MS)
      kept.sort((left, right) => left.p50 - right.p50 || left.p95 - right.p95)
      // 被淘汰的按 p95 升序垫在后面：只有合格候选不足时才被取到，且取的是「最不坏的」
      rejected.sort((left, right) => left.p95 - right.p95 || left.p50 - right.p50)
      this.candidates = [...kept, ...rejected].map((item) => ({ ...item, qualified: item.p95 < P95_REJECT_MS }))
      this.roundFinishedAt = Date.now()
      this.probeFailed = false
      this.lastError = null
      this.decide()
    } catch (error) {
      this.probeFailed = true
      this.lastError = `候选轮失败：${String(/** @type {any} */ (error)?.message ?? error)}`
    } finally {
      this.roundRunning = false
    }
  }

  /**
   * 判定要不要写。
   *
   * 规则（逐条都是设计确认过的，不要加额外的阻尼）：
   *   - 候选最优 p50 比当前值低 ≥ switchThresholdMs
   *   - 无地板值、无「连续 N 轮」、无回切冷却
   *   - 有思考流在飞 → 状态「等待写入」，流结束即写
   *   - 24h 切换次数超上限 → 只提示不写
   */
  decide() {
    const qualified = this.candidates.filter((item) => item.qualified)
    const best = qualified[0]

    if (this.current === null || this.current.p50 === null) {
      this.decision = { write: false, reason: 'cold-start' }
      return
    }
    if (this.candidates.length === 0) {
      // 首轮候选还没跑完时，**不能**说「没有更好的线路」——那是从没做过的比较。
      // 只有真的测过一轮、且一个候选都没留下，才叫 no-candidate。
      this.decision = {
        write: false,
        reason: this.roundFinishedAt === 0 ? 'cold-start' : 'no-candidate',
      }
      return
    }
    if (best === undefined) {
      // 全部候选被 p95 淘汰 = 时断时续。当前 IP 也烂，但写一个同样烂的进去没有意义，
      // 更不能拿淘汰项凑数。
      this.decision = { write: false, reason: 'all-degraded' }
      return
    }

    const advantage = this.current.p50 - best.p50
    if (advantage < this.config.switchThresholdMs) {
      this.decision = {
        write: false,
        reason: 'observing',
        candidateIp: best.ip,
        advantage,
      }
      return
    }

    if (this.switchesInLast24h() >= this.config.maxSwitchesPerDay) {
      this.decision = { write: false, reason: 'daily-limit', candidateIp: best.ip, advantage }
      return
    }
    if (!this.admin) {
      // 绝不尝试 UAC 提权：UAC 需要用户在安全桌面确认，插件无法自动完成。
      this.decision = { write: false, reason: 'need-admin', candidateIp: best.ip, advantage }
      return
    }
    if (!this.config.autoWrite) {
      // 差距**够了**，只是用户关掉了自动切换。不能报成 observing（「差距不够」），
      // 那会把「你选了不动」说成「没必要动」，是两种完全不同的意思。
      this.decision = { write: false, reason: 'auto-off', candidateIp: best.ip, advantage }
      return
    }
    if (this.streaming > 0) {
      // 有思考流在飞：先记下判定，流结束后立刻执行。
      this.decision = { write: false, reason: 'waiting-write', candidateIp: best.ip, advantage, pending: true }
      return
    }

    this.decision = { write: true, reason: 'switched', candidateIp: best.ip, advantage }
  }

  /**
   * 执行写入。判定为「等待写入」时由流结束事件调用。
   *
   * @param {{ forced?: boolean }} [options]
   * @returns {Promise<import('./types.js').ApplyResult>}
   */
  async apply(options = {}) {
    const qualified = this.candidates.filter((item) => item.qualified)
    // 合格候选 ≥2 写 2 个；仅 1 个合格就写 1 个（不拿淘汰项凑数）
    const chosen = qualified.slice(0, MAX_WRITE_IPS)
    if (chosen.length === 0) {
      return { ok: false, reason: '无合格候选，未写入' }
    }

    const targetIps = chosen.map((item) => item.ip)

    // 「当前已是最优」的拦截**只对自动切换生效**，手动点击一律放行。
    //
    // 原实现不区分手动/自动，三条件任一成立就提前返回、什么都不写。用户明确
    // 要求「点立即切换时不要被『当前已是最优』拦住」——他按下按钮就是想要它
    // 真的动一次，即使结果和现在一样。把用户的手动操作挡回去，比多写一次
    // hosts 更糟：他会以为按钮坏了。
    //
    // 更要紧的是：`forced` 以前**只控制日志文案**，根本没参与这个判断，
    // 所以 route 传 forced:true 是无效的。这一类「以为参数会被尊重、其实没有」
    // 的 bug 在本项目已经出现过一次（dryRun 那次直接改坏了系统 hosts）。
    //
    // 自动路径仍然保留拦截，理由不变：
    //   1. 要写的 IP 与 hosts 里现有**完全一致** —— 重写只多刷一次 DNS；
    //   2. 最优候选**已经在 hosts 里**（哪怕还多钉了备用）；
    //   3. 当前实测本来就不比最优候选差（差距不到阈值）。
    const manual = options.forced === true
    if (!manual) {
      const sameSet = targetIps.length === this.currentIps.length
        && targetIps.every((ip, index) => ip === this.currentIps[index])
      const bestAlreadyPinned = this.currentIps.includes(chosen[0].ip)
      const noGain = this.current !== null && typeof this.current.p50 === 'number'
        && (this.current.p50 - chosen[0].p50) < this.config.switchThresholdMs
      if (sameSet || bestAlreadyPinned || noGain) {
        return { ok: true, alreadyOptimal: true, ips: targetIps, reason: '当前已是最优' }
      }
    }

    const addresses = this.enabledAddresses().map((item) => item.address)
    if (addresses.length === 0) {
      return { ok: false, reason: '没有启用的探测地址，未写入' }
    }

    // 写前闸门：启用的地址逐个证书校验，任一不过就不写。
    for (const candidate of chosen) {
      for (const address of addresses) {
        const verdict = await certOk(candidate.ip, address)
        if (!verdict.ok) {
          return { ok: false, reason: `${candidate.ip} 在 ${address} 上证书校验失败：${verdict.message}` }
        }
      }
    }

    try {
      const text = readHosts(this.hostsFile)
      const next = composeHosts(text, chosen.map((item) => item.ip), this.currentDomains.length > 0 ? this.currentDomains : addresses)
      const result = writeHosts(next, { file: this.hostsFile })
      flushDns()
      this.switchLog.push(Date.now())
      this.saveState()
      this.lastSwitch = { at: Date.now(), ips: chosen.map((item) => item.ip) }
      this.reloadFromHosts()
      this.decision = { write: false, reason: 'switched' }
      if (!options.forced) this.log(`已切换：${chosen.map((item) => item.ip).join(', ')}（${result.mode}）`)
      return { ok: true, ips: chosen.map((item) => item.ip), mode: result.mode }
    } catch (error) {
      return { ok: false, reason: `写 hosts 失败：${String(/** @type {any} */ (error)?.message ?? error)}` }
    }
  }

  /**
   * 手动「检测」：完整 scan 语义（粗筛并发 96 + top12 实测并发 12，约 1 分钟）。
   *
   * **默认重新扫**：这个方法只由用户的「立即检测」触发，用户按下按钮就是想要
   * 现在的数据。以前默认复用缓存，用户看到「用的是这一轮已有的结果」会以为
   * 按钮没生效——那正是「界面在撒谎」的一种。
   * 只有调用方显式传 `rescan: false` 时才复用缓存。
   *
   * @param {{ rescan?: boolean }} [options]
   */
  async manualScanNow(options = {}) {
    if (this.manualScan !== null && options.rescan === false) {
      return { ok: true, cached: true, candidates: this.manualScan }
    }
    const addresses = this.enabledAddresses().map((item) => item.address)
    if (addresses.length === 0) return { ok: false, reason: '没有启用的探测地址' }

    const pool = buildCandidates()
    const hits = []
    await mapLimit(pool, 96, async (ip) => {
      const { rtt, loss } = await tcpRtt(ip, { tries: 2, timeoutMs: 1_000 })
      if (rtt !== null && loss < 100) hits.push({ ip, rtt })
    })
    if (hits.length === 0) return { ok: false, reason: '一个 IP 都没连通，检查网络' }
    hits.sort((left, right) => left.rtt - right.rtt)

    const traced = await mapLimit(hits.slice(0, 12), 10, async (hit) => {
      const trace = await tlsTrace(hit.ip)
      return { ...hit, colo: trace.colo, total: trace.totalMs }
    })
    const usable = traced.filter((item) => NEAR_COLOS.has(item.colo ?? '') && item.total !== null)
      .concat(traced.filter((item) => item.colo === null && item.total !== null))
    const target = usable.length > 0 ? usable : traced.filter((item) => item.total !== null)

    const measured = await mapLimit(target.slice(0, 12), 12, async (item) => {
      const per = await mapLimit(addresses, addresses.length, (address) => probeDomain(item.ip, address))
      const p95s = per.map((reading) => reading.p95).filter((value) => Number.isFinite(value))
      const p50s = per.map((reading) => reading.p50).filter((value) => value !== null && Number.isFinite(value))
      /** @type {Record<string, { p50: number | null, p95: number, loss: number, n: number }>} */
      const perDomain = {}
      for (const reading of per) {
        perDomain[reading.domain] = { p50: reading.p50, p95: reading.p95, loss: reading.loss, n: reading.n }
      }
      return {
        ip: item.ip,
        colo: item.colo,
        p95: p95s.length > 0 ? Math.max(...p95s) : PENALTY_MS,
        p50: p50s.length > 0 ? p50s.reduce((sum, value) => sum + value, 0) / p50s.length : PENALTY_MS,
        samples: per.reduce((sum, reading) => sum + reading.n, 0),
        timeouts: per.reduce((sum, reading) => sum + reading.timeouts, 0),
        perDomain,
        qualified: p95s.length > 0 ? Math.max(...p95s) < P95_REJECT_MS : false,
      }
    })

    const kept = measured.filter((item) => item.qualified).sort((l, r) => l.p50 - r.p50 || l.p95 - r.p95)
    const rejected = measured.filter((item) => !item.qualified).sort((l, r) => l.p95 - r.p95 || l.p50 - r.p50)
    this.manualScan = [...kept, ...rejected]
    this.lastManualScanAt = Date.now()
    return { ok: true, cached: false, candidates: this.manualScan }
  }

  /**
   * 当前快照。客户端只读这一个，不要再自己去拼状态。
   *
   * 状态判定顺序（越靠前越能解释用户此刻的感受）：
   *   权限阻塞 > 冷启动 > 刚切换 > 等待写入 > 今日降级 > 断网 > 全劣化
   *   > 无合格候选 > 观察中 > 探测没测成 > 正常
   *
   * @returns {import('./types.js').Snapshot}
   */
  snapshot() {
    const state = this.resolveState()
    const best = this.candidates.find((item) => item.qualified) ?? null

    /**
     * 启动瞬间的候选读数：**借用一次当前读数**。
     *
     * 正常行为是「还没测过候选 → best 为 null → 候选格不显示」。但用户不想要
     * 那个空窗：图标一启动就只剩半边有数，看起来像坏了。
     *
     * 为什么可以借：这一轮候选还没测出来之前，「候选 = 当前」本来就是最诚实的
     * 假设——当前 IP 就是眼下在用的那条线。而且它是**只读的展示兜底**：
     * 不参与判定（decision 仍然用真的 best），不写 hosts，一旦测出真候选就立刻
     * 被替换。所以它不会让插件做出错误决定。
     *
     * 用 borrowedBest 标记出来，前端可以决定要不要画得更淡一点。
     */
    const borrowed = best === null
      && this.candidates.length === 0
      && this.current !== null
      && typeof this.current.p50 === 'number'
      && this.current.p50 > 0
    const shownBest = best === null
      ? (borrowed
        ? {
          ip: this.current.ip,
          p50: this.current.p50,
          p95: this.current.p95,
          colo: /** @type {any} */ (this.current).colo ?? null,
        }
        : null)
      : {
        ip: best.ip,
        p50: Math.round(best.p50),
        p95: Math.round(best.p95),
        colo: best.colo,
      }

    return {
      state,
      admin: this.admin,
      autoWrite: this.config.autoWrite,
      current: this.current,
      candidates: this.candidates.map((item) => ({
        ip: item.ip,
        colo: item.colo,
        p50: Math.round(item.p50),
        p95: Math.round(item.p95),
        qualified: item.qualified,
        samples: item.samples,
        timeouts: item.timeouts,
      })),
      best: shownBest,
      /** 候选读数是不是借用当前值（还没真正测过候选）。 */
      bestBorrowed: borrowed,
      decision: this.decision,
      /**
       * 正在飞的思考流数量。界面需要它做「流式状态」的视觉表达
       * （比如呼吸点/流动线），否则前端只能从 `waiting-write` 反推。
       * 0 表示空闲；>0 表示模型正在输出。
       */
      streaming: this.streaming,
      // advantage 的单位是毫秒（当前 p50 − 候选最优 p50）。单独给出显式字段，
      // 免得客户端去猜 decision.advantage 的量纲。
      advantageMs: typeof this.decision.advantage === 'number' ? Math.round(this.decision.advantage) : null,
      // 阈值也一起给出：界面要解释「差多少才算够」，不该自己记住 150。
      thresholdMs: this.config.switchThresholdMs,
      round: {
        running: this.roundRunning,
        startedAt: this.roundStartedAt,
        finishedAt: this.roundFinishedAt,
        durationMs: roundDurationMs(this.config.candidateConcurrency),
        intervalMin: this.config.roundIntervalMin,
      },
      lastSwitch: this.lastSwitch,
      switchesToday: this.switchesInLast24h(),
      config: this.config,
      derived: {
        roundDurationMs: roundDurationMs(this.config.candidateConcurrency),
        minRoundIntervalMin: minRoundIntervalMin(this.config.candidateConcurrency),
        slotMs: SLOT_MS,
        windowMs: 20_000,
        candidateCount: CANDIDATE_COUNT,
      },
      hosts: {
        path: this.hostsFilePath(),
        currentIps: this.currentIps,
        currentDomains: this.currentDomains,
      },
      lastError: this.lastError,
      probeFailed: this.probeFailed,
      now: Date.now(),
    }
  }

  /** @returns {import('./types.js').StateCode} */
  resolveState() {
    if (!this.admin) return STATE.needAdmin
    if (this.lastSwitch !== null && Date.now() - this.lastSwitch.at < 60_000) return STATE.switched
    if (this.current === null) return STATE.coldStart
    if (this.decision.reason === 'waiting-write') return STATE.waitingWrite
    if (this.switchesInLast24h() >= this.config.maxSwitchesPerDay) return STATE.dailyLimit
    if (this.probeFailed && this.candidates.length === 0) return STATE.offline
    if (this.decision.reason === 'all-degraded') return STATE.allDegraded
    if (this.candidates.length > 0 && this.candidates.every((item) => !item.qualified)) return STATE.allDegraded
    if (this.decision.reason === 'no-candidate') return STATE.noCandidate
    if (this.decision.reason === 'observing') return STATE.observing
    if (this.decision.reason === 'auto-off') return STATE.autoOff
    if (this.probeFailed) return STATE.probeFailed
    return STATE.normal
  }

  /** @returns {string} */
  hostsFilePath() {
    return this.hostsFile
  }
}

/**
 * 系统 hosts 的默认路径（%SystemRoot% 优先，有些机器 Windows 不在 C:）。
 *
 * @returns {string}
 */
export function defaultHostsPath() {
  const root = process.env.SystemRoot ?? 'C:\\Windows'
  return path.join(root, 'System32', 'drivers', 'etc', 'hosts')
}

/**
 * 解析数据目录：`$DSH_HOME/cf-pin-data/<profile>/`。
 *
 * 沿用 prompt-editor-data 的先例：数据不进插件目录，因为 node_modules
 * 升级会覆盖插件目录。
 *
 * @param {{ profileDir?: string }} [options]
 * @returns {string}
 */
export function resolveDataDir(options = {}) {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim().length > 0
    ? process.env.DSH_HOME
    : path.join(os.homedir(), '.dsh')
  let profile = '_default'
  const hint = options.profileDir
  if (typeof hint === 'string' && hint.trim().length > 0) {
    const base = hint.trim().replace(/[\\/]+$/, '').split(/[\\/]/).pop()
    if (typeof base === 'string' && base.length > 0) profile = safeStem(base)
  } else if (typeof process.env.DSH_PROFILE === 'string' && process.env.DSH_PROFILE.trim().length > 0) {
    profile = safeStem(process.env.DSH_PROFILE.trim())
  }
  return path.join(home, 'cf-pin-data', profile)
}

/** @param {string} value */
function safeStem(value) {
  const cleaned = String(value)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '_')
    .replace(/[. ]+$/, '')
  const stem = cleaned.length > 0 ? cleaned : '_'
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem) ? `_${stem}` : stem
}
