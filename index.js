/**
 * dsh-cf-pin — 宿主半。
 *
 * 常驻测量 open-design.ai 这条链路上的 Cloudflare 边缘 IP，链路劣化时自动改写
 * hosts 的优选段。这是 cf_pin.py 的常驻化版本：cf_pin.py 保留为手动逃生通道，
 * 插件不再重复做全量发现——IP 已经过多轮实测选好，插件只负责「判劣化 + 适时写入」。
 *
 * 对外只有一个契约：`/api/dsh-cf-pin/*` 的 POST 路由。
 * 浏览器半拿不到任何宿主对象，也不需要拿；它只读快照、只调动作。
 *
 * 数据目录：`$DSH_HOME/cf-pin-data/<profile>/`
 * （state.json + switches.log）。不放插件目录，因为 node_modules 升级会覆盖。
 *
 * @module @local/dsh-cf-pin
 */

import fs from 'node:fs'
import path from 'node:path'

import {
  Engine,
  STATE,
  defaultAddresses,
  defaultConfig,
  minRoundIntervalMin,
  resolveDataDir,
  roundDurationMs,
} from './lib/engine.js'
import { readPersistedConfig, writePersistedConfig } from './lib/config-store.js'

/** 数据目录内是否已有句柄（单实例判定的落点）。 */
const LOCK_FILE = 'engine.lock'

/** 所有路由共用的前缀。 */
const ROUTE_BASE = '/api/dsh-cf-pin'

/**
 * 插件入口。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Partial<import('./lib/types.js').PinConfig>} [rawConfig]
 */
export function apply(ctx, rawConfig) {
  const dataDir = resolveDataDir({ profileDir: profileDirOf(ctx) })
  // 三级优先级：面板存下来的 > patch 里写的 > 内置默认。
  // 面板改的值必须能活过重启，否则「每日上限」这类承诺会在重启后悄悄复原。
  const persisted = readPersistedConfig(dataDir)
  const config = normalizeConfig(persisted ?? rawConfig)

  /** @type {Engine | null} */
  let engine = null
  /** @type {(() => void)[]} */
  const disposers = []

  try {
    fs.mkdirSync(dataDir, { recursive: true })
  } catch (error) {
    ctx.logger?.warn?.(`cf-pin: 建数据目录失败 ${dataDir}：${message(error)}`)
  }

  const instance = new Engine({
    dataDir,
    config,
    log: (text) => ctx.logger?.info?.(`cf-pin: ${text}`),
  })
  engine = instance
  instance.loadState()
  instance.reloadFromHosts()

  ctx.logger?.info?.(
    `cf-pin: 已启动，数据目录 ${dataDir}，当前 IP ${instance.currentIps.join(', ') || '（未设置）'}，` +
    `权限 ${instance.admin ? '管理员' : '普通用户'}`,
  )

  // ---- 思考流计数：判定要写时若正有流在飞，就先记下、等流结束再写。
  // 探测本身不避让 —— 用户明确要求过这一点。
  try {
    ctx.on('llm/stream', (options, next) => {
      instance.streaming += 1
      const stream = next()
      return trackStream(stream, () => {
        instance.streaming = Math.max(0, instance.streaming - 1)
        if (instance.streaming === 0) void drainPending(instance)
      })
    })
  } catch (error) {
    ctx.logger?.warn?.(`cf-pin: 挂 llm/stream 失败：${message(error)}`)
  }

  // ---- 两条节奏。
  //
  // 用自排程的 setTimeout 而不是固定间隔的 setInterval：面板改探测间隔、
  // 改并发后必须**立刻**按新节奏跑，而 setInterval 的周期在创建时就固定了，
  // 只能靠重启插件来生效。自排程每轮重读一次 config，改完下一个周期就变。
  disposers.push(selfSchedule(ctx, () => Math.max(1_000, instance.config.currentProbeMs), async () => {
    await instance.sampleCurrent()
    instance.decide()
  }))

  // 启动后立刻采一次，不要让用户面对 6 秒空白。
  void instance.sampleCurrent().then(() => instance.decide())

  disposers.push(selfSchedule(
    ctx,
    () => Math.max(
      minRoundIntervalMin(instance.config.candidateConcurrency) * 60_000,
      instance.config.roundIntervalMin * 60_000,
    ),
    async () => { await instance.runCandidateRound() },
    // 首轮延后一点点：宿主刚启动时别和会话初始化抢链路。
    8_000,
  ))

  // ---- HTTP 路由
  ctx.inject(['connection'], (child) => {
    try {
      disposers.push(registerRoutes(child, engine, dataDir))
      child.logger?.info?.(`cf-pin: 已注册 ${ROUTE_BASE}/*`)
    } catch (error) {
      child.logger?.warn?.(`cf-pin: 注册路由失败：${message(error)}`)
    }
  })

  ctx.effect(() => () => {
    for (const dispose of disposers.splice(0)) {
      try { dispose() } catch { /* 卸载期失败无需处理 */ }
    }
    if (engine !== null) engine.disposed = true
  }, 'cf-pin: 定时器与路由')
}

/**
 * 判定为「等待写入」且流已经结束时，执行挂起的写入。
 *
 * @param {Engine} instance
 */
async function drainPending(instance) {
  if (instance.decision.pending !== true) return
  if (instance.decision.reason !== 'waiting-write') return
  instance.decision = { ...instance.decision, pending: false }
  const result = await instance.apply()
  if (result.ok) instance.decision = { write: false, reason: 'switched' }
  else instance.lastError = result.reason ?? '写入失败'
}

/**
 * 包一层异步迭代器，在流结束（正常/异常/取消）时回调一次。
 *
 * @template T
 * @param {AsyncIterable<T>} stream
 * @param {() => void} done
 * @returns {AsyncIterable<T>}
 */
function trackStream(stream, done) {
  return {
    [Symbol.asyncIterator]() {
      const iterator = stream[Symbol.asyncIterator]()
      let finished = false
      const finish = () => { if (!finished) { finished = true; done() } }
      return {
        async next() {
          try {
            const result = await iterator.next()
            if (result.done === true) finish()
            return result
          } catch (error) {
            finish()
            throw error
          }
        },
        async return(value) {
          finish()
          if (typeof iterator.return === 'function') return await iterator.return(value)
          return { done: true, value }
        },
        async throw(error) {
          finish()
          if (typeof iterator.throw === 'function') return await iterator.throw(error)
          throw error
        },
      }
    },
  }
}

/**
 * 注册浏览器半要用的路由。
 *
 * 用 connection.fetch 而不是自己起 server：浏览器发出的同源请求自带凭据，
 * 路由只在已认证的请求上分发。
 *
 * @param {any} ctx
 * @param {Engine} instance
 * @param {string} dataDir
 * @returns {() => void}
 */
function registerRoutes(ctx, instance, dataDir) {
  const connection = ctx.get?.('connection')
  if (connection === undefined || typeof connection.fetch?.register !== 'function') {
    return () => {}
  }

  /** @type {(() => Promise<void>)[]} */
  const disposers = []

  /**
   * @param {string} path
   * @param {(body: any) => Promise<Response> | Response} handler
   */
  const route = (path, handler) => {
    disposers.push(connection.fetch.register({
      path: ROUTE_BASE + path,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const body = await readBody(request)
        try {
          return await handler(body)
        } catch (error) {
          return json({ ok: false, error: { code: 'internal', message: message(error) } }, 500)
        }
      },
    }))
  }

  // 快照：唯一的状态来源。所有数字、状态码、派生读数都在这里。
  route('/state', async () => json({ ok: true, value: instance.snapshot() }))

  // 手动「检测」：完整 scan 语义。
  //
  // 用户明确要求：**所有由用户点击触发的操作都不许被拦截**。所以这里不再
  // 默认走缓存——以前 body 不带 rescan 就复用「这一轮已有的结果」，用户点了
  // 立即检测却拿到旧数据，看起来像按钮没生效。
  // 自动轮次仍然照常复用（它的入口不经过这个路由）。
  // 缓存只保留给显式要求复用的调用（rescan:false 且确实想要缓存）。
  route('/scan', async (body) => {
    const result = await instance.manualScanNow({ rescan: body?.rescan !== false })
    return json({ ok: result.ok, value: result, error: result.ok ? undefined : { code: 'scan', message: result.reason } })
  })

  // 手动「写入」：apply 语义，**永不禁用**，不受 autoWrite 影响。
  //
  // 用户明确要求：**所有由用户点击触发的操作都不许被拦截**。
  // 这里以前有两道拦截，现在都去掉了：
  //   a) 没有合格候选时要 body.confirm === true 才继续（needs-confirm）；
  //   b) 引擎里「当前已是最优」的三条件提前返回。
  // 用户按下按钮就是要它真的执行一次。挡回去只会让他以为按钮坏了。
  // 真正的安全边界不在这些确认框上，而在证书闸门与 hosts 写入本身。
  route('/apply', async (body) => {
    if (instance.manualScan !== null && instance.candidates.length === 0) {
      instance.candidates = instance.manualScan
    }
    // forced:true → 引擎跳过「当前已是最优」的拦截（这个参数以前只控制日志，
    // 根本没参与判断，所以传了也没用；现在它真的生效了）。
    const result = await instance.apply({ forced: true })
    return json({
      ok: result.ok,
      value: result,
      error: result.ok ? undefined : { code: 'apply', message: result.reason },
    })
  })

  // 保存配置。面板里改的每一项都走这里，并**立刻落盘**。
  route('/config', async (body) => {
    const next = normalizeConfig({ ...instance.config, ...(body?.config ?? {}) })
    instance.config = next
    instance.decide()
    const saved = writePersistedConfig(dataDir, next)
    return json({
      ok: true,
      value: { config: instance.config, derived: instance.snapshot().derived, saved },
    })
  })

  // 探测地址增删勾选。
  route('/addresses', async (body) => {
    const list = Array.isArray(body?.addresses) ? body.addresses : instance.config.addresses
    instance.config = { ...instance.config, addresses: normalizeAddresses(list) }
    instance.decide()
    const saved = writePersistedConfig(dataDir, instance.config)
    return json({ ok: true, value: { addresses: instance.config.addresses, saved } })
  })

  // 恢复默认地址列表。单独一个端点：地址写错会让所有状态都变成「探测没测成」，
  // 用户根本猜不到原因，所以它必须能独立恢复，不该被绑在全局 reset 上。
  route('/addresses/reset', async () => {
    instance.config = { ...instance.config, addresses: defaultAddresses() }
    instance.decide()
    const saved = writePersistedConfig(dataDir, instance.config)
    return json({ ok: true, value: { addresses: instance.config.addresses, saved } })
  })

  // 恢复默认。**只重置配置，不动 hosts**：用户点「恢复默认」不该顺手改他的机器。
  route('/reset', async () => {
    instance.config = normalizeConfig(defaultConfig())
    const saved = writePersistedConfig(dataDir, instance.config)
    return json({ ok: true, value: { config: instance.config, derived: instance.snapshot().derived, saved } })
  })

  // 打开数据目录（诊断用）。
  route('/reveal', async () => json({
    ok: true,
    value: {
      dataDir,
      state: path.join(dataDir, 'state.json'),
      hosts: instance.hostsFilePath(),
      roundDurationMs: roundDurationMs(instance.config.candidateConcurrency),
    },
  }))

  return () => {
    for (const dispose of disposers) {
      try { void dispose() } catch { /* 卸载期失败无需处理 */ }
    }
  }
}

/**
 * 归一化配置：补默认值、夹住范围、校正并发与轮间隔的联动。
 *
 * 「并发 → 一轮时长」是派生读数，不是一个独立配置项，所以这里必须保证
 * roundIntervalMin 永远不小于由并发推导出的下限——否则两轮会重叠。
 *
 * @param {Partial<import('./lib/types.js').PinConfig> | undefined} raw
 * @returns {import('./lib/types.js').PinConfig}
 */
function normalizeConfig(raw) {
  const base = defaultConfig()
  const source = raw ?? {}
  const concurrency = clamp(Number(source.candidateConcurrency ?? base.candidateConcurrency), 1, 12)
  const config = {
    autoWrite: source.autoWrite === true,
    currentProbeMs: clamp(Number(source.currentProbeMs ?? base.currentProbeMs), 1_000, 60_000),
    candidateConcurrency: concurrency,
    // 候选轮间隔**不再从输入取值**：它完全由并发数推导，用户改不了。
    // 以前是「可配置但有下限」，用户能把间隔调大却没有理由——调大只会让
    // 发现变慢，而调小于下限又会被静默抬回去。既然是推导值，就不该出现在
    // 配置输入里。旧配置里存的 roundIntervalMin 会被这一行直接覆盖。
    roundIntervalMin: minRoundIntervalMin(concurrency),
    switchThresholdMs: clamp(Number(source.switchThresholdMs ?? base.switchThresholdMs), 0, 5_000),
    // 每日上限是「我们承诺不折腾你的机器」的证据；默认 48 次，
    // 但用户可以往下调（0 次即只测量、不自动切）。
    maxSwitchesPerDay: clamp(Number(source.maxSwitchesPerDay ?? base.maxSwitchesPerDay), 1, 48),
    probeWhileThinking: source.probeWhileThinking === true,
    skin: normalizeSkin(source.skin ?? base.skin),
    addresses: normalizeAddresses(source.addresses ?? defaultAddresses()),
  }
  return config
}

/**
 * 横幅图标的皮肤。白名单之外的任何值都退回 ring——
 * 配置写坏时宁可显示默认皮肤，也不要让横幅整块消失。
 * 三格点阵（fan）已删除：旧配置里若残留 'fan'，这里会把它迁到 'ring'。
 *
 * @param {unknown} raw
 * @returns {import('./lib/types.js').SkinId}
 */
function normalizeSkin(raw) {
  return raw === 'taiji' ? 'taiji' : 'ring'
}

/**
 * @param {unknown} raw
 * @returns {import('./lib/types.js').ProbeAddress[]}
 */
function normalizeAddresses(raw) {
  if (!Array.isArray(raw)) return defaultAddresses()
  const out = []
  for (const item of raw) {
    if (typeof item === 'string') {
      const address = item.trim()
      if (address.length > 0) out.push({ address, enabled: true })
      continue
    }
    if (item === null || typeof item !== 'object') continue
    const address = String(/** @type {any} */ (item).address ?? '').trim()
    if (address.length === 0) continue
    if (out.some((entry) => entry.address === address)) continue
    out.push({ address, enabled: /** @type {any} */ (item).enabled !== false })
  }
  return out.length > 0 ? out : defaultAddresses()
}

/** @param {number} value @param {number} min @param {number} max */
function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.round(value)))
}

/**
 * 统一 JSON 响应。
 * @param {unknown} payload
 * @param {number} [status]
 * @returns {Response}
 */
function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/** @param {Request} request */
async function readBody(request) {
  try {
    const text = await request.text()
    if (text.trim().length === 0) return {}
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** @param {unknown} error */
function message(error) {
  return String(/** @type {any} */ (error)?.message ?? error)
}

/**
 * 自排程的周期任务：每轮结束后按**当下**的 delay 重排下一次。
 *
 * 与 setInterval 的差别是它能响应运行期的配置变化——面板把探测间隔从 6s 改成 3s，
 * 下一个周期就用 3s，不需要重启插件。
 *
 * @param {any} ctx
 * @param {() => number} delayOf 每次排程时重新求值
 * @param {() => Promise<void>} run
 * @param {number} [initialDelay] 首轮延迟；省略时等于 delayOf()
 * @returns {() => void}
 */
function selfSchedule(ctx, delayOf, run, initialDelay) {
  let stopped = false
  let cancel = () => {}

  const arm = (delayMs) => {
    if (stopped) return
    cancel = after(ctx, () => {
      if (stopped) return
      void Promise.resolve()
        .then(run)
        .catch((error) => ctx.logger?.warn?.(`cf-pin: 周期任务失败：${message(error)}`))
        .finally(() => { arm(Math.max(1_000, delayOf())) })
    }, delayMs)
  }

  arm(initialDelay ?? Math.max(1_000, delayOf()))
  return () => { stopped = true; cancel() }
}

/**
 * 一个随插件卸载自动清掉的定时器。
 *
 * 优先用 ctx.timer.timeout（宿主提供的可弃置定时器），拿不到时退回原生
 * setTimeout 并由调用方负责清理——两条路都返回清理函数，调用方只看一个契约。
 *
 * @param {any} ctx
 * @param {() => void} callback
 * @param {number} delayMs
 * @returns {() => void}
 */
function after(ctx, callback, delayMs) {
  try {
    if (typeof ctx.timer?.timeout === 'function') {
      const dispose = ctx.timer.timeout(callback, delayMs)
      return typeof dispose === 'function' ? dispose : () => {}
    }
  } catch { /* 退回原生定时器 */ }
  const handle = setTimeout(callback, delayMs)
  return () => clearTimeout(handle)
}

/**
 * 宿主给出的 profile 目录（最可靠的 profile 来源）。
 *
 * @param {any} ctx
 * @returns {string | undefined}
 */
function profileDirOf(ctx) {
  try {
    const context = ctx.get?.('profileContext')
    if (typeof context?.dir === 'string' && context.dir.length > 0) return context.dir
  } catch { /* 拿不到就退回环境变量 */ }
  return undefined
}

export { STATE }
export { LOCK_FILE }
