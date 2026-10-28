/**
 * 插件内部类型（JSDoc）。

/**
 * @typedef {object} ProbeAddress
 * @property {string} address 探测地址（域名）
 * @property {boolean} enabled 是否参与探测 / cert_ok / 写入
 */

/**
 * @typedef {'ring' | 'taiji'} SkinId
 */

/**
 * @typedef {object} PinConfig
 * @property {boolean} autoWrite          判定成立时是否真的写 hosts
 * @property {number} currentProbeMs      当前 IP 采样间隔
 * @property {number} candidateConcurrency 候选轮并发（决定一轮时长）
 * @property {number} roundIntervalMin    候选轮间隔（分钟）
 * @property {number} switchThresholdMs   判定的最小优势
 * @property {number} maxSwitchesPerDay   24h 自动切换上限
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
 * @property {boolean} qualified
 * @property {Record<string, { p50: number | null, p95: number, loss: number, n: number }>} perDomain
 */

/**
 * @typedef {object} Decision
 * @property {boolean} write
 * @property {string} reason
 * @property {string} [candidateIp]
 * @property {number} [advantage]
 * @property {boolean} [pending]
 */

/**
 * @typedef {'cold-start' | 'normal' | 'switched' | 'observing' | 'waiting-write' | 'no-candidate' | 'all-degraded' | 'offline' | 'probe-failed' | 'daily-limit' | 'need-admin'} StateCode
 */

/**
 * @typedef {object} Snapshot
 * @property {StateCode} state
 * @property {boolean} admin
 * @property {boolean} autoWrite
 * @property {CurrentReading | null} current
 * @property {Array<{ ip: string, colo: string | null, p50: number, p95: number, qualified: boolean, samples: number, timeouts: number }>} candidates
 * @property {{ ip: string, p50: number, p95: number, colo: string | null } | null} best
 * @property {boolean} bestBorrowed 候选读数是否借用自当前值（还没测过候选）
 * @property {Decision} decision
 * @property {{ running: boolean, startedAt: number, finishedAt: number, durationMs: number, intervalMin: number }} round
 * @property {{ at: number, ips: string[] } | null} lastSwitch
 * @property {number} switchesToday
 * @property {PinConfig} config
 * @property {{ roundDurationMs: number, minRoundIntervalMin: number, slotMs: number, windowMs: number, candidateCount: number }} derived
 * @property {{ path: string, currentIps: string[], currentDomains: string[] }} hosts
 * @property {string | null} lastError
 * @property {boolean} probeFailed
 * @property {number} now
 */

/**
 * @typedef {object} ApplyResult
 * @property {boolean} ok
 * @property {string} [reason]
 * @property {string[]} [ips]
 * @property {string} [mode]
 */

export {}
