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
  // 面板改的值必须能活过重启，否则面板上的承诺会在重启后悄悄复原。
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
  // 探测是否避让由 probeWhileThinking 决定（见下面的采样节奏）。
  try {
    ctx.on('llm/stream', (options, next) => {
      instance.streaming += 1
      let stream
      try {
        stream = next()
      } catch (error) {
        // next() 同步抛错时，上面已经 +1，却永远不会有流结束事件来 -1。
        // 计数一旦泄漏，instance.streaming 永久 >0：判定永远走 waiting-write，
        // 自动切换彻底失效，界面的「正在生成」也会一直亮着。必须在这里回滚。
        instance.streaming = Math.max(0, instance.streaming - 1)
        throw error
      }
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
    // probeWhileThinking=false 时，思考流在飞就先跳过这一拍，等流结束后的下一拍再补测。
    // 这个开关以前只被存进配置、再被界面读出来画成开关，引擎里一次都没读过——
    // 是个纯装饰的假开关。现在它是真的接线点。
    if (!instance.config.probeWhileThinking && instance.streaming > 0) return
    await instance.sampleCurrent()
    // decide() 只写结论，decideAndApply() 才会真的执行它。空闲时判出的切换
    // 以前没有任何执行者，所以自动切换只在流式期间才偶尔生效。
    await instance.decideAndApply()
  }))

  // 启动后立刻采一次，不要让用户面对 6 秒空白。
  void instance.sampleCurrent().then(() => instance.decideAndApply()).catch(() => {})

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
  // 用 decideAndApply 而不是裸 apply()：apply() 不重新判定，若这期间当前链路
  // 已经自己变快了（或候选过期了），它会照着一个过时的结论去改 hosts。
  // 重新判一次，只在结论仍然成立时才写。
  if (instance.applying) return
  await instance.decideAndApply()
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
  /** 手动流程里的短定时器（brake 收尾）。统一记着，插件卸载时清掉。 */
  const autoBrakeTimers = /** @type {ReturnType<typeof setTimeout>[]} */ ([])

  /**
   * 起一个 brake 收尾定时器，并在它自己触发后把自己从表里摘掉。
   *
   * 原实现只 `push` 从不移除，于是每点一次「立即检测」就永久多留一个已经
   * fire 过的句柄，只有插件卸载时才清理——长会话里是缓慢而无意义的增长。
   */
  const armBrakeTimer = () => {
    /** @type {ReturnType<typeof setTimeout>} */
    let timer
    timer = setTimeout(() => {
      const at = autoBrakeTimers.indexOf(timer)
      if (at !== -1) autoBrakeTimers.splice(at, 1)
      // 先判阶段仍是 brake 才清：期间若 /apply 已把阶段改成 write，
      // 这里什么都不做，不能把「写入中」清成空闲。
      // 只清阶段，**不碰结果文案**——结果由 /apply 的 finishManualWrite 写，
      // 并受自己的存活期约束（见 engine.setManualPhase 的注释）。
      if (instance.manual.phase === 'brake') instance.setManualPhase('')
    }, 1400)
    autoBrakeTimers.push(timer)
  }

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
    // 手动操作的状态由引擎持有，经 /state 广播给**所有**会话。这样 A 会话点测速、
    // 切到 B 会话时 B 也显示测速中；而 B 不会因为自己没点过就以为空闲。
    //
    // 开一次新操作时把**上一次的结果文案**清掉：结果与阶段是两格（见
    // `setManualPhase` 的注释），不清的话「已切到 X」会挂在新一轮的「测速中…」后面。
    instance.setManualResult('')
    instance.setManualPhase('scan', '测速中…')
    try {
      const result = await instance.manualScanNow({ rescan: body?.rescan !== false })
      // 扫描结束后进 brake：收尾动画是客户端播的，但「还在忙」这件事必须由引擎
      // 表达，否则两个请求之间会闪一下空闲，切会话时尤其明显。
      // 覆盖动画时长即可；期间若 /apply 先到，会被 write 直接覆盖掉，
      // 这个定时器看到 phase 已变就什么都不做（不会把写入中的状态清掉）。
      //
      // 合并到别人那一次扫描时（merged）阶段收尾由原请求负责：这里再设一次
      // brake 只会把已经开始计的 1400ms 重置，等于收尾动画被拉长。
      if (result?.merged !== true) {
        instance.setManualPhase('brake', '测速完成')
        instance.setManualResult(result?.ok === true ? '测速完成' : '测速失败')
        armBrakeTimer()
      }
      return json({ ok: result.ok, value: result, error: result.ok ? undefined : { code: 'scan', message: result.reason } })
    } catch (error) {
      instance.setManualPhase('')
      instance.setManualResult('测速失败')
      throw error
    }
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
    // forced:true → 引擎跳过「当前已是最优」的拦截（这个参数以前只控制日志，
    // 根本没参与判断，所以传了也没用；现在它真的生效了）。
    // 全劣化时 apply() 会降级写「最不坏」的候选并返回 degraded:true，
    // 不再返回「无合格候选，未写入」——用户按下的按钮必须真的动一次。
    //
    // 阶段状态同样写进引擎：写入可能持续数秒（证书闸门要连好几次），
    // 期间任何会话切过来都应该看到「写入中」，而不是先看到空闲再突然跳变。
    instance.setManualResult('')
    instance.setManualPhase('write', '写入中…')
    try {
      const result = await instance.apply({ forced: true })
      // 收尾**无条件执行**，包括 merged 的情况。
      //
      // 原实现把收尾挂在 `result.merged !== true` 上，理由是「让先到的那个说了算」。
      // 但 `merged` 只说明「并进了别人那一发」——那一发**不一定是另一次手动 /apply**，
      // 也可能是自动路径：`runCandidateRoundOnce` 末尾的 `decideAndApply()`、
      // 或思考流结束时的 `drainPending()`。自动路径从不管理 manual 阶段，
      // 于是这次手动写入的 `write` 阶段没人收尾，只能等 `MANUAL_TTL_MS`（90 秒）
      // 自己过期。实测症状：这 90 秒里图标一直是「写入中…」、配置页三个按钮全灰，
      // 而且不会再有任何请求来纠正它——用户以为卡死了。
      //
      // 收尾逻辑放在引擎里（`finishManualWrite`），因为阶段状态是引擎持有的；
      // 放在路由里就只能靠读源码确认，测不到。它自己会判「阶段是否仍是 write」。
      instance.finishManualWrite(result)
      return json({
        ok: result.ok,
        value: result,
        error: result.ok ? undefined : { code: 'apply', message: result.reason },
      })
    } catch (error) {
      instance.finishManualWrite(null)
      throw error
    }
  })

  // 取消固定：删掉 hosts 标记段，回退系统 DNS。
  //
  // 这是「所有候选都烂到不值得固定」时唯一的逃生口：没有它，一旦标记段钉住的
  // IP 全烂、又没有合格候选，用户在插件内既不能换也不能撤。
  route('/unpin', async () => {
    const result = await instance.unpin()
    return json({
      ok: result.ok,
      value: result,
      error: result.ok ? undefined : { code: 'unpin', message: result.reason },
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
    for (const timer of autoBrakeTimers.splice(0)) clearTimeout(timer)
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
    // 默认显示。只有显式写成 false 才关掉——配置缺失时应保持可见。
    showUi: source.showUi !== false,
    currentProbeMs: clamp(Number(source.currentProbeMs ?? base.currentProbeMs), 1_000, 60_000),
    candidateConcurrency: concurrency,
    // 候选轮间隔**不再从输入取值**：它完全由并发数推导，用户改不了。
    // 以前是「可配置但有下限」，用户能把间隔调大却没有理由——调大只会让
    // 发现变慢，而调小于下限又会被静默抬回去。既然是推导值，就不该出现在
    // 配置输入里。旧配置里存的 roundIntervalMin 会被这一行直接覆盖。
    roundIntervalMin: minRoundIntervalMin(concurrency),
    switchThresholdMs: clamp(Number(source.switchThresholdMs ?? base.switchThresholdMs), 0, 5_000),
    // 每日切换上限已整体删除（2026-10-28 用户要求）。旧 config.json 里残留的
    // maxSwitchesPerDay 字段会被这里自然忽略、并在下一次保存配置时清掉——
    // 刻意不做「读到就当成新语义」的兼容，因为它已经没有任何语义了。
    probeWhileThinking: source.probeWhileThinking === true,
    skin: normalizeSkin(source.skin ?? base.skin),
    addresses: normalizeAddresses(source.addresses ?? defaultAddresses()),
  }
  return config
}

/**
 * 横幅图标的皮肤。白名单之外的任何值都退回 ring-core——
 * 配置写坏时宁可显示默认皮肤，也不要让横幅整块消失。
 * 旧 id（ring / taiji / fan）已废弃：前两代实现连画法一起删掉了，
 * 这里统一迁到第一个新皮肤。
 *
 * @param {unknown} raw
 * @returns {import('./lib/types.js').SkinId}
 */
function normalizeSkin(raw) {
  return raw === 'afterglow' ? 'afterglow' : 'ring-core'
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

