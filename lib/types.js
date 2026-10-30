/**
 * 插件内部类型（JSDoc）。纯注释文件，运行时不导出任何值。
 *
 * 这些 typedef 是快照契约的**唯一书面定义**：`snapshot()` 发出去的每个字段
 * 都应该在这里出现。改了 engine.js 的 snapshot() 就回来同步，否则类型与
 * 实现会悄悄分叉（轮 4 的 `manual` / `firstReadingAt` 就这么漏过一次）。
 */

/**
 * @typedef {object} ProbeAddress
 * @property {string} address 探测地址（域名）
 * @property {boolean} enabled 是否参与探测 / cert_ok / 写入
 */

/**
 * @typedef {'ring-core' | 'afterglow'} SkinId
 */

/**
 * @typedef {object} PinConfig
 * @property {boolean} autoWrite          判定成立时是否真的写 hosts
 * @property {boolean} showUi             是否在输入框显示图标（关掉后完全隐身）
 * @property {number} currentProbeMs      当前 IP 采样间隔
 * @property {number} candidateConcurrency 候选轮并发（决定一轮时长）
 * @property {number} roundIntervalMin    候选轮间隔（分钟）
 * @property {number} switchThresholdMs   判定的最小优势
 * @property {boolean} probeWhileThinking 有思考流在飞时是否继续探测
 * @property {SkinId} skin                横幅图标皮肤
 * @property {ProbeAddress[]} addresses   探测地址列表
 */

/**
 * @typedef {object} CurrentReading
 * @property {string} ip
 * @property {string} address
 * @property {number | null} p50
 * @property {number} p95
 * @property {number} loss
 * @property {number} samples
 * @property {number} at
 * @property {number} durationMs
 * @property {boolean} reliable
 */

/**
 * @typedef {object} CandidateReading
 * @property {string} ip
 * @property {string | null} colo
 * @property {number} p50
 * @property {number} p95
 * @property {number} samples
 * @property {number} timeouts
 * @property {number} loss                 丢包率（0-100），超时/丢包口径
 * @property {boolean} broken              true = 在丢包（「断」）；false 只是「慢」
 * @property {boolean} qualified          == !broken（保留旧字段名给前端）
 * @property {'clean' | 'ok' | 'degraded'} [tier]
 *   分档。级联降级按它走，**不按 p95 的数值**——超时记 999，但成功样本也能 >999，
 *   所以「是否超时」只能看 timeouts（见 probe.tierOf）。
 * @property {Record<string, { p50: number | null, p95: number, loss: number, n: number }>} perDomain
 */

/**
 * @typedef {object} Decision
 * @property {boolean} write
 * @property {string} reason
 * @property {string} [candidateIp]
 * @property {number} [advantage]
 * @property {boolean} [pending]
 * @property {boolean} [degraded]          全劣化下的相对择优
 */

/**
 * @typedef {'cold-start' | 'normal' | 'switched' | 'degraded-switched' | 'observing' | 'waiting-write' | 'no-candidate' | 'all-degraded' | 'offline' | 'probe-failed' | 'need-admin'} StateCode
 */

/**
 * @typedef {object} Snapshot
 * @property {StateCode} state
 * @property {boolean} admin
 * @property {boolean} autoWrite
 * @property {CurrentReading | null} current
 * @property {Array<{ ip: string, colo: string | null, p50: number, p95: number, qualified: boolean, broken: boolean, tier: 'clean' | 'ok' | 'degraded', certFailed: boolean, samples: number, timeouts: number }>} candidates
 *   顺序由 `probe.sortCandidates` 保证：档位（clean → ok → degraded）→ loss → p50 → p95。
 *   `tier` 与 `certFailed` 是「分档降级」与「证书闸门」两件事唯一的外显证据：
 *   少了它们，快照只能靠 p50/loss 反推，而 p95 的数值分不出「断」与「慢」。
 * @property {{ ip: string, p50: number, p95: number, colo: string | null } | null} best
 *   与 `decide()` 用同一套过滤：已判 `certFailed` 的候选不会出现在这里——
 *   否则界面会推荐一条插件永远切不过去的线路。
 * @property {boolean} bestBorrowed 候选读数是否借用自当前值（还没测过候选）
 * @property {Decision} decision
 * @property {number} streaming 正在飞的思考流数量（界面据此表达流式状态）
 * @property {number | null} advantageMs 当前 p50 − 候选最优 p50（毫秒，负值表示候选更慢）
 * @property {number} thresholdMs 判定的最小优势（界面用它解释「差多少才算够」）
 * @property {{ running: boolean, startedAt: number, finishedAt: number, durationMs: number, intervalMin: number }} round
 * @property {{ at: number, ips: string[] } | null} lastSwitch
 * @property {boolean} lastSwitchDegraded 最近一次切换是不是全劣化下的相对择优
 * @property {boolean} lastSwitchLossy
 *   最近一次写入是不是「丢包换延迟」（候选 p50 更低但丢包更高）。
 *   用户已明确：这种情况仍然写入，但文案必须如实说明。
 * @property {string} lastSwitchCertNote 最近一次写入跳过了哪些证书失败的 IP（空串 = 没跳过）
 * @property {string[]} certFailedIps 当前被判「证书不成立」而暂时跳过的 IP
 * @property {PinConfig} config
 * @property {{ roundDurationMs: number, minRoundIntervalMin: number, slotMs: number, windowMs: number, candidateCount: number }} derived
 * @property {{ path: string, currentIps: string[], currentDomains: string[] }} hosts
 * @property {string | null} lastError
 * @property {boolean} probeFailed
 * @property {number} now
 * @property {ManualState} manual 手动操作的公共状态（跨会话一致）
 * @property {number} firstReadingAt 全局首次拿到当前读数的时刻（0 = 还没拿到）
 */

/**
 * 手动操作的公共状态。经 `snapshot.manual` 广播给**所有**会话，所以「A 会话
 * 点了测速、切到 B 会话」看到的是同一份阶段，不会一处在转一处空闲。
 *
 * phase 的四个取值：
 *   ''      空闲（含「刚结束、文案还在存活期」）
 *   'scan'  扫描中
 *   'brake' 扫描完成、客户端正在播 1400ms 收尾动画（引擎侧只是保持「忙」）
 *   'write' 写入中
 *
 * `busy` 是 `phase !== '' && 未超时` 的结果，客户端只该读它做禁用判断，
 * 别自己去拼 phase 组合。
 *
 * `note` 的来源分两种，客户端不需要区分（都是给人看的一句话）：
 *   - 忙碌时 = 当前进度的说明（「测速中…」「写入中…」），跟阶段走；
 *   - 空闲时 = **上一次操作的结果**（「已切到 …」「写入失败」），受
 *     `MANUAL_NOTE_MS` 存活期约束。
 * 引擎内部把它们存在两格（`manual.note` / `manualResult`），因为两个路由会
 * 并发写：曾经共用一格，于是「先点检测、再点切换」时切换结果被「测速完成」
 * 覆盖，用户永远看不到。`note` 在这里是**投影后的合并视图**。
 *
 * @typedef {object} ManualState
 * @property {string} phase
 * @property {number} startedAt 本次手动流程开始时刻（切阶段不重置，客户端算耗时用它）
 * @property {string} note      面向用户的一句话：忙碌时是进度，空闲时是上一次的结果
 * @property {boolean} busy
 */

/**
 * @typedef {object} ScanResult
 * @property {boolean} ok
 * @property {boolean} [cached]   true = 没有真的扫，复用了上一次的结果
 * @property {string} [reason]    ok=false 时的原因
 * @property {CandidateReading[]} [candidates]
 */

/**
 * @typedef {object} ApplyResult
 * @property {boolean} ok
 * @property {string} [reason]
 * @property {string[]} [ips]
 * @property {string} [mode]
 * @property {boolean} [degraded]          写入的是「最不坏」的候选，不是合格候选
 * @property {boolean} [lossy]             写入的候选丢包率比当前线路更高（文案要如实说）
 * @property {boolean} [certUnverified]    闸门遇到链路问题，这个 IP 的证书未能确认
 * @property {string[]} [certRejected]     因真证书问题被跳过的 IP
 * @property {string} [note]               给用户看的一句话补充（如「已跳过 X」）
 * @property {boolean} [alreadyOptimal]
 * @property {boolean} [merged]            并发调用时合并到了别人那一发
 */

export {}
