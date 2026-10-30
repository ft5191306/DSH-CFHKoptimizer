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
  CERT_VERDICT,
  certOk,
  buildCandidates,
  classifyCertVerdict,
  isBroken,
  isAllTimeouts,
  mapLimit,
  NEAR_COLOS,
  PENALTY_MS,
  probeDomain,
  sortCandidates,
  tcpRtt,
  tierOf,
  tlsTrace,
} from './probe.js'
import { composeHosts, currentPin, flushDns, readHosts, stripBlock, writeHosts } from './hosts.js'
import { isAdmin } from './admin.js'

/** 采样槽位：20s 采样 + 5s 余量。不开放配置。 */
export const SLOT_MS = 25_000
/** 候选轮里参与实测的候选数。 */
export const CANDIDATE_COUNT = 12
/** 一轮候选数，写 hosts 时最多取 2 个。 */
export const MAX_WRITE_IPS = 2

/**
 * 「这个 IP 的证书对这个域名不成立」这个结论保留多久。
 *
 * 证书本身是长周期的（实测同一批边缘 IP 都是同一张证，有效期到 2027），
 * 所以真证书失败基本是稳定的；但线路会变、证书会续期，不能永久记住。
 * 取 1 小时：足够省掉它带来的重复 8s 等待，又不至于让一次瞬时异常长期生效。
 */
export const CERT_FAILURE_TTL_MS = 60 * 60 * 1000

/**
 * 手动操作状态的最长存活时间。
 *
 * 手动路径是「扫描（数秒）→ 刹车动画 1400ms → 写入」。引擎只负责扫描与写入，
 * 刹车是客户端的动画。如果等客户端来收尾，客户端一旦崩溃、刷新或被切走，
 * 状态就会永远停在「测速中」——用户看到的就是「切回来还在转」。
 * 所以任何阶段超过这个时长都自动失效，宁可少转一秒，也不要卡住。
 */
export const MANUAL_TTL_MS = 90_000

/**
 * 手动操作的**结果文案**在横幅上停留多久。
 *
 * 它是「刚才那次操作的结果」，不是常驻状态。这条过期以前由客户端一个
 * setTimeout 负责；状态上游化到引擎之后，过期也必须跟着上来——否则文案会
 * 永久挂在横幅上（而且每个会话各自计时，还会出现你清我不清的不一致）。
 */
export const MANUAL_NOTE_MS = 4200

/**
 * `switchLog` 保留多长时间的历史。
 *
 * 24 小时：它只用于排查「最近一天真的写过几次 hosts」，更久的历史没有诊断价值，
 * 而又要跟着每一轮 `saveState()` 序列化一遍。以前这个窗口只写在注释里，
 * 实现从不裁剪（见 pruneSwitchLog）。
 */
export const SWITCH_LOG_TTL_MS = 24 * 60 * 60 * 1000

/**
 * 「当前 IP」这一拍采样的窗口长度（毫秒）。
 *
 * 旧实现把窗口写死成 1200ms，而单次请求的超时是 1500ms——窗口比一次超时还短。
 * 于是一条慢线路（例如每次 700ms）在窗口里只能完成 2 个样本、一条死线路只能完成
 * 1 个；`reliable` 要求 n≥3，于是**越慢越不可靠，越不可靠越不写**：自动切换
 * 在烂网络上永久停在 observing。这是「烂死在一条线路上」的第二个成因。
 *
 * 现在按上一拍的 p50 外推窗口（正好装下 3 个样本），快线不受影响（仍 1.2s），
 * 慢线自动放宽，上限压在一次采样间隔之内，绝不挤占下一拍。
 *
 * @param {number | null} previousP50 上一拍的 p50；没有历史时传 null
 * @param {number} [probeMs] 当前 IP 的采样间隔（config.currentProbeMs）
 * @returns {number}
 */
export function currentWindowMs(previousP50, probeMs = 6_000) {
  const cap = Math.max(1_200, Math.min(6_000, probeMs - 500))
  if (typeof previousP50 !== 'number' || !Number.isFinite(previousP50) || previousP50 <= 0) return 1_200
  return Math.min(cap, Math.max(1_200, Math.round(3 * previousP50 + 300)))
}

/**
 * 这一拍读数够不够可信到拿来改 hosts。
 *
 * 两个条件任一成立即可：
 *   - 样本数 ≥ 3：p50 有统计意义。
 *   - 丢包 ≥ 50%：这是**明确的坏证据**，不需要样本数支撑——噪声只会让 p50
 *     抖动，不会凭空造出「一半请求超时」。以前只认 n≥3，死线路只采到 1 个
 *     样本就被判成「不可靠」，于是自动切换对「当前线路已经死了」视而不见。
 *
 * @param {{ n?: number, samples?: number, loss?: number } | null} reading
 * @returns {boolean}
 */
export function isReadingReliable(reading) {
  if (reading === null || typeof reading !== 'object') return false
  const samples = typeof reading.n === 'number' ? reading.n : reading.samples
  if (typeof samples === 'number' && samples >= 3) return true
  return typeof reading.loss === 'number' && Number.isFinite(reading.loss) && reading.loss >= 50
}

/** 状态码。客户端据此选文案，不要靠猜。 */
export const STATE = /** @type {const} */ ({
  coldStart: 'cold-start',
  normal: 'normal',
  switched: 'switched',
  /**
   * 全劣化下的「相对择优」：所有候选都在丢包，但其中有一条明显比当前好，
   * 于是按降级规则写入了它。与 switched（有合格候选的常规切换）分开，
   * 免得把「矮子里拔将军」说成「找到了更快的线路」。
   */
  degradedSwitched: 'degraded-switched',
  observing: 'observing',
  /** 差距够了，但用户关掉了自动切换。与 observing（差距不够）不是一件事。 */
  autoOff: 'auto-off',
  waitingWrite: 'waiting-write',
  noCandidate: 'no-candidate',
  allDegraded: 'all-degraded',
  offline: 'offline',
  probeFailed: 'probe-failed',
  needAdmin: 'need-admin',
})

/**
 * 默认配置。与设计文档逐项对应。
 * @returns {import('./types.js').PinConfig}
 */
export function defaultConfig() {
  return {
    // 以下每一项都按用户 2026-10-28 的截图定稿：
    //   自动切换 **关** / 阈值 150ms / 回复中也探测 **关**
    //   并发 2 / 采样 6 秒 / 只勾选 amr-link.open-design.ai
    // （「每日 48 次」已在当天稍后按用户要求整体删除）
    //
    // autoWrite 的默认值必须是 false。它决定「是否改写系统 hosts」——这是整个
    // 插件里唯一有机器级副作用的行为，装完就默认打开等于替用户做了决定。
    // cordis.patch.yml 里也写着 false，两处必须一致；「恢复默认设置」同样读这里，
    // 所以默认值一旦是 true，用户点一下「恢复默认」就会静默打开自动改 hosts。
    autoWrite: false,
    // 图标默认显示。关掉后插件完全隐身，但测量与自动切换照常跑
    // ——「不想看见」和「不想用」是两件事。
    showUi: true,
    currentProbeMs: 6_000,
    candidateConcurrency: 2,
    // 推导值，不从输入取；这里只是让默认对象形状完整。
    roundIntervalMin: minRoundIntervalMin(2),
    switchThresholdMs: 150,
    // 每日切换上限已按用户要求删除：网络质量本身在变，用一个固定次数拦住
    // 「该切却不切」只会让人被烂死在一条线路上（用户明确要求去掉）。
    // 现在唯一的自动闸门是「值不值得切」（阈值 + 丢包不更差）。
    // 默认不探测。与 README 的默认值表一致；关掉时「等待写入」不再需要，
    // 因为探测本身就会避让思考流（见 index.js 的 sampleCurrent 调度）。
    probeWhileThinking: false,
    // 默认同心环：插件装完第一眼就是它。三格点阵已删除，fan 不再是合法值。
    skin: 'ring-core',
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
   * @param {{ dataDir: string, config: import('./types.js').PinConfig, log: (message: string) => void, hostsFile?: string, verifyCert?: (ip: string, domain: string) => Promise<{ ok: boolean, message: string }> }} options
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
    /**
     * 写前的证书闸门。默认是真的去连一次、走完整证书链校验。
     *
     * 这里必须留注入口，理由和 hostsFile 一样：apply() 是写盘路径，而它前面
     * 的闸门会发起**真实网络请求**。自测若不能替换它，就只能靠「本机此刻
     * 恰好能连上 162.159.x」来通过——那不是测试，是运气：网络抖一下、
     * 或者候选 IP 临时不可达，用例就会误报失败。留出这个 seam 之后，
     * 测试可以断言「闸门通过时写什么、不通过时不写什么」，而完全不联网。
     */
    this.verifyCert = options.verifyCert ?? certOk
    /**
     * 采样原语的注入口。默认就是真实实现（`probe.js` 的四个函数）。
     *
     * 为什么必须留这个口：`runCandidateRound` 的**级联与分档逻辑**（粗筛→读机房→
     * 轮换→实测→分档排序→全超时重扫）是纯决策，与网络无关，但它此前一次都没有
     * 离线测过——`regression-check` 只能拿源码正则断言「那几行写着」。于是
     * 「重扫其实是死代码」这种缺陷躲过了 154 条断言。留出这个 seam 后，
     * 测试可以喂一份「整轮全超时」的假网络，断言重扫真的发生了第二遍粗筛。
     */
    this.probe = options.probe ?? { buildCandidates, tcpRtt, tlsTrace, probeDomain }
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
    /** apply() 进行中。防止两拍重叠时重复写 hosts。 */
    this.applying = false
    /**
     * 正在飞的写入 Promise（null = 没人在写）。
     *
     * `applying` 是个布尔量，只够 `decideAndApply` 自己防重入；它回答不了
     * 「另一个调用者来了该怎么办」。手动 /apply 与手动 /scan 是两条独立的
     * HTTP 入口，同一个人可以在两个会话里各点一次，所以需要拿到那一份 Promise
     * 本身去合并 / 排队。见 apply() 与 manualScanNow()。
     */
    this.applyPromise = /** @type {Promise<import('./types.js').ApplyResult> | null} */ (null)
    /**
     * 正在飞的手动扫描 Promise（null = 没人在扫）。
     *
     * 一次 /scan 是 256 次 TCP 粗筛 + 12×地址×20s 采样，跑两份等于把网络负载
     * 翻倍，还会让两个 `setManualPhase('brake')` 互相覆盖。所以并发时合并成一份。
     */
    this.manualScanPromise = /** @type {Promise<import('./types.js').ScanResult> | null} */ (null)
    /** 判定结果：要不要写、写谁、为什么。 */
    this.decision = /** @type {import('./types.js').Decision} */ ({ write: false, reason: 'cold-start' })
    /** 最近一次切换的时间与 IP。 */
    this.lastSwitch = /** @type {{ at: number, ips: string[] } | null} */ (null)
    /** 最近一次切换是不是「全劣化下的相对择优」（用于前端文案与状态码）。 */
    this.lastSwitchDegraded = false
    /** 最近一次手动「检测」的时间。 */
    this.lastManualScanAt = 0
    /**
     * 手动操作（点图标测速 / 配置页「立即检测」）的公共状态。
     *
     * 引擎在宿主进程里是**全局唯一**的，但界面上可能同时开着多个会话，
     * 每个会话的横幅都是独立组件。以前「在测速」是各组件的本地 state，
     * 于是 A 会话点了测速、切到 B 会话，B 仍然画着空闲（或残留着旧动画）。
     *
     * 状态只有一份真相：写在这里，经 snapshot() 发给所有会话。
     * phase: '' | 'scan' | 'brake' | 'write'
     * @type {{ phase: string, startedAt: number, note: string }}
     */
    this.manual = { phase: '', startedAt: 0, note: '', noteAt: 0 }
    /**
     * 手动操作的**结果**文案，与阶段分开存。
     *
     * 为什么不能塞进 `manual.note`：`note` 是「当前这一步在做什么」，会随阶段
     * 被覆盖/清空；而结果是「上一次操作干成了什么」，必须活到自己的
     * `MANUAL_NOTE_MS` 过期为止。两者共用一格时实测会互相吞掉（见
     * `setManualPhase` 里记的那条覆盖 bug）。
     *
     * @type {{ text: string, at: number }}
     */
    this.manualResult = { text: '', at: 0 }
    /**
     * 全局首次拿到当前读数的时刻（0 = 还没有）。
     *
     * 供落位动画判断「图标是不是刚出现」：这个判据必须是全局的，
     * 否则每切换到一个新会话都会重播一次落位动画。
     */
    this.firstReadingAt = 0
    /** 最近一次错误。 */
    this.lastError = /** @type {string | null} */ (null)
    /** 当前处于哪一种失败：断网 / 没测成。 */
    this.probeFailed = false
    /**
     * 「真证书失败」的 IP → 记录时刻。**不是黑名单，是「别再拿它去试」。**
     *
     * 为什么需要它：`certOk` 每次最多等 8 秒。一个真的不匹配该域名的 IP，
     * 每轮都去握一次手是纯浪费——而它又不会被慢/丢包的判据自然淘汰
     * （证书问题不影响延迟）。记下来能省掉每轮 8 秒的等待。
     *
     * 只装「证书校验失败」这一类，不带超时/ECONNRESET——那些什么都没证明，
     * 记进去就会把健康 IP 永久拉黑，正是我们要修的病。
     *
     * 带 TTL：证书会续期、线路会变，不能永久记住。
     */
    this.certFailures = /** @type {Map<string, number>} */ (new Map())
    /** 最后一次写入跳过了哪些证书失败的 IP（供快照/文案使用）。 */
    this.lastSwitchCertNote = ''
    /** 最后一次写入是不是「丢包换延迟」。只影响文案，不影响是否写入。 */
    this.lastSwitchLossy = false

    /**
     * 最近 24h 内的切换时间戳（持久化，重启不清零）。
     *
     * 这个窗口以前只写在注释里：字段名说的是「日志」，实现却只 `push` 从不裁剪，
     * 于是它会随运行时长无限增长，而 `saveState()` 每轮都把它整体序列化一次。
     * 现在由 `pruneSwitchLog()` 在写入与读回两处都裁到 `SWITCH_LOG_TTL_MS` 之内，
     * 注释与行为一致。
     */
    this.switchLog = /** @type {number[]} */ ([])
    /** 手动「检测」的结果缓存：同会话内不重复扫 256。 */
    this.manualScan = /** @type {import('./types.js').CandidateReading[] | null} */ (null)
    /** 候选轮换指针。 */
    this.rotation = 0
    /**
     * 手动「立即检测」的轮换指针。
     *
     * 与 `rotation` 分开：两者取样的候选池不同（手动按机房+耗时排序、自动按 rtt
     * 顺序），共用一个指针会让各自的覆盖节奏互相踩。跟 `rotation` 一样持久化，
     * 这样重启后不会总从第一页开始点同一批候选。
     */
    this.manualRotation = 0

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
        // 读回来的旧文件可能很长（历史版本从没裁剪过），在这里也裁一次。
        this.pruneSwitchLog()
      }
      if (typeof raw.rotation === 'number' && Number.isFinite(raw.rotation)) this.rotation = raw.rotation
      if (typeof raw.manualRotation === 'number' && Number.isFinite(raw.manualRotation)) {
        this.manualRotation = raw.manualRotation
      }
    } catch (error) {
      this.log(`读 state.json 失败，按空状态继续：${String(/** @type {any} */ (error)?.message ?? error)}`)
    }
  }

  /**
   * 把 `switchLog` 裁到最近 `SWITCH_LOG_TTL_MS` 之内。
   *
   * 它只写不读（唯一的消费者是排查时的 `state.json`），所以裁剪不会改变任何
   * 判定结果——只是让「24h」这个说法名副其实，并阻止文件无限增长。
   *
   * 刻意**不假设数组已排序**：条目由 `push` 追加，正常情况下是升序的，但
   * `loadState()` 读进来的可能是任意历史文件。依赖「第一条就是最旧的」会让
   * 一次乱序就把裁剪整个跳过——那正是这个函数要修的病。
   *
   * @param {number} [now]
   */
  pruneSwitchLog(now = Date.now()) {
    if (this.switchLog.length === 0) return
    const cutoff = now - SWITCH_LOG_TTL_MS
    const kept = this.switchLog.filter((at) => at >= cutoff)
    // 没丢东西就保持同一个数组引用，避免每轮 saveState 都无谓重建。
    if (kept.length !== this.switchLog.length) this.switchLog = kept
  }

  /**
   * 写持久化状态。失败不抛：状态丢了只影响历史与轮换指针，不该打断探测。
   *
   * switchLog 现在**只写不读**：每日切换上限删除后，代码里没有消费者了。
   * 保留写入是刻意的——排查「到底有没有真的写过 hosts」时，它是唯一可信的
   * 证据（hosts mtime、备份文件时间都会被 copyFileSync / 别家工具干扰）。
   * 所以别删它，也别再加回一个「读它来做判定」的逻辑。
   */
  saveState() {
    try {
      // 裁剪放在序列化之前：避免「先写出一份超长文件、下次启动才变短」。
      this.pruneSwitchLog()
      fs.mkdirSync(this.dataDir, { recursive: true })
      fs.writeFileSync(
        path.join(this.dataDir, 'state.json'),
        JSON.stringify(
          { switchLog: this.switchLog, rotation: this.rotation, manualRotation: this.manualRotation },
          null,
          2,
        ),
        'utf8',
      )
    } catch (error) {
      this.log(`写 state.json 失败：${String(/** @type {any} */ (error)?.message ?? error)}`)
    }
  }

  /**
   * 记下「这个 IP 在证书校验上真的失败了」。
   *
   * 只由 `runApply` 在 `classifyCertVerdict` 判为 `cert` 时调用——超时、
   * ECONNRESET 这类临时链路问题**不允许**进这张表（它们什么都没证明，
   * 记进去就等于把健康 IP 永久拉黑，正是要修的病）。
   *
   * @param {string} ip
   * @param {string} address
   * @param {string} [message]
   */
  markCertFailed(ip, address, message = '') {
    this.certFailures.set(ip, Date.now())
    this.lastError = `${ip} 在 ${address} 上证书校验失败：${message || '证书不匹配'}`
    this.log(`证书校验失败，暂时跳过该 IP：${ip}（${address}）`)
  }

  /**
   * 这个 IP 的证书失败结论是否仍然有效（未过期）。
   *
   * @param {string} ip
   * @param {number} [now]
   * @returns {boolean}
   */
  isCertFailed(ip, now = Date.now()) {
    const at = this.certFailures.get(ip)
    if (typeof at !== 'number') return false
    if (now - at > CERT_FAILURE_TTL_MS) {
      this.certFailures.delete(ip)
      return false
    }
    return true
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
    // 窗口按上一拍 p50 外推：慢线路也要能采到 3 个样本，否则「样本不足」
    // 会把慢线路永久判成不可靠（见 currentWindowMs 的注释）。
    const previousP50 = this.current !== null && typeof this.current.p50 === 'number' ? this.current.p50 : null
    const windowMs = currentWindowMs(previousP50, this.config.currentProbeMs)
    const started = performance.now()
    try {
      const reading = await this.probe.probeDomain(ip, domain, {
        windowMs,
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
        // 但「丢了一半以上请求」是明确的坏证据，样本少也认（见 isReadingReliable）。
        reliable: isReadingReliable(reading),
      }
      /**
       * 首次拿到「当前读数」的全局时刻。只写一次。
       *
       * 落位动画（arriving）需要判断「图标是不是刚出现」。这个判断不能在
       * 客户端做——每个会话的横幅是独立组件，各自 `previous === null` 的时机
       * 不同，于是**每次切到一个新会话都会重播一次落位**，而图标其实一直都在。
       * 只有引擎知道「全局第一次有数据」是什么时候。
       */
      if (this.firstReadingAt === 0) this.firstReadingAt = Date.now()
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
   *   5. 按 timeouts/loss 分档，同档内按 p50 排序（probe.sortCandidates）
   *   6. 整轮全超时 → 重扫一次（候选池本身可能已经坏了）
   *
   * 入口只做三件事：独占、计时、异常兜底。实测流程在 `runCandidateRoundOnce`。
   *
   * @param {boolean} [allowRescan] 是否允许「全部超时」时自动重新粗筛一次。
   *   重扫时传 false，防止网络真断时无限重扫。
   */
  async runCandidateRound(allowRescan = true) {
    if (this.roundRunning || this.disposed) return
    this.roundRunning = true
    this.roundStartedAt = Date.now()
    try {
      await this.runCandidateRoundOnce(allowRescan)
    } catch (error) {
      this.probeFailed = true
      this.lastError = `候选轮失败：${String(/** @type {any} */ (error)?.message ?? error)}`
    } finally {
      this.roundRunning = false
    }
  }

  /**
   * 一轮候选实测的本体。**这里没有入口守卫**——独占（`roundRunning`）与异常兜底
   * 都在 `runCandidateRound` 里。
   *
   * 为什么单独拆出来：本轮之前的实现把「整轮全超时 → 重扫一次」写成递归调用
   * `this.runCandidateRound(false)`，而外层此刻已经把 `roundRunning` 置为 true，
   * 递归进来第一行就被入口守卫挡掉——**重扫一次都没执行过**。拆成不设守卫的本体后，
   * 重扫改调 `runCandidateRoundOnce(false)`，`allowRescan` 仍然负责防无限递归。
   *
   * @param {boolean} allowRescan
   */
  async runCandidateRoundOnce(allowRescan) {
    const addresses = this.enabledAddresses().map((item) => item.address)
    if (addresses.length === 0) {
      this.lastError = '没有启用的探测地址'
      this.candidates = []
      return
    }

    // ---- 1. 粗筛
    const pool = this.probe.buildCandidates()
    const hits = []
    await mapLimit(pool, 8, async (ip) => {
      const { rtt, loss } = await this.probe.tcpRtt(ip, { tries: 2, timeoutMs: 1_000 })
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
      const trace = await this.probe.tlsTrace(hit.ip)
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
        this.probe.probeDomain(item.ip, address))
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
      const loss = samples > 0 ? (100 * timeouts) / samples : 100
      return {
        ip: item.ip,
        colo: item.colo,
        // p95 取最差地址：任何一个地址卡，用户在那个地址上就会遇到
        p95: p95s.length > 0 ? Math.max(...p95s) : PENALTY_MS,
        // p50 取各地址平均：代表典型体感，样本多、最稳定
        p50: p50s.length > 0 ? p50s.reduce((sum, value) => sum + value, 0) / p50s.length : PENALTY_MS,
        samples,
        timeouts,
        loss,
        /**
         * 「断」还是「慢」？只看丢包/超时，不看 p95 的绝对值。
         * 坏网络下「每次都 1.1s 但零丢包」的 IP 会被旧口径（p95 ≥ 999）
         * 判成时断时续，导致整轮全灭、谁都不写。见 probe.isBroken。
         */
        broken: isBroken({ loss, timeouts, samples }),
        perDomain,
      }
    })

    // ---- 5. 先分「断/慢」，再排序
    //
    // 旧实现用 `p95 >= P95_REJECT_MS` 分合格/淘汰，把「慢」和「断」压成
    // 同一个数：p95 触顶既可能是真的在丢包，也可能只是每个请求都慢到
    // 1 秒以上。后者在烂网络里是常态，于是所有候选都被判「时断时续」，
    // 自动不写、手动也拒绝——用户被烂死在一条线路上。
    //
    // 现在：只有丢包/超时才叫「断」（probe.isBroken），纯慢只影响名次。
    //
    // 分档与排序都交给 probe.sortCandidates：档位 clean → ok → degraded，
    // 同档内按 p50、再按 p95。**p95 不参与判定**，只做 tiebreak——实测
    // 同一批候选连跑 4 个 6s 窗口，p50 极差 7ms、p95 极差 220ms（32 倍），
    // 拿 p95 主排等于把名次交给噪声。而且 p95 的数值**分不出超时与慢**
    // （超时记 999，成功样本也能 >999），所以「是否超时」只能看 timeouts。
    this.candidates = sortCandidates(measured).map((item) => ({
      ...item,
      tier: tierOf(item),
      qualified: !item.broken,
    }))
    this.roundFinishedAt = Date.now()
    this.probeFailed = false
    this.lastError = null

    // ---- 6. 兜底：整轮一个成功样本都没有 → 候选池本身可能是坏的，重新粗筛一次。
    //
    // 这是级联的最后一档。为什么需要它：候选池来自 256 个 IP 的粗筛，而粗筛
    // 只在那一刻判「TCP 通不通」。如果粗筛恰好赶上网络抖动，产出的池子就是坏的，
    // 之后怎么降级都救不回来——池子里根本没有好 IP。这时唯一的出路是重扫。
    //
    // 只重试一次（allowRescan 防循环），且必须换一轮粗筛结果才算数。
    if (allowRescan && this.candidates.length > 0 && this.candidates.every((item) => isAllTimeouts(item))) {
      this.log('候选全部超时：重新粗筛一次')
      await this.runCandidateRoundOnce(false)
      return
    }

    // 一轮候选刚测完，是「该不该换」最有信息量的时刻：候选名次新鲜、
    // 当前读数也在几秒内。这里直接判定并执行，而不是只留一个 decision.write
    // 等下一次 6 秒采样——那个结论以前根本没人读，等于白算。
    await this.decideAndApply()
  }

  /**
   * 判定要不要写。
   *
   * 规则（逐条都是设计确认过的，不要加额外的阻尼）：
   *   - 候选最优 p50 比当前值低 ≥ switchThresholdMs
   *   - 无地板值、无「连续 N 轮」、无回切冷却
   *   - 有思考流在飞 → 状态「等待写入」，流结束即写
   *   - **无每日次数上限**（已按用户要求删除，见下方 apply 前的注释）
   *   - **是否有「合格」候选只影响怎么称呼这次切换，不影响能不能切**：
   *     全都在丢包时退到「最不坏」的那条做相对择优（多一条约束：丢包不能更差），
   *     判定理由记为 degraded-switched，而不是 all-degraded 一拒了之。
   */
  /**
   * 选出「当下最优候选」，并说明它是不是「矮子里拔的将军」。
   *
   * **`decide()` 与 `snapshot()` 必须共用这一份派生**，不能各写一套过滤。
   *
   * 为什么（2026-10-30 修复）：修「`snapshot.best` 忽略 `certFailures`」时，
   * 只在 `snapshot()` 里加了一道 cert 过滤，而 `decide()` 的规则是「没有合格
   * 候选就退到 `pool[0]` 做相对择优」。两套口径于是分叉，实测出现镜像错误：
   * 全部候选都在丢包时，`decide()` 给出 `write:true, candidateIp:104.26.0.1`
   * （这一拍真的会把 hosts 切过去），而 `snapshot.best` 是 `null`——界面
   * 「更快候选」格显示「没有」。原缺陷是「界面推荐一条切不过去的线」，
   * 修完变成「界面说没有、插件正在切」，是同一类错误的另一个方向。
   *
   * 现在两边都走这里：先排除证书已判死的，再从「不丢包的」里取第一条；
   * 一条都不丢包的（usable 为空）才退到相对择优的 `healthy[0]`。
   *
   * @returns {{ pool: import('./types.js').CandidateReading[], usable: import('./types.js').CandidateReading[], degraded: boolean, best: import('./types.js').CandidateReading } | null}
   *   null 表示「一个可选候选都没有」（全部证书判死，或还没测过）。
   */
  selectBest() {
    const healthy = this.candidates.filter((item) => !this.isCertFailed(item.ip))
    if (healthy.length === 0) return null
    const usable = healthy.filter((item) => !item.broken)
    const degraded = usable.length === 0
    return { pool: healthy, usable, degraded, best: degraded ? healthy[0] : usable[0] }
  }

  decide() {
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

    // 有没有「不丢包」的候选？一条都没有就退到「最不坏」的那条（相对择优）。
    //
    // 这是本插件以前最要命的缺口：全部候选被淘汰时只写一个 all-degraded 就
    // 结束了，自动不写；而 apply() 又只取 qualified，手动点击也返回
    // 「无合格候选，未写入」。于是网络整体变差时，用户被烂死在当前一条线路上，
    // 既不能自动换、也不能手动换。
    //
    // candidates 的顺序由 runCandidateRound / manualScanNow 保证（probe.sortCandidates）：
    // 0 号永远是「当下最好」的——先按档位 clean → ok → degraded，同档内按 p50。
    //
    // 注意这里**排除证书已被证明失败的 IP**：它们不会因为延迟差被自然淘汰，
    // 让它们参与「最优候选」的竞选会把判定带去一个根本写不进去的目标。
    //
    // 兜底的边界（2026-10-30 修）：`healthy` 为空时**不能**简单回退到全部候选。
    // 那样一来 `markCertFailed` 的「别再拿它去试」就被原地作废了 —— 实测症状是
    // `decide()` 照旧给出 `write:true`，`runApply()` 进去再握两三次手、失败、
    // 3 秒后的下一拍重复一遍，`lastError` 一直挂着「证书校验均未通过」。
    // 所以只有当候选里**还有没被判死的**（即 healthy 非空）时才谈论择优；
    // 全部被判死时如实给 no-candidate，等 TTL 过期或网络变了再说。
    const chosenBest = this.selectBest()
    if (chosenBest === null) {
      this.decision = { write: false, reason: 'no-candidate' }
      return
    }
    const { degraded, best } = chosenBest
    const advantage = this.current.p50 - best.p50

    // 当前读数的样本数太少时（窗口里只抓到一两个），p50 是噪声，不是结论。
    // 单次采样撞上冷启动尖峰就会凭空造出几百毫秒的「优势」，然后拿它去改 hosts。
    if (this.current.reliable === false) {
      this.decision = { write: false, reason: 'observing', candidateIp: best.ip, advantage, degraded }
      return
    }

    // 全劣化时多一条约束：不能拿「延迟」换「丢包」。
    // 候选的丢包率必须不高于当前，否则「更快」只是丢包丢出来的假象。
    const currentLoss = typeof this.current.loss === 'number' ? this.current.loss : null
    const bestLoss = typeof best.loss === 'number' ? best.loss : null
    const lossOk = !degraded || currentLoss === null || bestLoss === null || bestLoss <= currentLoss

    if (advantage < this.config.switchThresholdMs || !lossOk) {
      this.decision = {
        write: false,
        // 全断又没有一条明显更好 → all-degraded（如实说「都不行」）；
        // 有合格候选、只是差距不够 → observing。两者不是一回事。
        reason: degraded ? 'all-degraded' : 'observing',
        candidateIp: best.ip,
        advantage,
        degraded,
      }
      return
    }

    // 每日切换上限已按用户要求整体删除（2026-10-28）。
    //
    // 它原本是「不折腾你的机器」的承诺，但代价是：网络整体变差、需要多换几次
    // 的时候，它恰好成了唯一还会让用户「烂死在一条线路上」的自动侧原因。
    // 现在自动切换的闸门只剩两个，都跟「值不值得」有关，跟次数无关：
    //   1. 候选比当前低 ≥ switchThresholdMs；
    //   2. 全劣化时丢包率不高于当前（不拿延迟换丢包）。
    // 反悔成本也因此只有一个：机器被多换几次 —— 而这正是用户要的。
    if (!this.admin) {
      // 绝不尝试 UAC 提权：UAC 需要用户在安全桌面确认，插件无法自动完成。
      this.decision = { write: false, reason: 'need-admin', candidateIp: best.ip, advantage, degraded }
      return
    }
    if (!this.config.autoWrite) {
      // 差距**够了**，只是用户关掉了自动切换。不能报成 observing（「差距不够」），
      // 那会把「你选了不动」说成「没必要动」，是两种完全不同的意思。
      this.decision = { write: false, reason: 'auto-off', candidateIp: best.ip, advantage, degraded }
      return
    }
    if (this.streaming > 0) {
      // 有思考流在飞：先记下判定，流结束后立刻执行。
      this.decision = { write: false, reason: 'waiting-write', candidateIp: best.ip, advantage, degraded, pending: true }
      return
    }

    this.decision = {
      write: true,
      // 全劣化下写入的是「矮子里拔的将军」：状态要说清楚，不能报成常规切换。
      reason: degraded ? 'degraded-switched' : 'switched',
      candidateIp: best.ip,
      advantage,
      degraded,
    }
  }

  /**
   * 结束手动「写入」阶段，把结果写进横幅文案。
   *
   * 为什么这也要在引擎里：阶段状态是引擎持有的（跨会话唯一），收尾却写在路由里，
   * 于是「谁负责收尾」这条线断在进程边界上——而 `/apply` 可能合并到**自动路径**
   * 的写入（`decideAndApply()` / `drainPending()`），那条路径从不管理 manual 阶段。
   * 原实现只在 `merged !== true` 时收尾，合并时便无人收尾，`write` 阶段一直挂到
   * `MANUAL_TTL_MS`（90 秒）自己过期：图标持续「写入中…」、配置页三个按钮全灰。
   *
   * 现在**无条件**收尾，并且只在阶段仍是 `write` 时才动 —— 请求在飞的这几秒里
   * 客户端可能已经开始了别的动作，把它的阶段清掉会让界面倒退。
   *
   * 收尾分成两件事，不再共用一格：
   *   - 阶段 → `''`（`setManualPhase`）；
   *   - 结果文案 → `manualResult`（`setManualResult`），有自己的存活期，
   *     不会被随后返回的 `/scan` 覆盖成「测速完成」。
   *
   * @param {import('./types.js').ApplyResult | null} result null 表示抛了异常
   */
  finishManualWrite(result) {
    if (this.manual.phase !== 'write') return
    this.setManualPhase('')
    if (result === null) {
      this.setManualResult('写入失败')
      return
    }
    const tag = result.degraded === true ? '（降级）' : ''
    /**
     * `alreadyOptimal` 必须单独说。
     *
     * 这条路径在合并（`merged`）时才会走到：手动 `/apply` 并进了一次**自动**写入，
     * 而那一次判定为「当前已是最优」、**一个字节都没写**。原实现只看 `ok`，
     * 于是横幅会说「已切到 X」——而 hosts 根本没变。用户看到的是一次没发生的切换。
     */
    if (result.alreadyOptimal === true) {
      this.setManualResult('当前已是最优，未写入')
      return
    }
    this.setManualResult(result.ok
      ? ((result.ips?.length ?? 0) > 0 ? '已切到 ' + result.ips.join('、') + tag : '已写入' + tag)
      : '写入失败')
  }

  /**
   * 把「手动操作进行到哪一步」写进全局状态，供所有会话的横幅读取。
   *
   * 只在手动路径上调用：自动采样、自动轮次**不**点亮图标，否则每 6 秒转一次，
   * 与「平时安静」的设计冲突（用户已确认这个取向）。
   *
   * 关键设计：**状态带 TTL，自己会过期。**
   * 客户端的 brake 是纯动画阶段（1400ms），引擎并不参与；如果引擎等客户端回来
   * 报告「动画播完了」，客户端一旦崩溃/关页/切会话，状态就会永久卡在测速中——
   * 这正是用户报的「切回来还在转」。所以任何阶段超过 `MANUAL_TTL_MS` 就自动
   * 视为已结束（读快照时判定，不依赖定时器）。
   *
   * @param {string} phase '' | 'scan' | 'brake' | 'write'
   * @param {string} [note]
   */
  setManualPhase(phase, note = '') {
    if (phase === '') {
      // 收尾只清「阶段」，**不动结果文案**。
      //
      // 结果文案有自己的一格（`manualResult`），因为「这次操作的结果」和
      // 「现在进行到哪一步」是两件事。以前两者共用 `note`，于是出现了实测过的
      // 覆盖 bug：用户先点「立即检测」（scan，约 100s），扫描没结束时点
      // 「立即切换」→ `/apply` 先完成并写下「已切到 104.26.0.1」，接着 `/scan`
      // 返回把它设成 brake/"测速完成"，brake 到点又清成 ""——**用户永远看不到
      // 那次切换的结果**。反过来（brake 先设）也一样会把结果吞掉。
      // 现在阶段转换碰不到结果格，两条路各写各的。
      this.manual = { phase: '', startedAt: 0, note: '', noteAt: 0 }
      return
    }
    // 中途切阶段不重置 startedAt，否则客户端算的耗时会跳。
    //
    // **但「上一个阶段已经 TTL 过期」不算中途切换**：那是一次已经被引擎判定
    // 结束的操作，新的阶段必须从头计时。否则会出现实测过的怪状——上一轮扫描
    // 超时被判结束后，用户再点「立即切换」，`write` 直接继承那个超时的
    // `startedAt`，于是它一出生就是「已过期」，图标不转、三按钮立刻可用，
    // 而写入其实正在进行。
    const previousExpired = this.manual.phase !== ''
      && Date.now() - this.manual.startedAt > MANUAL_TTL_MS
    const freshStart = this.manual.phase === '' || previousExpired
    this.manual = {
      phase,
      startedAt: freshStart ? Date.now() : this.manual.startedAt,
      note,
      noteAt: note === '' ? 0 : Date.now(),
    }
  }

  /**
   * 写一条「刚才那次手动操作的结果」。
   *
   * 与阶段解耦（见 `setManualPhase` 的注释）：它只受自己的存活期
   * `MANUAL_NOTE_MS` 约束，不会因为别的路由切换/收尾阶段而消失。
   * 开始一次新的手动操作时由调用方清掉（避免旧结果挂在新的进度后面）。
   *
   * @param {string} text
   */
  setManualResult(text) {
    this.manualResult = { text, at: text === '' ? 0 : Date.now() }
  }

  /**
   * 当前**有效**的手动阶段（已考虑 TTL 过期）。
   * @returns {{ phase: string, startedAt: number, note: string, busy: boolean }}
   */
  manualNow() {
    const { phase, startedAt, note, noteAt } = this.manual
    /**
     * 进度文案（`note`）跟着阶段走：忙碌期间是「写入中…」这类说明，不能按
     * 存活期消失；空闲时它已经没有意义，清掉。
     */
    const shownNote = phase === '' ? '' : note
    /**
     * 结果文案（`manualResult`）有**自己**的存活期，与阶段无关。
     *
     * 这是「先点检测、再点切换」那条覆盖 bug 的修法：`/scan` 的 brake 与
     * `/apply` 的收尾是两个路由，以前它们共写 `note`，谁后到谁说了算，
     * 于是切换结果会被「测速完成」吃掉。分开之后，结果只由自己的
     * `MANUAL_NOTE_MS` 决定去留。
     */
    const resultAlive = this.manualResult.text !== ''
      && Date.now() - this.manualResult.at < MANUAL_NOTE_MS
    const noteOut = phase === '' ? (resultAlive ? this.manualResult.text : '') : shownNote
    if (phase === '') return { phase: '', startedAt: 0, note: noteOut, busy: false }
    if (Date.now() - startedAt > MANUAL_TTL_MS) {
      // 自我保护：客户端没回来收尾就当作已结束，别让图标永远转。
      // 结果文案仍受它自己的存活期约束，不会因为阶段超时而一起常驻。
      return { phase: '', startedAt: 0, note: resultAlive ? this.manualResult.text : '', busy: false }
    }
    return { phase, startedAt, note: noteOut, busy: true }
  }

  /**
   * 判定并**立刻执行**它。
   *
   * decide() 只负责写下结论（decision.write），它不碰 hosts——这一层以前没有
   * 执行者：index.js 每次采样后只调 decide() 就结束了，`write: true` 这个结论
   * 没有任何代码读取。自动切换于是只在「判定瞬间恰好在流式输出」时才生效
   * （走 waiting-write → drainPending 那条路），空闲时判出的切换被直接丢弃，
   * 下一个 6 秒周期再判一次、再丢弃。表现就是「时灵时不灵」。
   *
   * 现在把「判定 → 执行」收成一个方法，调用方只调它，不再需要知道有 write 这回事。
   *
   * @returns {Promise<import('./types.js').ApplyResult | null>} 没写则返回 null
   */
  async decideAndApply() {
    this.decide()
    if (this.decision.write !== true) return null
    // 先落一个「正在写」的标记：apply() 是异步的（证书闸门要连好几次），
    // 期间若又来一拍 decideAndApply，会重复写一次 hosts。
    if (this.applying) return null
    this.applying = true
    try {
      const result = await this.apply()
      if (result.ok) {
        if (result.alreadyOptimal === true) {
          // 没写：只是确认「当前已是最优」。不能把状态误报成「刚切换过」。
          this.decision = { write: false, reason: 'observing' }
        } else {
          // apply() 内部已经写过 switchLog / lastSwitch / decision 了，这里补上
          // 「常规切换 vs 全劣化下的相对择优」这一位，免得把降级说成常规。
          this.decision = {
            write: false,
            reason: result.degraded === true ? 'degraded-switched' : 'switched',
            degraded: result.degraded === true,
          }
        }
      } else {
        this.lastError = result.reason ?? '写入失败'
        this.decision = { write: false, reason: 'probe-failed' }
      }
      return result
    } finally {
      this.applying = false
    }
  }

  /**
   * 执行写入。判定为「等待写入」时由流结束事件调用。
   *
   * @param {{ forced?: boolean }} [options]
   * @returns {Promise<import('./types.js').ApplyResult>}
   */
  async apply(options = {}) {
    /**
     * 并发的第二次写入**合并**到正在跑的那一次。
     *
     * 两次 `writeHosts` 交错是真会出事的：`hosts.bak` 只有单份，后一次覆盖前一次
     * 的备份，等于丢掉一次可回滚的状态；两次「读 hosts → 改标记段 → 写回」交错
     * 还可能让第二次基于过期的文本写回去，把第一次的结果冲掉。
     *
     * 合并而非拒绝：用户按下「立即切换」就是要它真的动一次，拿到的也确实是
     * 「刚刚有人正在做的那次写入」的结果，语义完全对得上。
     */
    if (this.applyPromise !== null) {
      // merged：合并到别人那次写入。阶段与结果文案由原请求负责收尾。
      const shared = await this.applyPromise
      return { ...shared, merged: true }
    }
    const running = this.runApply(options)
    this.applyPromise = running
    try {
      return await running
    } finally {
      if (this.applyPromise === running) this.applyPromise = null
    }
  }

  /**
   * 真正执行一次写入。只由 `apply()` 调用，不要在别处直接调。
   *
   * @param {{ forced?: boolean }} [options]
   * @returns {Promise<import('./types.js').ApplyResult>}
   */
  async runApply(options = {}) {
    const manual = options.forced === true
    /**
     * 选谁写：先排除「证书已被证明不适配这个域名」的 IP。
     *
     * 它们不会因为延迟差而被自然淘汰（证书问题不影响测速），所以必须在这里
     * 主动跳过，否则每次写入都要先陪它握一次 8 秒的手，最后还是被剔除。
     *
     * 与 `decide()` 的兜底边界保持一致（2026-10-30 修）：候选**全部**被判死时
     * 不回退到全部候选——那会让每次写入都重新握手一遍、注定失败，`apply()` 的
     * Promise 合并只能串行化、止不住这个循环。这里直接如实失败，把原因说清楚。
     * 手动路径同样如此：按钮点了要动，但「动的结果一定是失败」不该伪装成一次尝试。
     */
    const healthy = this.candidates.filter((item) => !this.isCertFailed(item.ip))
    if (healthy.length === 0) {
      // 两种「空」必须分开说（空数组和「全被判死」是两件事）：
      //   candidates 为空 = 还没测过任何候选，此时说「证书都不适配」是纯粹的谎话。
      if (this.candidates.length === 0) return { ok: false, reason: '还没有候选读数，未写入' }
      const why = `候选在证书校验上均已被判为不适配（${this.candidates.map((item) => item.ip).join('、')}），` +
        '已记下并暂时跳过；等记录过期或网络变化后会自动重试'
      this.lastError = why
      return { ok: false, reason: why }
    }
    const pool = healthy
    // 合格 = 「不丢包」。有合格的就只写合格的，每条最多 2 个。
    const usable = pool.filter((item) => !item.broken)
    let chosen = usable.slice(0, MAX_WRITE_IPS)
    /** 本次写入是不是「矮子里拔将军」。 */
    let degraded = false

    if (chosen.length === 0) {
      // 没有合格候选（全都在丢包 / 或根本没有合格读数）→ 降级为「最不坏」的候选。
      //
      // 这是「烂死在一条线路上」的直接修法：以前这里直接 return 失败，于是
      // 手动「立即切换」在全劣化时也点不动（用户按下按钮却被告知「无合格候选」），
      // 自动路径更是连降级分支都没有。
      //
      // 现在按 candidates 的顺序（档位 → 丢包 → p50）取 1~2 个，并标 degraded。
      // 优先排除 hosts 里已经钉着的 IP：换一条才有意义；只剩它们时才原样写回。
      const fresh = pool.filter((item) => !this.currentIps.includes(item.ip))
      const degradedPool = fresh.length > 0 ? fresh : pool
      chosen = degradedPool.slice(0, MAX_WRITE_IPS)
      degraded = chosen.length > 0
    }
    if (chosen.length === 0) {
      // 连一个候选读数都没有：这是「还没测过」，不是「测过但都不行」。
      return { ok: false, reason: '还没有候选读数，未写入' }
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

    // 写前闸门：逐个候选做证书校验，**通过的留下、失败的剔除**。
    //
    // 这里以前是「任一失败就整体放弃」，两个后果都是真的：
    //   1. 首选（已通过校验、延迟最优）会因为**备选项**的证书问题一起被丢弃。
    //      实测过：两个候选里第 2 个失败，结果连第 1 个都没写，hosts 一字未动。
    //   2. 更糟的是它把「网络超时」也当成证书失败——网络越差，闸门越容易超时，
    //      写入越被挡住。这跟过去「没有合格候选就失败」是同一个病的第二种形态：
    //      症状一样（烂死在一条线路上），根因完全不同。
    //
    // 所以现在：
    //   - 真证书问题（CERT_REJECTED）→ 剔除该候选，并记住这个 IP 不要再试。
    //   - 临时链路问题（超时/ECONNRESET）→ 它什么都没证明，重试一次；仍失败则
    //     不算证书失败，放行但标记「未校验」，由调用方决定怎么显示。
    //   - 全部候选都被剔除 → 才如实返回失败。
    //
    // 走 this.verifyCert 而不是直接调 certOk：这是 apply() 里唯一的网络依赖，
    // 留出注入口，测试才能在不联网的前提下验证闸门行为。
    const verified = []
    /** @type {string[]} */
    const rejected = []
    for (const candidate of chosen) {
      let verdictLevel = 'ok'
      let lastMessage = ''
      for (const address of addresses) {
        let verdict = await this.verifyCert(candidate.ip, address)
        let kind = classifyCertVerdict(verdict)
        // 只有「临时链路问题」才值得重试一次：一次超时不足以证明任何事，
        // 但证书不匹配重试一百次也是同一个结果。
        if (kind === CERT_VERDICT.link) {
          verdict = await this.verifyCert(candidate.ip, address)
          kind = classifyCertVerdict(verdict)
        }
        lastMessage = String(verdict?.message ?? '')

        if (kind === CERT_VERDICT.ok) continue
        if (kind === CERT_VERDICT.cert) {
          // 真证书问题：这个 IP 对该域名就是不可用的，本次运行内不再尝试。
          this.markCertFailed(candidate.ip, address, lastMessage)
          verdictLevel = 'cert'
          break
        }
        // link：重试后仍是链路问题 → 放行但标记「未校验」。
        // unknown：**不认识 = 没有安全证据**，按「未通过」处理，不放行。
        if (kind === CERT_VERDICT.unknown) {
          verdictLevel = 'unknown'
          break
        }
        if (verdictLevel === 'ok') verdictLevel = 'unverified'
      }
      if (verdictLevel === 'cert' || verdictLevel === 'unknown') {
        if (verdictLevel === 'unknown') {
          this.lastError = `${candidate.ip} 的证书校验返回了无法归类的错误：${lastMessage}`
        }
        rejected.push(candidate.ip)
        continue
      }
      verified.push({ ...candidate, certUnverified: verdictLevel === 'unverified', certMessage: lastMessage })
    }

    if (verified.length === 0) {
      const why = rejected.length > 0
        ? `候选在 ${addresses.join('、')} 上证书校验均未通过（${rejected.join('、')}）`
        : '没有候选通过证书校验'
      this.lastError = why
      return { ok: false, reason: why }
    }

    // 闸门之后重新确定要写谁：被剔除的候选不再参与，且顺序保持原有的优劣。
    const acceptedIps = new Set(verified.map((item) => item.ip))
    chosen = chosen.filter((item) => acceptedIps.has(item.ip))
    const certUnverified = verified.some((item) => item.certUnverified)
    const certNote = rejected.length > 0
      ? `（${rejected.join('、')} 证书校验未通过，已跳过）`
      : (certUnverified ? '（证书校验超时，未确认）' : '')

    try {
      const text = readHosts(this.hostsFile)
      // 写哪些域名？
      //
      // 原实现是 `currentDomains.length > 0 ? currentDomains : addresses`：只要
      // hosts 里已经有一个标记段，就**完全忽略**用户当前勾选的地址，把旧段里的
      // 域名原样写回去。两个后果都是真的：
      //   - 用户新勾上的地址（比如默认只勾了 amr-link，而旧段里没有它）
      //     永远写不进 hosts，换线对它无效——而宿主的 baseURL 正是这个域名；
      //   - 用户取消勾选的地址仍会被写回去，且它没经过上面的证书闸门
      //     （闸门只校验 enabled 的地址）。
      //
      // 正确语义：写入的就是「当前启用的地址」，一个不多、一个不少。这样
      // 「只有勾选的地址参与测量和写入」这句话才成立，闸门校验的集合与实际
      // 写入的集合也才是同一个。
      const next = composeHosts(text, chosen.map((item) => item.ip), addresses)
      const result = writeHosts(next, { file: this.hostsFile })
      flushDns()
      this.switchLog.push(Date.now())
      this.saveState()
      this.lastSwitch = { at: Date.now(), ips: chosen.map((item) => item.ip) }
      // 记住这次是不是降级写入：前端据此说「全部偏慢，已切到相对较好的一条」，
      // 而不是「找到了更快的线路」——两种事实不能混。
      this.lastSwitchDegraded = degraded
      /**
       * 这次写入是不是「丢包换延迟」——即写入的候选比当前线路更容易丢包。
       *
       * 全劣化时这是可能发生的：候选 p50 更低、但丢包率更高。用户已明确
       * 「仍然写入，但文案要如实说明」——不拦他，但不能把「更差」说成「更好」。
       * 这个标记只影响文案，不影响是否写入。
       */
      this.lastSwitchLossy = degraded && typeof this.current?.loss === 'number'
        && typeof chosen[0]?.loss === 'number'
        && chosen[0].loss > this.current.loss
      this.lastSwitchCertNote = certNote
      this.reloadFromHosts()
      this.decision = { write: false, reason: degraded ? 'degraded-switched' : 'switched', degraded }
      if (!options.forced) {
        this.log(`已${degraded ? '降级' : ''}切换：${chosen.map((item) => item.ip).join(', ')}（${result.mode}）${certNote}`)
      }
      return {
        ok: true,
        ips: chosen.map((item) => item.ip),
        mode: result.mode,
        degraded,
        lossy: this.lastSwitchLossy,
        certUnverified,
        certRejected: rejected,
        note: certNote,
      }
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
    /**
     * 并发的第二次「立即检测」**合并**到正在跑的那一次，而不是拒绝它。
     *
     * 拒绝会踩用户两次否决过的「别拦我」取向（§7.3 第 1 条）：按钮点了没反应，
     * 用户只会以为坏了。合并则不浪费任何东西——他等的是同一份新鲜结果。
     * 只有显式 `rescan:false`（想要缓存）走上面的提前返回，语义不同。
     */
    if (this.manualScanPromise !== null) {
      // 标记 merged：路由据此知道「阶段收尾已经有人负责了」，不要重复
      // 设一次 brake、也不要再起一个收尾定时器。
      const shared = await this.manualScanPromise
      return { ...shared, merged: true }
    }
    const running = this.runManualScan()
    this.manualScanPromise = running
    try {
      return await running
    } finally {
      // 只清自己那一份：超时/异常之后别的调用可能已经开了新的一轮。
      if (this.manualScanPromise === running) this.manualScanPromise = null
    }
  }

  /**
   * 真正执行一次手动扫描。只由 `manualScanNow` 调用，不要在别处直接调——
   * 这里是它唯一负责并发合并的地方。
   *
   * @returns {Promise<import('./types.js').ScanResult>}
   */
  async runManualScan() {
    const addresses = this.enabledAddresses().map((item) => item.address)
    if (addresses.length === 0) return { ok: false, reason: '没有启用的探测地址' }

    const pool = this.probe.buildCandidates()
    const hits = []
    await mapLimit(pool, 96, async (ip) => {
      const { rtt, loss } = await this.probe.tcpRtt(ip, { tries: 2, timeoutMs: 1_000 })
      if (rtt !== null && loss < 100) hits.push({ ip, rtt })
    })
    if (hits.length === 0) return { ok: false, reason: '一个 IP 都没连通，检查网络' }
    hits.sort((left, right) => left.rtt - right.rtt)

    /**
     * 读机房取 40 个，与自动轮（`runCandidateRoundOnce`）取同一个宽度。
     *
     * 以前这里只取 12 个，理由是「手动要快」。但这段 `hits` 是按 **TCP rtt** 排的，
     * 而 §10.1 的实测结论正是「TCP 不能排序」——用一段已知不可排序的量去截前 12 名，
     * 等于把候选池的多样性砍掉。后果是用户点「立即检测」看到的候选可能比自动轮更差，
     * 而 `runManualScan` 末尾又会把这份结果提升为 `this.candidates`，自动切换接着就用它。
     * 现在先按 40 个读机房、再按近端机房过滤后取 12，与自动轮同构。
     */
    const traced = await mapLimit(hits.slice(0, 40), 10, async (hit) => {
      const trace = await this.probe.tlsTrace(hit.ip)
      return { ...hit, colo: trace.colo, total: trace.totalMs }
    })
    const usable = traced.filter((item) => NEAR_COLOS.has(item.colo ?? '') && item.total !== null)
      .concat(traced.filter((item) => item.colo === null && item.total !== null))
    const target = usable.length > 0 ? usable : traced.filter((item) => item.total !== null)

    /**
     * 从 `target` 里取哪 12 个来实测——**不能用 TCP rtt 截前 12 名**。
     *
     * 修 ⑤ 时只把「读机房」的宽度从 12 提到 40，截断仍然按 `hits` 的 TCP rtt 顺序做。
     * 但本节上面的注释（和 §9 的实测结论）自己就写着「TCP 不能排序」：
     * 用一段已知不可排序的量去决定谁进实测，等于随机扔掉了 2/3 的候选池。
     * 实测过一组「TCP rtt 递增、真实 HTTPS 延迟递减」的假网络：改之前手动检测
     * 给出的最优候选是 460ms，而真正最快的那条（100ms）因为它 TCP rtt 最大
     * 从来没被测过；同样的网络下自动轮靠 `rotation` 三轮就把 20 个全覆盖了。
     *
     * 现在按两种排序取并集，两者都指向「更值得实测」：
     *   1. `total`（读机房这一次真实 HTTPS 的耗时，带 colo 的那次握手）升序——
     *      它是一次**真实的端到端 HTTPS 往返**，比 TCP 可信得多；
     *   2. 近端机房（`NEAR_COLOS`）优先——远端机房的延迟差一个数量级，先排掉。
     * 再按 `rotation` 轮换起点，避免每次点「立即检测」都测同一批。
     */
    const ranked = [...target].sort((left, right) => {
      const leftNear = NEAR_COLOS.has(left.colo ?? '') ? 0 : 1
      const rightNear = NEAR_COLOS.has(right.colo ?? '') ? 0 : 1
      if (leftNear !== rightNear) return leftNear - rightNear
      const leftTotal = left.total ?? Number.POSITIVE_INFINITY
      const rightTotal = right.total ?? Number.POSITIVE_INFINITY
      if (leftTotal !== rightTotal) return leftTotal - rightTotal
      return left.rtt - right.rtt
    })
    /**
     * 排除 hosts 里已钉住的 IP：换一条才有意义，而且它们已经「在用」了，
     * 让它们占掉一个实测名额就等于少测一条别的。自动轮里就是 `eligible` 这一步。
     */
    const eligible = ranked.filter((item) => !this.currentIps.includes(item.ip))
    const pickFrom = eligible.length > 0 ? eligible : ranked
    const rotated = []
    const span = Math.min(CANDIDATE_COUNT, pickFrom.length)
    for (let i = 0; i < span; i++) {
      rotated.push(pickFrom[(this.manualRotation + i) % pickFrom.length])
    }
    this.manualRotation = (this.manualRotation + span) % Math.max(1, pickFrom.length)
    this.saveState()

    const measured = await mapLimit(rotated, 12, async (item) => {
      const per = await mapLimit(addresses, addresses.length, (address) => this.probe.probeDomain(item.ip, address))
      const p95s = per.map((reading) => reading.p95).filter((value) => Number.isFinite(value))
      const p50s = per.map((reading) => reading.p50).filter((value) => value !== null && Number.isFinite(value))
      const samples = per.reduce((sum, reading) => sum + reading.n, 0)
      const timeouts = per.reduce((sum, reading) => sum + reading.timeouts, 0)
      const loss = samples > 0 ? (100 * timeouts) / samples : 100
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
        samples,
        timeouts,
        loss,
        broken: isBroken({ loss, timeouts, samples }),
        perDomain,
      }
    })

    // 与候选轮同一套分档排序：clean → ok → degraded，同档内按 p50、再按 p95。
    // 手动和自动必须用同一个函数，否则「点检测看到的顺序」和「自动切换的依据」
    // 会是两套逻辑——以前它们就是两段各自复制的排序代码。
    this.manualScan = sortCandidates(measured).map((item) => ({
      ...item,
      tier: tierOf(item),
      qualified: !item.broken,
    }))
    this.lastManualScanAt = Date.now()
    // 手动检测的结果**立刻成为当前候选**。
    //
    // 以前它只存进 manualScan，而 /apply 只有在 candidates 为空时才抄它；
    // 自动轮每 60s 都会把 candidates 填满，于是「点检测 → 点切换」用的几乎
    // 永远是上一轮自动淘汰的旧列表，实测会返回「无合格候选，未写入」。
    // 用户刚看过的那份数据必须就是他接下来切换所依据的数据。
    this.candidates = this.manualScan
    this.roundFinishedAt = Date.now()
    return { ok: true, cached: false, candidates: this.manualScan }
  }

  /**
   * 取消固定：删掉 hosts 里的 CLOUDFLARE-PIN 标记段，回退系统 DNS。
   *
   * 这是「所有候选都烂到不值得固定」时唯一真正的逃生口。以前插件里没有这个
   * 动作——一旦标记段钉住的 IP 全烂、又没有合格候选，用户在插件内既不能换
   * 也不能撤，只能去跑 cf_pin.py。
   *
   * 只动标记段：其余 hosts 内容一个字都不改（stripBlock 的语义）。
   * 不是切换，所以不计入 switchLog。
   *
   * @returns {Promise<{ ok: boolean, removed?: boolean, reason?: string }>}
   */
  async unpin() {
    try {
      const text = readHosts(this.hostsFile)
      const next = stripBlock(text)
      if (next === text) {
        this.reloadFromHosts()
        return { ok: true, removed: false, reason: 'hosts 里没有固定段' }
      }
      writeHosts(next, { file: this.hostsFile })
      flushDns()
      this.reloadFromHosts()
      this.lastSwitchDegraded = false
      // 取消固定是一次完全的重新开始：证书失败结论也一并清掉，
      // 否则「取消固定 → 再检测」会被上一次的旧结论挡住。
      this.certFailures.clear()
      this.lastSwitchCertNote = ''
      this.lastSwitchLossy = false
      this.decision = { write: false, reason: 'cold-start' }
      this.log('已取消固定：删除 hosts 标记段，回退系统 DNS')
      return { ok: true, removed: true }
    } catch (error) {
      return { ok: false, reason: `取消固定失败：${String(/** @type {any} */ (error)?.message ?? error)}` }
    }
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
    /**
     * 「更快候选」的展示口径必须与 `decide()` **完全同源**。
     *
     * 这个字段踩过两次坑，方向相反：
     *   1. 原实现只按 `qualified` 取第一条、忽略 `certFailures` → 界面推荐一条
     *      插件永远切不过去的线，也不解释为什么。
     *   2. 修第 1 条时只加了一道 cert 过滤，仍然只取 `qualified` → 而 `decide()`
     *      的规则是「没有合格候选就退到相对择优」。于是全部候选都在丢包时，
     *      `decision` 指向一条**这一拍就会写进 hosts** 的 IP，而这里返回 `null`，
     *      界面「更快候选」格显示「没有」。反过来又撒了一次谎。
     *
     * 所以不再在这里拼过滤条件：直接问 `selectBest()`——它和 `decide()` 用的是
     * 同一个函数，两边不可能再分叉。
     */
    const shownChoice = this.selectBest()
    const best = shownChoice === null ? null : shownChoice.best

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
        /** true = 这条在丢包（「断」），不是单纯慢。 */
        broken: item.broken === true,
        /**
         * 分档：clean / ok / degraded。级联降级唯一的外显证据——
         * 只看 p50 与 loss 反推不出来（「慢」和「断」在 p95 上是同一个数）。
         * 以前这里漏了它，于是「分档排序真的生效了吗」在快照上无法验证。
         */
        tier: item.tier,
        /** true = 已判定「证书不适配该域名」，不会参与判定与写入。 */
        certFailed: this.isCertFailed(item.ip),
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
      /**
       * 手动操作的公共状态。所有会话读同一份，所以「A 会话点了测速，
       * 切到 B 会话」看到的也是同一个测速中状态，不会一处在转一处空闲。
       *
       * phase 是给缓动/文案用的阶段：''（空闲）→ scan（扫描中）→ brake（收尾）
       * → write（写入中）→ ''。过期的阶段由 manualNow() 自动归零，客户端不需要
       * 自己算倒计时。
       */
      manual: this.manualNow(),
      /**
       * 全局首次拿到当前读数的时刻。客户端用它判断「该不该播落位动画」：
       * 只有 `now - firstReadingAt` 很短时才播，这样切会话不会重播。
       */
      firstReadingAt: this.firstReadingAt,
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
      /** 最近一次切换是不是全劣化下的「相对择优」（前端据此选文案）。 */
      lastSwitchDegraded: this.lastSwitchDegraded === true,
      /**
       * 最近一次写入是不是「丢包换延迟」（候选 p50 更低但丢包更高）。
       *
       * 用户已明确：这种情况仍然写入，但文案要如实说明。前端不能把「更差」
       * 说成「相对较好」——那正是「界面在撒谎」。
       */
      lastSwitchLossy: this.lastSwitchLossy === true,
      /** 最近一次写入跳过了哪些证书失败的 IP（人话，空串表示没跳过）。 */
      lastSwitchCertNote: this.lastSwitchCertNote ?? '',
      /** 当前被判定「证书不成立」而暂时跳过的 IP（诊断用）。 */
      certFailedIps: Array.from(this.certFailures.keys()).filter((ip) => this.isCertFailed(ip)),
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
    // need-admin 以前是**第一条**判断，于是普通用户永远只看得到「需要管理员权限」：
    // 冷启动、断网、全劣化这些真实状态全被它吞掉。用户看到的是一句
    // 与他此刻处境无关的话，而且会以为插件坏了。
    //
    // 权限只影响「能不能替你写 hosts」这一件事，所以它必须排在其他所有
    // 能解释现状的状态**之后**，只在「确实有一条更快的线、确实该切、只差权限」时
    // 才露出——那才是这句话真正要传达的信息。
    if (this.lastSwitch !== null && Date.now() - this.lastSwitch.at < 60_000) {
      // 刚切过：说清是常规切换，还是「全部偏慢、只能相对择优」的降级切换。
      return this.lastSwitchDegraded ? STATE.degradedSwitched : STATE.switched
    }
    if (this.current === null) return STATE.coldStart
    if (this.decision.reason === 'waiting-write') return STATE.waitingWrite
    if (this.probeFailed && this.candidates.length === 0) return STATE.offline
    if (this.decision.reason === 'degraded-switched') return STATE.degradedSwitched
    if (this.decision.reason === 'all-degraded') return STATE.allDegraded
    /**
     * `no-candidate` 必须排在下面那条「候选全部不合格」之前。
     *
     * 为什么（2026-10-30 修）：`decide()` 在候选被证书全判死时给的是
     * `reason: 'no-candidate'`，真实原因写在 `lastError` 里（「证书校验均未通过」）。
     * 但下面那条 `every(!qualified)` 的兜底会先命中，于是状态码变成
     * `all-degraded`，客户端据此说「当前线路偏慢，也没有更好的可选」——
     * 把「这些 IP 的证书不适配这个域名」渲染成「线路全都慢」，是两句完全不同的话，
     * 而且把用户往「换线路」而不是「查证书/域名」的方向带。
     *
     * 只证书判死但候选本身合格时，`state` 本来就落在 `no-candidate`（已验证），
     * 所以这个顺序只在「全证书失败 + 候选全部不合格」同时成立时才有区别。
     */
    if (this.decision.reason === 'no-candidate') return STATE.noCandidate
    if (this.candidates.length > 0 && this.candidates.every((item) => !item.qualified)) return STATE.allDegraded
    if (this.decision.reason === 'observing') return STATE.observing
    if (this.decision.reason === 'auto-off') return STATE.autoOff
    // 排到这里的 need-admin 只可能是 decide() 明确给出的（差距够了、只差权限）。
    //
    // 这里**不再**有「非管理员一律 need-admin」的兜底。那个兜底和上面第一条
    // 判断是同一个病：它会把 cold-start、观测中、正常这些与权限无关的状态
    // 全部改写成一句「需要管理员权限」。权限只决定能不能替你写 hosts，
    // 不该参与「现在链路怎么样」的叙述。
    if (this.decision.reason === 'need-admin') return STATE.needAdmin
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
