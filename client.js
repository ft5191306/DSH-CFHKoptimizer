/**
 * dsh-cf-pin — 浏览器半。
 *
 * 两个挂载点：
 *  - conversation.input.dock：composer 左上角一枚三格指示器，无文字、不可展开。
 *    当前延迟 / 候选延迟 / 流式状态各自只用形状、长度、纹理和动效表达。
 *  - plugins.row.config：出问题时才打开的配置页，三层语气（只读诊断 / 决定 /
 *    高级折叠）。文字都在这里，横幅里一个都不放。
 *
 * 状态一律以 /state 快照为准，前端不拼状态。
 *
 * 视觉纪律（已随「一颗图标读两侧」定稿）：
 *  - 形状读两侧延迟：左半 / 实心 = 当前线路，右半 / 空心 = 候选线路；
 *    辐条按点亮圈数读速度，太极按边缘侵蚀读延迟，颜色只做第二通道；
 *  - 没有数据就是空轨 / 最小侵蚀，不做假读数；
 *  - 动效各代表一个真事件，一个都不能是装饰：待机慢转（还活着）、
 *    抖动分档（更差的那侧有多差）、测速旋转→刹车 360° 整数倍（在测）、
 *    换线亮条横扫 + 180° 急转（刚换了 IP）、流式呼吸（模型正在输出）、
 *    结束扩散环（回复收尾）、受阻慢呼吸（要你动手）；
 *  - `prefers-reduced-motion` 下所有位移与循环动画停掉，只留状态色与形状。
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-cf-pin',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useReducer, useRef } = React

    const POLL_MS = 4000
    const FLASH_MS = 320
    /**
     * 换线动画在屏幕上停留的时长。
     *
     * UI-SPEC 4.2 定的是一次性换线 **1500ms**，两套皮肤的 CSS 也照这个写的
     * （环芯末点 300ms 延迟 + 1200ms 动画；余温四条轨道都是 1.5s）。
     * 这里原先是 640——只有 43% 的动画能播完，用户看到的是「吸到一半就没了」。
     * 取值必须 ≥ 动画总长，多出的 60ms 只是收尾余量。
     */
    const SWAP_MS = 1560
    /** 落位动画本身的时长（环芯末点 280+200=480ms，留一点余量）。 */
    const ARRIVE_MS = 520
    /**
     * 判「全局首读刚发生」的窗口。
     *
     * 落位动画只在引擎第一次拿到当前读数后的这个窗口内播。窗口必须比一次轮询
     * 周期（4s）宽，否则刚启动的会话可能刚好错过它；又必须够短，否则几十秒后
     * 新开的会话还会误以为「图标刚出现」而重播。
     */
    const ARRIVE_WINDOW_MS = 8000
    /** 本包名。详情页的 slot 会为所有插件派发，门禁要靠它认自己。 */
    const PACKAGE_NAME = '@local/dsh-cf-pin'

    /**
     * 宿主调用。路径、方法、错误形状都由宿主定，这里只做「非 ok 即抛」。
     *
     * @param {string} path
     * @param {object} [body]
     * @returns {Promise<any>}
     */
    async function call(path, body) {
      /**
       * 必须有超时。没有它的时候，宿主路由一旦挂住（连接没建立、或 fetch
       * 注册之后走了别的路径），调用方的 `finally { setBusyAction('') }`
       * 永远不会执行 —— 配置页三个按钮会**永久 disabled**，用户只能刷新页面。
       * 引擎侧有 MANUAL_TTL_MS 兜底，配置页这一侧以前没有任何兜底。
       *
       * 120s 足够覆盖最慢的一次 /scan（256 次粗筛 + 12×地址×20s 采样），
       * 又不至于让用户对着不动的按钮等太久。
       */
      const response = await fetch('/api/dsh-cf-pin/' + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(120_000),
      })
      const payload = await response.json()
      if (payload === null || typeof payload !== 'object' || payload.ok !== true) {
        const failure = new Error(payload?.error?.message ?? ('HTTP ' + response.status))
        if (typeof payload?.error?.code === 'string') failure.code = payload.error.code
        throw failure
      }
      return payload.value
    }

    // ---------------------------------------------------------------- 文案

    /**
     * 状态码 → 一行话。文字是主通道，颜色只是辅助，所以每条都必须自己说清楚。
     * 文案里不出现 IP、阈值、p95 这类内部概念。
     */
    const COPY = {
      'cold-start': { text: '正在测量链路…', tone: 'idle' },
      normal: { text: '链路正常', tone: 'ok' },
      switched: { text: '已切换到更快的线路', tone: 'ok' },
      /**
       * 全劣化下的「相对择优」写入。
       *
       * 这里不能复用 switched 的「更快的线路」——没有一条是健康的，写进去的
       * 只是其中丢包相对少、延迟相对低的一条。说成常规切换会让用户以为
       * 链路已经恢复，下次再卡时就会怀疑插件在乱写。
       */
      'degraded-switched': { text: '全部线路偏慢，已切到相对较好的一条', tone: 'warn' },
      observing: { text: '不用处理 · 有更快的线路，但差距不够', tone: 'idle' },
      'auto-off': { text: '有更快的线路，但自动切换是关的', tone: 'idle' },
      'waiting-write': { text: '有更快的线路，等这条回复结束就切', tone: 'work' },
      'no-candidate': { text: '没有更好的线路，继续用当前的', tone: 'idle' },
      'all-degraded': { text: '当前线路偏慢，也没有更好的可选', tone: 'warn' },
      offline: { text: '网络连不上，暂停检测', tone: 'idle' },
      'probe-failed': { text: '这一轮没测到数据，稍后自动重试', tone: 'idle' },
      'need-admin': { text: '找到了更快的线路，但需要管理员权限才能切换', tone: 'warn' },
    }
    const UNKNOWN = { text: '链路状态未知', tone: 'idle' }

    function copyOf(state) {
      return COPY[state] ?? UNKNOWN
    }

    /**
     * 第三格「流式」的状态。
     *
     * 数据源有两条，按可靠性排序：
     *   1. `snapshot.streaming` —— 宿主在快照里给的「正在飞的思考流数量」。
     *      这是权威信号：它统计的是真实的 llm/stream 在飞计数，包括工具调用期间。
     *   2. `waiting-write` 状态 —— 只在「判定要写但流还没结束」那一刻为真，
     *      是 1 的子集，覆盖不了「正在正常输出」。
     *
     * 原来的实现只读 `props.streaming`（dock 并不传这个 prop）和 `waiting-write`，
     * 于是模型正常输出时第三格一直是闲置点——正是该亮的时候不亮。
     */
    function streamOf(snapshot, props) {
      if (typeof snapshot?.streaming === 'number' && snapshot.streaming > 0) return 'stream'
      if (props && (props.streaming === true || props.busy === true)) return 'stream'
      return snapshot?.state === 'waiting-write' ? 'stream' : 'idle'
    }

    /** 换线被挡住的情形：候选格不闪作「可以挪」，改成慢呼吸。 */
    function holdOf(state) {
      if (state === 'need-admin') return 'blocked'
      if (state === 'auto-off') return 'held'
      return ''
    }

    // -------------------------------------------------------------- 数字

    /** 毫秒 → 人类读得懂的量级。绝不输出两位有效数字的伪精度。 */
    function formatMs(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—'
      if (ms >= 950) {
        const seconds = Math.round(ms / 100) / 10
        return '约 ' + seconds.toFixed(1) + ' 秒'
      }
      if (ms >= 100) return Math.round(ms / 10) * 10 + 'ms'
      return Math.round(ms) + 'ms'
    }

    function formatAge(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—'
      const seconds = Math.round(ms / 1000)
      if (seconds < 10) return '刚刚'
      if (seconds < 60) return seconds + ' 秒前'
      const minutes = Math.round(seconds / 60)
      if (minutes < 60) return minutes + ' 分钟前'
      const hours = Math.round(minutes / 60)
      if (hours < 24) return hours + ' 小时前'
      return Math.round(hours / 24) + ' 天前'
    }

    function formatDuration(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '—'
      const seconds = Math.round(ms / 1000)
      if (seconds < 90) return seconds + ' 秒'
      const minutes = Math.floor(seconds / 60)
      const rest = seconds % 60
      return rest === 0 ? minutes + ' 分钟' : minutes + ' 分 ' + rest + ' 秒'
    }

    function nowOf(snapshot) {
      return typeof snapshot?.now === 'number' ? snapshot.now : Date.now()
    }

    /** 候选数据是否还在它的保鲜期内（一轮之内）。 */
    function isCandidateFresh(snapshot) {
      const finishedAt = snapshot?.round?.finishedAt ?? 0
      if (finishedAt <= 0) return false
      const intervalMs = Math.max(1, snapshot?.config?.roundIntervalMin ?? 5) * 60_000
      return nowOf(snapshot) - finishedAt <= intervalMs
    }

    // -------------------------------------------------------------- 状态仓库

    /**
     * 两个挂载点共享一个轮询器：配置页开着的时候不应该有两份 4 秒轮询。
     * 引用计数归零即停表。
     */
    function createStore() {
      let snapshot = null
      let error = null
      /**
       * 「动作在飞」的计数，只用来在归零时补一次刷新。
       *
       * 轮 4 之前它还是个轮询开关：`busy > 0` 时整页跳过 refresh，结果 A 会话
       * 测速时 B 会话的轮询也被停掉，B 根本读不到 manual 已经变成 scan ——
       * 那正是「切会话图标不同步」的两个根因之一。现在轮询**不因它暂停**，
       * 只由下面的 `inflight` 防重叠。
       */
      let busy = 0
      let inflight = false
      let timer = null
      let refs = 0
      const listeners = new Set()

      const emit = () => {
        for (const listener of Array.from(listeners)) listener()
      }

      const onVisible = () => {
        if (document.hidden !== true) void refresh()
      }

      /**
       * 拉一次快照。
       *
       * 注意**不因 busy 而停**：`/state` 读的是宿主内存里的一份快照，不发任何
       * 网络探测，不会和正在跑的检测抢链路。以前这里 `busy > 0` 直接 return，
       * 而 busy 是页面级共享的，于是「A 会话点了测速 → 切到 B 会话」时 B 的
       * 轮询也被一起停掉，看不到 manual.phase 已经变成 scan——图标自然不同步。
       */
      async function refresh() {
        if (inflight) return
        inflight = true
        try {
          snapshot = await call('state', {})
          error = null
        } catch (cause) {
          error = cause
        } finally {
          inflight = false
          emit()
        }
      }

      function start() {
        if (timer !== null) return
        timer = window.setInterval(() => { void refresh() }, POLL_MS)
        document.addEventListener('visibilitychange', onVisible)
        void refresh()
      }

      function stop() {
        if (timer === null) return
        window.clearInterval(timer)
        timer = null
        document.removeEventListener('visibilitychange', onVisible)
      }

      return {
        value() {
          return { snapshot, error }
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        retain() {
          refs += 1
          if (refs === 1) start()
        },
        release() {
          refs = Math.max(0, refs - 1)
          if (refs === 0) stop()
        },
        refresh,
        /** 动作期间占住轮询，动作结束后立刻补一次状态。 */
        async run(task) {
          busy += 1
          try {
            return await task()
          } finally {
            busy = Math.max(0, busy - 1)
            if (busy === 0) void refresh()
          }
        },
      }
    }

    const store = createStore()

    function useSnapshot() {
      const [, bump] = useReducer((value) => value + 1, 0)
      useEffect(() => {
        store.retain()
        const off = store.subscribe(bump)
        return () => {
          off()
          store.release()
        }
      }, [])
      return store.value()
    }

    // ---------------------------------------------------------------- 样式

    const CSS = `
/* ---- 横幅：点阵三格（当前 / 流式 / 候选），无文字、不可展开 ---- */
.cfp-root{font:inherit;color:var(--dsw-alias-label-primary)}
/* 只给 dock 用的定位：横向必须和输入框卡片是**同一个盒子**。
   挂点 conversation.input.dock 是 composerStack 的纵向 flex 项，会被拉伸到整条宽度；
   原写法只有 justify-content:flex-start，于是点阵贴到窗口最左边，实测比卡片左边缘
   偏左 174.5px。这里复刻卡片自己的定宽方式：卡片 = inputBar 的 side-clearance 内缩
   + max-width:card-max-width + 居中；我们照同一套公式，盒子就逐像素重合。
   变量缺失时退回 16px / 952px，仍然居中，不会又跑回左边。 */
.cfp-dock{box-sizing:border-box;position:relative;display:flex;flex:none;
  justify-content:flex-start;
  width:calc(100% - var(--dsh-composer-side-clearance,16px) - var(--dsh-composer-side-clearance,16px));
  max-width:var(--dsh-composer-card-max-width,952px);
  margin:0 auto;
  padding:1px 0 5px}
.cfp-cluster{position:relative;display:inline-flex;align-items:center;gap:8px;
  padding:2px 0;line-height:0}
/* 告警文字：只在需要用户动手时出现（权限 / 断网等）。
   刻意做小、做淡——它是提示不是警告弹窗，不能盖过图标本身。 */
@keyframes cfp-warn-in{from{opacity:0;transform:translateX(-3px)}to{opacity:1;transform:none}}
.cfp-warn{flex:none;font-size:11.5px;line-height:16px;letter-spacing:.01em;
  color:var(--dsw-alias-state-warn-primary);white-space:nowrap;
  animation:cfp-warn-in .22s ease both}
.cfp-warn::before{content:"·";margin-right:5px;opacity:.7}
/* 断网用中性色：这不是插件的错，用户也没法通过插件解决。 */
.cfp-cluster.is-dead .cfp-warn{color:var(--dsw-alias-label-tertiary)}
.cfp-cluster.is-alert .cfp-warn{color:var(--dsw-alias-state-error-primary,#d9534f)}
/* 减少动效：必须用 !important。.cfp-warn.is-probe 特异性 0,2,0 且写在后面，
   媒体查询本身不提升特异性——原写法压不住它，测速提示仍在做位移淡入。 */

/* 断网 / 全劣化：整颗图标压暗或缓慢明暗，表示真的慢。
   压暗只写在皮肤内部那一层（.cfp-ring-core / .cfp-afterglow 的 opacity）。
   这里曾经还有一组打在 .cfp-skin 和 .cfp-cluster 上的同语义规则，
   与皮肤内规则叠乘后把 is-dim 压到 .30（本该 .55）、候选侧压到 .24（本该 .4），
   像旧三格设计的残留。删掉外层，让压暗只发生一次。 */
.cfp-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;
  clip-path:inset(50%);white-space:nowrap;border:0}
.cfp-text{flex:0 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cfp-chev{flex:none;margin-left:auto;display:inline-flex;align-items:center;
  color:var(--dsw-alias-label-tertiary,#8b8f96);transition:transform .18s ease}
.cfp-chev.is-open{transform:rotate(90deg)}
.cfp-mono{font-family:var(--dsh-font-family-code-default,ui-monospace,Consolas,monospace);font-size:11.5px}
.cfp-page{box-sizing:border-box;max-width:760px;padding:16px 20px 28px;
  color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55}
.cfp-statusRow{display:flex;align-items:center;gap:8px;margin:0 0 10px;
  font-size:15px;line-height:22px}
.cfp-facts{display:grid;grid-template-columns:82px minmax(0,1fr);gap:6px 12px;
  margin:0 0 4px;font-size:12.5px;line-height:18px}
.cfp-facts dt{color:var(--dsw-alias-label-tertiary)}
.cfp-facts dd{margin:0;min-width:0;overflow-wrap:anywhere}
.cfp-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:14px}
.cfp-notice{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.cfp-notice.is-error{color:var(--dsw-alias-state-error-primary,#d9534f)}
.cfp-note{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
/* 只读的派生读数：长得不像输入框，明确表示「这不是你能改的」。 */
.cfp-derived{font-size:12px;line-height:16px;font-variant-numeric:tabular-nums;
  color:var(--dsw-alias-label-tertiary,#8b8f96);
  padding:4px 8px;border-radius:6px;
  background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.05))}
.cfp-section{margin-top:22px;padding-top:16px;border-top:1px solid var(--dsw-alias-border-l1)}
/* 详情页里的设置区块：宿主已经在外面画了分节，这里不再叠分隔线。 */
.cfp-detailSection .cfp-section{margin-top:16px;padding-top:0;border-top:0}
/* 折叠体内部的视觉分节标题。它不折叠，只是分组标签，层次仍是一级入口。 */
.cfp-sub{margin:16px 0 4px;font-size:11px;font-weight:600;letter-spacing:.04em;
  color:var(--dsw-alias-label-tertiary,#8b8f96);text-transform:none}
.cfp-sub:first-child{margin-top:0}
.cfp-item{display:flex;align-items:flex-start;gap:16px;padding:7px 0}
.cfp-itemMain{flex:1;min-width:0}
.cfp-itemLabel{font-size:13px;line-height:18px}
.cfp-itemHelp{margin-top:2px;font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary)}
.cfp-itemCtl{flex:none;display:flex;align-items:center;gap:8px;padding-top:1px}
.cfp-btn{height:28px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);
  border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-button-elevated-fill);
  color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;cursor:pointer;
  white-space:nowrap}
.cfp-btn:hover:not(:disabled){background:var(--dsw-alias-button-floating-hover)}
.cfp-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid
  var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-1px}
.cfp-btn:disabled{opacity:.5;cursor:default}
.cfp-btn.is-ghost{border-color:transparent;background:none;color:var(--dsw-alias-label-secondary)}
.cfp-btn.is-ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.cfp-switch{position:relative;flex:none;width:34px;height:20px;padding:0;border:0;
  border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);cursor:pointer;
  transition:background-color .18s ease}
.cfp-switch[aria-checked='true']{background:var(--dsw-alias-state-business-primary)}
.cfp-switch::after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;
  border-radius:50%;background:var(--dsw-alias-switch-thumb,#fff);
  transition:transform .18s ease}
.cfp-switch[aria-checked='true']::after{transform:translateX(14px)}
.cfp-switch:focus-visible{outline:var(--dsw-focus-ring-width) solid
  var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.cfp-switch:disabled{opacity:.5;cursor:default}
.cfp-input{box-sizing:border-box;height:28px;width:88px;padding:0 8px;
  border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);
  background:var(--dsw-alias-bg-layer-1,#1f1f21);color:var(--dsw-alias-label-primary);
  font:inherit;font-size:12.5px;text-align:right}
.cfp-input:focus-visible{outline:var(--dsw-focus-ring-width) solid
  var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-1px}
.cfp-unit{font-size:12px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.cfp-derive{margin:10px 0 8px;padding:10px 12px;border:1px solid var(--dsw-alias-settings-card-stroke);
  border-radius:var(--dsw-radius-md);background:var(--dsw-alias-settings-card-fill);
  transition:background-color .3s ease}
.cfp-derive.is-flash{background:var(--dsw-alias-interactive-bg-hover)}
.cfp-deriveMain{font-size:13px;line-height:19px}
.cfp-deriveSub{margin-top:2px;font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.cfp-advHead{display:flex;align-items:center;gap:6px;width:100%;margin:0;padding:0;
  border:0;background:none;color:var(--dsw-alias-label-secondary);font:inherit;
  font-size:12px;font-weight:600;letter-spacing:.02em;text-align:left;cursor:pointer}
.cfp-advBody{margin-top:10px}
.cfp-addrRow{display:flex;align-items:center;gap:8px;padding:4px 0}
.cfp-addrRow .cfp-input{flex:1;width:auto;text-align:left;font-family:var(--dsh-font-family-code-default,ui-monospace,Consolas,monospace);
  font-size:12px}
.cfp-check{flex:none;width:14px;height:14px;margin:0;
  accent-color:var(--dsw-alias-state-business-primary)}
.cfp-summary{display:flex;align-items:center;gap:8px;font-size:12.5px;
  color:var(--dsw-alias-label-secondary)}
.cfp-summary .cfp-text{white-space:normal}
.cfp-summaryTail{margin-left:auto;flex:none;font-size:12px;color:var(--dsw-alias-label-tertiary)}
/* ---- 动效关键字：每一条都在下面「动效接线」里被真实引用，一个都不许剩 ---- */
/* 流式呼吸：**未实现（有意为之）**。
   流式状态这一版没有做，所以这里刻意不挂任何动画。data-stream 仍然由
   Banner 产出（取值 stream / idle），但它目前没有任何 CSS 消费者；
   读屏文案（spoken）里的「正在生成 / 空闲」照常工作。
   将来要做流式动效时，在这里给 [data-stream='stream'] 接一条只在暗度上
   变化的循环动画即可；不要改成位移或旋转——测速/换线已经占用了那些通道。 */

/* 候选更快：候选侧的一次性脉动，提示「可以挪了」。 */

/* 换线落地：当前侧被敲一下，确认「新的当前已经生效」。 */

/* 受阻慢呼吸：需要你动手（提权 / 明天再来），所以慢，不催。 */

/* 就绪提示：候选已测到且明显更快，环上的一次「亮了」的提示。 */


/* 出场：图标第一次拿到读数时落位，从略小淡入到正常。 */

/* 换线亮条：从候选侧（右）横扫到当前侧（左）。几何按 25px 图标重算——
   原稿是 64.2px→1.2px 的三格点阵坐标，单图标下不再适用。 */

/* ============ 皮肤：一颗图标同时表达「当前」与「候选」 ============
   两套皮肤的契约一致：左半 = 当前线路，右半 = 候选线路，各自按自己的延迟
   变化，互不干扰。所以它们不再是三格，而是一颗。显示尺寸 25px。 */
.cfp-skinBtn{appearance:none;display:flex;align-items:center;justify-content:center;
  flex:none;padding:0;margin:0;border:0;background:transparent;color:inherit;
  cursor:pointer;-webkit-tap-highlight-color:transparent;
  width:25px;height:25px;border-radius:7px}
.cfp-skinBtn:disabled{cursor:default}
.cfp-skinBtn:focus-visible{outline:1px solid var(--dsw-alias-state-business-primary,#74b9ff);
  outline-offset:5px}
/* ---- 悬停提示：当前 / 候选延迟 ----
   纯 CSS 触发（:hover / :focus-within），**不用 JS state**：
   它不是插件状态，只是这颗图标的注脚，没必要跨会话同步。
   用 visibility 而不是 display，这样它有过渡、也不会在不可见时抢焦点。
   定位基准是 .cfp-cluster（图标那一行的实际盒子，本身已是 position:relative），
   不是 .cfp-dock —— 后者撑满整行宽度，left:0 会让提示跑到窗口最左边。 */
.cfp-tip{position:absolute;left:-6px;bottom:calc(100% + 4px);z-index:30;
  display:flex;flex-direction:column;gap:2px;
  padding:6px 9px;border-radius:8px;white-space:nowrap;
  font-size:11.5px;line-height:15px;font-variant-numeric:tabular-nums;
  color:var(--dsw-alias-label-primary,#eef0f3);
  background:var(--dsw-alias-bg-overlay,#22252a);
  border:1px solid var(--dsw-alias-border-l2,#3a3a40);
  box-shadow:0 4px 14px rgba(0,0,0,.28);
  opacity:0;visibility:hidden;transform:translateY(2px);
  transition:opacity .14s ease,transform .14s ease,visibility .14s;
  pointer-events:none}
/* 触发范围只包住图标按钮本身：挂在 .cfp-dock 上会让「鼠标扫过整行输入框」
   也弹提示，太吵。按钮已有 :focus-visible，键盘用户照样能用。 */
.cfp-cluster:hover .cfp-tip,
.cfp-cluster:focus-within .cfp-tip{opacity:1;visibility:visible;transform:none}
/* 指针设备才有「悬停」；触屏上它会在点击后粘住，所以只对能悬停的设备启用。 */
@media (hover:none){
  .cfp-cluster:hover .cfp-tip,.cfp-cluster:focus-within .cfp-tip{
    opacity:0;visibility:hidden;transform:translateY(2px)}
}
.cfp-tipRow{display:flex;align-items:baseline;gap:6px}
.cfp-tipKey{flex:none;min-width:2.6em;color:var(--dsw-alias-label-tertiary,#8b8f96)}
.cfp-tipVal{font-weight:600}
.cfp-tipNote{color:var(--dsw-alias-label-tertiary,#8b8f96);font-size:10.5px}
/* 测速结果只出现几秒就自己消失；它是提示，不是常驻状态。 */
.cfp-warn.is-probe{color:var(--dsw-alias-label-tertiary,#8b8f96);
  animation:cfp-warn-in .22s ease both}
/* 设置页的皮肤选择器：一行三张卡，缩略图用真实组件画，不是贴图。 */
.cfp-skins{display:flex;flex-wrap:wrap;gap:8px;margin:2px 0 14px}
.cfp-skinChoice{appearance:none;flex:1 1 130px;min-width:0;display:flex;
  flex-direction:column;align-items:flex-start;gap:5px;
  padding:10px 12px;border-radius:9px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l1,#2c2c30);
  background:var(--dsw-alias-bg-layer-1,#16161a);color:inherit;text-align:left;
  transition:border-color .16s ease,background .16s ease}
.cfp-skinChoice:hover:not(:disabled){border-color:var(--dsw-alias-border-l2,#3a3a40)}
.cfp-skinChoice.is-active{border-color:var(--dsw-alias-state-business-primary,#74b9ff)}
.cfp-skinChoice:disabled{cursor:default;opacity:.6}
.cfp-skinChoice:focus-visible{outline:1px solid var(--dsw-alias-state-business-primary,#74b9ff);
  outline-offset:2px}
.cfp-skinPreview{display:flex;align-items:center;justify-content:flex-start;
  height:34px;line-height:0}
.cfp-skinName{font-size:12px;line-height:16px;
  color:var(--dsw-alias-label-primary,#e7f0eb)}
.cfp-skinDesc{font-size:11px;line-height:15px;
  color:var(--dsw-alias-label-tertiary,#8b8f96)}
/* 图标容器：25px，皮肤 SVG 填满它。
   注意：宿主**不**在这里施加旋转。两套新皮肤的测速动效都在字形内部完成
   （环芯是读头沿环扫过、余温是中心向外的亮度波），旋转整枚图标会与它们叠加。 */
.cfp-glyph{display:block;flex:none;width:25px;height:25px;line-height:0}
/* 四档色相直接绑定宿主的语义状态色。
   宿主 token 自己会在明暗主题间翻转（requiresLightAndDark），
   所以这里不需要猜 [data-theme] 之类的选择器，也就没有
   「主题标记猜错 → 亮色值画在深底上」的风险。
   这同时也是四档的唯一来源：值始终存在，不存在「变量未定义导致
   fill 声明无效、SVG 退回黑色」的失败模式。 */
.cfp-cluster{
  --v-exc:var(--dsw-alias-state-success-primary,#2f8f5b);
  --v-good:var(--dsw-alias-state-business-primary,#2f6fd0);
  --v-fair:var(--dsw-alias-state-warn-primary,#b5761f);
  --v-poor:var(--dsw-alias-state-error-primary,#c3433a);
}
/* 过期 / 借用：压暗只由皮肤内部那一层负责（.cfp-side-cand 的 opacity）。
   这里曾经还压了一次整张 .cfp-skin（.6 / .72），两层相乘让候选侧掉到 .24 / .29，
   比设计值 .4 暗一倍。属性通道（data-stale / data-borrowed）皮肤内部同样认，
   所以这里删掉不会让任何一个通道失效。 */
.cfp-dock[data-probing='1'] .cfp-skinBtn{cursor:progress}
.cfp-dock[data-probing='1'] .cfp-skinBtn:hover{background:transparent}
.cfp-dock[data-warn]:not([data-warn='']) .cfp-cluster{gap:10px}
/* 配置页状态圆点：与横幅无关，是设置页自己的状态指示。 */
.cfp-dot{flex:none;width:6px;height:6px;border-radius:50%;
  background:var(--dsw-alias-label-tertiary,#8b8f96)}
.cfp-dot.is-ok{background:var(--dsw-alias-state-success-primary)}
.cfp-dot.is-work{background:var(--dsw-alias-state-business-primary)}
.cfp-dot.is-warn{background:var(--dsw-alias-state-warn-primary)}
.cfp-statusRow .cfp-dot{width:7px;height:7px}

/* ==========================================================================
   dsh-cf-pin 图标皮肤：ring-core（环芯）/ afterglow（余温）
   ---------------------------------------------------------------------------
   契约：一个 25×25 的点阵图形同时承载「当前」与「候选」，零文字。
   皮肤只消费宿主已发出的钩子，不含业务判断：

     .is-busy           测速中（配 [data-probe-phase] 区分 spin / brake）
     .is-swap .is-donor 换线帧（1500ms 一次性）
     .is-arriving       首次落位
     .is-blocked .is-held  慢呼吸（要你动手，不催）
     .has-better        候选更快，脉动
     .is-alert 或 [data-state=all-degraded]  全劣化明暗
     .is-dead .is-dim .is-stale [data-borrowed=1]  静态降权

   颜色只有一个来源：下面 .cfp-cluster 里那四个 --v-* 变量，各自绑到宿主的
   语义状态色 token（--dsw-alias-state-*），并带十六进制兜底。宿主 token
   自己会在明暗主题间翻转，所以这里不需要挑主题、也不会出现「变量未定义导致
   fill 声明无效、SVG 退回黑色」这种失败模式。
   ========================================================================== */

/* 25px：嵌在输入框里，尺寸变了会挤坏布局。 */
.cfp-skin{display:block;flex:none;width:25px;height:25px;overflow:visible}

/* ===== 皮肤一：环芯 ring-core ===== */
/* ==========================================================================
   2. 皮肤 · 环芯 ring-core
   外圈 16 点 = 候选（角度覆盖），内芯 5 点 = 当前（点亮数）。
   单套色板；几何、档位映射、动效时长与余温共用同一份定义。
   测速不旋转整枚图标：读头与刹车都发生在字形内部的 cfp-probe 子层。
   ========================================================================== */
.cfp-ring-core .k{fill:var(--dsw-alias-label-primary,#eef0f3)}
.cfp-ring-core .k.tp-excellent{fill:var(--v-exc)}
.cfp-ring-core .k.tp-good{fill:var(--v-good)}
.cfp-ring-core .k.tp-fair{fill:var(--v-fair)}
.cfp-ring-core .k.tp-poor{fill:var(--v-poor)}
.cfp-ring-core .g{fill:var(--dsw-alias-label-tertiary,#8b9199);opacity:.55}
.cfp-ring-core circle{transform-box:fill-box;transform-origin:50% 50%}
.cfp-ring-core .cfp-side-cand,
.cfp-ring-core .cfp-side-cur{transform-box:view-box;transform-origin:50% 50%}

/* ---- 静态钩子：过期压暗 / 整图降权 ----
   档位色相已经承担“哪一档”，候选侧不再换色，只靠 has-better 的脉动催促。 */
.cfp-cluster.is-stale .cfp-ring-core .cfp-side-cand,
.cfp-dock[data-stale="1"] .cfp-ring-core .cfp-side-cand,
.cfp-cluster.is-borrowed .cfp-ring-core .cfp-side-cand,
.cfp-dock[data-borrowed="1"] .cfp-ring-core .cfp-side-cand{opacity:.4}
.cfp-cluster.is-dim .cfp-ring-core,
.cfp-dock[data-state="probe-failed"] .cfp-ring-core{opacity:.55}
.cfp-cluster.is-dead .cfp-ring-core,
.cfp-dock[data-state="offline"] .cfp-ring-core{opacity:.45}

/* ---- 测速浮层：一圈 8 点的读头 + 尾迹，默认不可见 ---- */
.cfp-ring-core .cfp-probe{opacity:0}
.cfp-ring-core .cfp-probe .w{fill:var(--dsw-alias-label-primary,#eef0f3)}
.cfp-ring-core .cfp-probe-brake,
.cfp-ring-core .cfp-probe-rotor{transform-box:view-box;transform-origin:50% 50%}

/* ---- 动效 ---- */
@keyframes cfp01-in{
  0%{transform:scale(.2)}
  62%{transform:scale(1.08)}
  100%{transform:scale(1)}}
@keyframes cfp01-hold{0%,100%{opacity:.52}50%{opacity:1}}
@keyframes cfp01-better{
  0%,100%{opacity:1;transform:scale(1)}
  50%{opacity:.62;transform:scale(1.055)}}
@keyframes cfp01-alert{0%,100%{opacity:.5}50%{opacity:1}}
@keyframes cfp01-core{0%,100%{transform:scale(.94)}50%{transform:scale(1.06)}}
@keyframes cfp01-spin-up{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
@keyframes cfp01-spin-loop{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
@keyframes cfp01-brake{0%{transform:rotate(0deg)}100%{transform:rotate(150deg)}}
@keyframes cfp01-probe-out{0%,52%{opacity:1}100%{opacity:0}}
@keyframes cfp01-dim{0%{opacity:1}100%{opacity:.34}}
@keyframes cfp01-revive{0%{opacity:.34}100%{opacity:1}}
@keyframes cfp01-handoff-move{
  0%{transform:translate(0,0) scale(1)}
  14%{transform:translate(0,0) scale(.78)}
  62%{transform:translate(var(--tx),var(--ty)) scale(.46)}
  74%{transform:translate(var(--tx),var(--ty)) scale(.46)}
  76%{transform:translate(0,0) scale(.78)}
  100%{transform:translate(0,0) scale(1)}}
@keyframes cfp01-handoff-fade{
  0%{opacity:1}
  14%{opacity:1}
  62%{opacity:0}
  75%{opacity:0}
  100%{opacity:1}}
@keyframes cfp01-take2{
  0%{transform:scale(1)}
  36%{transform:scale(1.3)}
  68%{transform:scale(.96)}
  100%{transform:scale(1)}}

/* arrive · ≤500 ms · 21 点依次落位（末点 280 + 200 = 480 ms） */
.cfp-cluster.is-arriving .cfp-ring-core .cfp-side-cand circle,
.cfp-cluster.is-arriving .cfp-ring-core .cfp-side-cur circle{animation:cfp01-in .2s cubic-bezier(.2,.7,.3,1) both}
.cfp-cluster.is-arriving .cfp-ring-core .cfp-side-cand circle:nth-child(2){animation-delay:14ms}
.cfp-cluster.is-arriving .cfp-ring-core .cfp-side-cand circle:nth-child(3){animation-delay:28ms}
.cfp-cluster.is-arriving .cfp-ring-core .cfp-side-cand circle:nth-child(4){animation-delay:42ms}
.cfp-cluster.is-arriving .cfp-ring-core .cfp-side-cand circle:nth-child(5){animation-delay:56ms}
.cfp-cluster.is-arriving .cfp-ring-core .cfp-side-cand circle:nth-child(6){animation-delay:70ms}
.cfp-cluster.is-arriving .cfp-ring-core .cfp-side-cand circle:nth-child(7){animation-delay:84ms}
.cfp-cluster.is-arriving .cfp-ring-core .cfp-side-cand circle:nth-child(8){animation-delay:98ms}
.cfp-cluster.is-arriving .cfp-ring-core .cfp-side-cand circle:nth-child(9){animation-delay:112ms}
.cfp-cluster.is-arriving .cfp-ring-core .cfp-side-cand circle:nth-child(10){animation-delay:126ms}
.cfp-cluster.is-arriving .cfp-ring-core .cfp-side-cand circle:nth-child(11){animation-delay:140ms}
.cfp-cluster.is-arriving .cfp-ring-core .cfp-side-cand circle:nth-child(12){animation-delay:154ms}
.cfp-cluster.is-arriving .cfp-ring-core .cfp-side-cand circle:nth-child(13){animation-delay:168ms}
.cfp-cluster.is-arriving .cfp-ring-core .cfp-side-cand circle:nth-child(14){animation-delay:182ms}
.cfp-cluster.is-arriving .cfp-ring-core .cfp-side-cand circle:nth-child(15){animation-delay:196ms}
.cfp-cluster.is-arriving .cfp-ring-core .cfp-side-cand circle:nth-child(16){animation-delay:210ms}
.cfp-cluster.is-arriving .cfp-ring-core .cfp-side-cur circle:nth-child(1){animation-delay:224ms}
.cfp-cluster.is-arriving .cfp-ring-core .cfp-side-cur circle:nth-child(2){animation-delay:238ms}
.cfp-cluster.is-arriving .cfp-ring-core .cfp-side-cur circle:nth-child(3){animation-delay:252ms}
.cfp-cluster.is-arriving .cfp-ring-core .cfp-side-cur circle:nth-child(4){animation-delay:266ms}
.cfp-cluster.is-arriving .cfp-ring-core .cfp-side-cur circle:nth-child(5){animation-delay:280ms}

/* blocked / held · 2.8 s 慢呼吸，只动 opacity */
.cfp-cluster.is-blocked .cfp-ring-core,
.cfp-cluster.is-held .cfp-ring-core{animation:cfp01-hold 2.8s ease-in-out infinite}
/* has-better · 1.7 s，只脉动候选侧 */
.cfp-cluster.has-better .cfp-ring-core .cfp-side-cand{animation:cfp01-better 1.7s ease-in-out infinite}
/* alert · 2.4 s 明暗循环 */
.cfp-cluster.is-alert .cfp-ring-core,
.cfp-dock[data-state="all-degraded"] .cfp-ring-core{animation:cfp01-alert 2.4s ease-in-out infinite}
/* switch · 1500 ms 单次 · 候选外环上点亮的点依次沉入内芯，内芯接住后外环重新积聚。
   每一颗亮点的 --tx/--ty 指向最近的芯位；末点 300 + 1200 = 1500 ms。 */
.cfp-cluster:is(.is-swap,.is-donor) .cfp-ring-core,
.cfp-cluster:is(.is-swap,.is-donor) .cfp-ring-core *{animation:none}
.cfp-cluster:is(.is-swap,.is-donor) .cfp-ring-core .cfp-side-cand .k{animation:cfp01-handoff-move 1.2s cubic-bezier(.4,.05,.2,1) both,
  cfp01-handoff-fade 1.2s cubic-bezier(.4,.05,.2,1) both}
.cfp-cluster:is(.is-swap,.is-donor) .cfp-ring-core .cfp-side-cand circle:nth-child(2){animation-delay:20ms}
.cfp-cluster:is(.is-swap,.is-donor) .cfp-ring-core .cfp-side-cand circle:nth-child(3){animation-delay:40ms}
.cfp-cluster:is(.is-swap,.is-donor) .cfp-ring-core .cfp-side-cand circle:nth-child(4){animation-delay:60ms}
.cfp-cluster:is(.is-swap,.is-donor) .cfp-ring-core .cfp-side-cand circle:nth-child(5){animation-delay:80ms}
.cfp-cluster:is(.is-swap,.is-donor) .cfp-ring-core .cfp-side-cand circle:nth-child(6){animation-delay:100ms}
.cfp-cluster:is(.is-swap,.is-donor) .cfp-ring-core .cfp-side-cand circle:nth-child(7){animation-delay:120ms}
.cfp-cluster:is(.is-swap,.is-donor) .cfp-ring-core .cfp-side-cand circle:nth-child(8){animation-delay:140ms}
.cfp-cluster:is(.is-swap,.is-donor) .cfp-ring-core .cfp-side-cand circle:nth-child(9){animation-delay:160ms}
.cfp-cluster:is(.is-swap,.is-donor) .cfp-ring-core .cfp-side-cand circle:nth-child(10){animation-delay:180ms}
.cfp-cluster:is(.is-swap,.is-donor) .cfp-ring-core .cfp-side-cand circle:nth-child(11){animation-delay:200ms}
.cfp-cluster:is(.is-swap,.is-donor) .cfp-ring-core .cfp-side-cand circle:nth-child(12){animation-delay:220ms}
.cfp-cluster:is(.is-swap,.is-donor) .cfp-ring-core .cfp-side-cand circle:nth-child(13){animation-delay:240ms}
.cfp-cluster:is(.is-swap,.is-donor) .cfp-ring-core .cfp-side-cand circle:nth-child(14){animation-delay:260ms}
.cfp-cluster:is(.is-swap,.is-donor) .cfp-ring-core .cfp-side-cand circle:nth-child(15){animation-delay:280ms}
.cfp-cluster:is(.is-swap,.is-donor) .cfp-ring-core .cfp-side-cand circle:nth-child(16){animation-delay:300ms}
.cfp-cluster:is(.is-swap,.is-donor) .cfp-ring-core .cfp-side-cur circle{animation:cfp01-take2 .68s cubic-bezier(.2,.75,.3,1) both}
.cfp-cluster:is(.is-swap,.is-donor) .cfp-ring-core .cfp-side-cur circle:nth-child(1){animation-delay:500ms}
.cfp-cluster:is(.is-swap,.is-donor) .cfp-ring-core .cfp-side-cur circle:nth-child(2){animation-delay:564ms}
.cfp-cluster:is(.is-swap,.is-donor) .cfp-ring-core .cfp-side-cur circle:nth-child(3){animation-delay:628ms}
.cfp-cluster:is(.is-swap,.is-donor) .cfp-ring-core .cfp-side-cur circle:nth-child(4){animation-delay:692ms}
.cfp-cluster:is(.is-swap,.is-donor) .cfp-ring-core .cfp-side-cur circle:nth-child(5){animation-delay:756ms}

/* probe 优先：测速期间常驻循环一律让位（放在 switch 之后，靠多一个 .cfp-skin 压住） */
.cfp-cluster.is-busy .cfp-skin.cfp-ring-core{animation:none;transition:none}
.cfp-cluster.is-busy .cfp-skin.cfp-ring-core .cfp-side-cand,
.cfp-cluster.is-busy .cfp-skin.cfp-ring-core .cfp-side-cur,
.cfp-cluster.is-busy .cfp-skin.cfp-ring-core .cfp-side-cand *,
.cfp-cluster.is-busy .cfp-skin.cfp-ring-core .cfp-side-cur *{animation:none;transition:none}
/* probe-spin · 读头在环上跑：600 ms 加速 → 620 ms/圈，整枚图标不动 */
.cfp-cluster.is-busy:is([data-probe-phase="spin"],[data-probe-phase="brake"]) .cfp-ring-core .cfp-probe-rotor{
  animation:cfp01-spin-up .6s cubic-bezier(.45,0,.85,.45) 1,
    cfp01-spin-loop .62s linear .6s infinite}
.cfp-cluster.is-busy[data-probe-phase="spin"] .cfp-ring-core .cfp-probe{opacity:1}
.cfp-cluster.is-busy[data-probe-phase="spin"] .cfp-ring-core .cfp-side-cand,
.cfp-cluster.is-busy[data-probe-phase="spin"] .cfp-ring-core .cfp-side-cur{animation:cfp01-dim .28s ease-out both}
.cfp-cluster.is-busy:is([data-probe-phase="spin"],[data-probe-phase="brake"]) .cfp-ring-core .cfp-side-cur circle{
  animation:cfp01-core .62s ease-in-out infinite}
/* probe-brake · 1400 ms · 读头停在当前帧，由外层接着转 150° 减速；浮层收掉，主图复活 */
.cfp-cluster.is-busy[data-probe-phase="brake"] .cfp-ring-core .cfp-probe-rotor{animation-play-state:paused}
.cfp-cluster.is-busy[data-probe-phase="brake"] .cfp-ring-core .cfp-side-cur circle{animation-play-state:paused}
.cfp-cluster.is-busy[data-probe-phase="brake"] .cfp-ring-core .cfp-probe-brake{animation:cfp01-brake 1.4s cubic-bezier(.1,.55,.2,1) both}
.cfp-cluster.is-busy[data-probe-phase="brake"] .cfp-ring-core .cfp-probe{animation:cfp01-probe-out 1.4s cubic-bezier(.3,0,.4,1) both}
.cfp-cluster.is-busy[data-probe-phase="brake"] .cfp-ring-core .cfp-side-cand,
.cfp-cluster.is-busy[data-probe-phase="brake"] .cfp-ring-core .cfp-side-cur{animation:cfp01-revive 1.4s cubic-bezier(.08,.62,.22,1) both}

/* ===== 皮肤二：余温 afterglow ===== */
/* ==========================================================================
   2. 皮肤 · 余温 afterglow
   点阵位置永远不动：光晕铺到第几圈 = 候选，中心多亮 = 当前。
   每一侧按自己的档位取色（tp-*），亮度与半径仍读两个值。
   测速不旋转整枚图标：波纹与刹车都在字形内部的 cfp-probe 子层。
   ========================================================================== */
.cfp-afterglow .k{fill:var(--dsw-alias-label-primary,#eef0f3)}
.cfp-afterglow .tp-excellent .k{fill:var(--v-exc)}
.cfp-afterglow .tp-good .k{fill:var(--v-good)}
.cfp-afterglow .tp-fair .k{fill:var(--v-fair)}
.cfp-afterglow .tp-poor .k{fill:var(--v-poor)}
.cfp-afterglow .tp-nodata .k{fill:var(--dsw-alias-label-tertiary,#8b9199)}
.cfp-afterglow .g{fill:var(--dsw-alias-label-tertiary,#8b9199)}
.cfp-afterglow .cfp-side-cur,
.cfp-afterglow .cfp-side-cand{transform-box:view-box;transform-origin:50% 50%}

/* ---- 静态钩子：外两圈属于候选侧；整图降权 ---- */
.cfp-cluster.is-stale .cfp-afterglow .cfp-side-cand,
.cfp-dock[data-stale="1"] .cfp-afterglow .cfp-side-cand,
.cfp-cluster.is-borrowed .cfp-afterglow .cfp-side-cand,
.cfp-dock[data-borrowed="1"] .cfp-afterglow .cfp-side-cand{opacity:.35}
.cfp-cluster.is-dim .cfp-afterglow,
.cfp-dock[data-state="probe-failed"] .cfp-afterglow{opacity:.55}
.cfp-cluster.is-dead .cfp-afterglow,
.cfp-dock[data-state="offline"] .cfp-afterglow{opacity:.45}

/* ---- 测速浮层：四圈波纹点，默认不可见 ---- */
.cfp-afterglow .cfp-probe{opacity:0}
.cfp-afterglow .cfp-probe .w{fill:var(--dsw-alias-label-primary,#eef0f3)}
.cfp-afterglow .cfp-probe-settle{transform-box:view-box;transform-origin:50% 50%}

/* ---- 动效 ---- */
@keyframes cfp04-in{
  0%{opacity:0;transform:scale(.86)}
  72%{opacity:1;transform:scale(1.03)}
  100%{opacity:1;transform:scale(1)}}
@keyframes cfp04-hold{0%,100%{opacity:.52}50%{opacity:1}}
@keyframes cfp04-better{
  0%,100%{opacity:1;transform:scale(1)}
  50%{opacity:.66;transform:scale(1.05)}}
@keyframes cfp04-alert{0%,100%{opacity:.5}50%{opacity:1}}
@keyframes cfp04-wave{
  0%{opacity:0}
  14%{opacity:1}
  46%{opacity:.18}
  100%{opacity:0}}
@keyframes cfp04-drift{0%{transform:scale(1)}100%{transform:scale(1.14)}}
@keyframes cfp04-fade{0%,55%{opacity:1}100%{opacity:0}}
@keyframes cfp04-dim{0%{opacity:1}100%{opacity:.34}}
@keyframes cfp04-revive{0%{opacity:.34}100%{opacity:1}}
@keyframes cfp04-ext1{
  0%{opacity:1}
  16%{opacity:.06}
  50%{opacity:.06}
  68%{opacity:1}
  100%{opacity:1}}
@keyframes cfp04-ext2{
  0%{opacity:1}
  8%{opacity:.06}
  66%{opacity:.06}
  84%{opacity:1}
  100%{opacity:1}}
@keyframes cfp04-ext3{
  0%{opacity:1}
  14%{opacity:.06}
  80%{opacity:.06}
  100%{opacity:1}}
@keyframes cfp04-flare{
  0%,30%{filter:brightness(1)}
  52%{filter:brightness(2.1)}
  72%{filter:brightness(1.2)}
  100%{filter:brightness(1)}}

/* arrive · ≤500 ms */
.cfp-cluster.is-arriving .cfp-afterglow .cfp-side-cur{animation:cfp04-in .44s cubic-bezier(.2,.7,.3,1) both}
.cfp-cluster.is-arriving .cfp-afterglow .cfp-side-cand{animation:cfp04-in .44s cubic-bezier(.2,.7,.3,1) .04s both}
/* blocked / held · 2.8 s 慢呼吸，只动 opacity */
.cfp-cluster.is-blocked .cfp-afterglow,
.cfp-cluster.is-held .cfp-afterglow{animation:cfp04-hold 2.8s ease-in-out infinite}
/* has-better · 1.7 s，只脉动候选侧（外两圈） */
.cfp-cluster.has-better .cfp-afterglow .cfp-side-cand{animation:cfp04-better 1.7s ease-in-out infinite}
/* alert · 2.4 s 明暗循环 */
.cfp-cluster.is-alert .cfp-afterglow,
.cfp-dock[data-state="all-degraded"] .cfp-afterglow{animation:cfp04-alert 2.4s ease-in-out infinite}
/* switch · 1500 ms 单次 · 外圈由外向内熄灭 → 内芯爆亮 → 由内向外重亮。全程不动位置。 */
.cfp-cluster:is(.is-swap,.is-donor) .cfp-afterglow,
.cfp-cluster:is(.is-swap,.is-donor) .cfp-afterglow *{animation:none}
.cfp-cluster:is(.is-swap,.is-donor) .cfp-afterglow .cfp-r0{animation:cfp04-flare 1.5s cubic-bezier(.25,.6,.3,1) both}
.cfp-cluster:is(.is-swap,.is-donor) .cfp-afterglow .cfp-r1{animation:cfp04-ext1 1.5s cubic-bezier(.3,0,.25,1) both}
.cfp-cluster:is(.is-swap,.is-donor) .cfp-afterglow .cfp-r2{animation:cfp04-ext2 1.5s cubic-bezier(.3,0,.25,1) both}
.cfp-cluster:is(.is-swap,.is-donor) .cfp-afterglow .cfp-r3{animation:cfp04-ext3 1.5s cubic-bezier(.3,0,.25,1) both}
/* ---- 圈外点（.cfp-far）：静止不可见，事件动画期间才被抬起来 ----
   这些点静态 opacity 是 0（内联），所以它们的存在不影响「光铺到第几圈」的读法；
   但它们在 DOM 里，于是 has-better / arrive / swap 的组级动画总有可动对象。
   用 animation 覆盖内联 opacity —— 动画优先级高于内联样式，这是关键。

   两个一次性动画（arrive / swap）的 100% 必须回到 0：宿主移除类名之前若停在
   非零帧，会因为 fill-mode:both 一直亮着，等于把「静止不可见」破坏掉。 */
@keyframes cfp04-far-in{
  0%{opacity:0}
  45%{opacity:.38}
  100%{opacity:0}}
@keyframes cfp04-far-pulse{
  0%,100%{opacity:.22}
  50%{opacity:.5}}
@keyframes cfp04-far-swap{
  0%{opacity:0}
  30%{opacity:.38}
  65%{opacity:.1}
  100%{opacity:0}}
.cfp-cluster.is-arriving .cfp-afterglow .cfp-far{animation:cfp04-far-in .44s cubic-bezier(.2,.7,.3,1) both}
.cfp-cluster.has-better .cfp-afterglow .cfp-far{animation:cfp04-far-pulse 1.7s ease-in-out infinite}
.cfp-cluster:is(.is-swap,.is-donor) .cfp-afterglow .cfp-far{animation:cfp04-far-swap 1.5s cubic-bezier(.3,0,.25,1) both}

/* probe 优先：测速期间常驻循环一律让位 */
.cfp-cluster.is-busy .cfp-skin.cfp-afterglow{animation:none;transition:none}
.cfp-cluster.is-busy .cfp-skin.cfp-afterglow .cfp-side-cand,
.cfp-cluster.is-busy .cfp-skin.cfp-afterglow .cfp-side-cur,
.cfp-cluster.is-busy .cfp-skin.cfp-afterglow .cfp-side-cand *,
.cfp-cluster.is-busy .cfp-skin.cfp-afterglow .cfp-side-cur *{animation:none;transition:none}
/* probe-spin · 中心向外一圈圈亮起（1240 ms 一波），整枚图标不动 */
.cfp-cluster.is-busy[data-probe-phase="spin"] .cfp-afterglow .cfp-probe{opacity:1}
.cfp-cluster.is-busy:is([data-probe-phase="spin"],[data-probe-phase="brake"]) .cfp-afterglow .cfp-pw0{
  animation:cfp04-wave 1.24s cubic-bezier(.4,0,.3,1) infinite}
.cfp-cluster.is-busy:is([data-probe-phase="spin"],[data-probe-phase="brake"]) .cfp-afterglow .cfp-pw1{
  animation:cfp04-wave 1.24s cubic-bezier(.4,0,.3,1) .12s infinite}
.cfp-cluster.is-busy:is([data-probe-phase="spin"],[data-probe-phase="brake"]) .cfp-afterglow .cfp-pw2{
  animation:cfp04-wave 1.24s cubic-bezier(.4,0,.3,1) .24s infinite}
.cfp-cluster.is-busy:is([data-probe-phase="spin"],[data-probe-phase="brake"]) .cfp-afterglow .cfp-pw3{
  animation:cfp04-wave 1.24s cubic-bezier(.4,0,.3,1) .36s infinite}
.cfp-cluster.is-busy[data-probe-phase="spin"] .cfp-afterglow .cfp-side-cand,
.cfp-cluster.is-busy[data-probe-phase="spin"] .cfp-afterglow .cfp-side-cur{animation:cfp04-dim .28s ease-out both}
/* probe-brake · 1400 ms · 波形停在当前帧，整体向外散开并淡出 */
.cfp-cluster.is-busy[data-probe-phase="brake"] .cfp-afterglow .cfp-probe-settle *{animation-play-state:paused}
.cfp-cluster.is-busy[data-probe-phase="brake"] .cfp-afterglow .cfp-probe-settle{animation:cfp04-drift 1.4s cubic-bezier(.15,.6,.25,1) both}
.cfp-cluster.is-busy[data-probe-phase="brake"] .cfp-afterglow .cfp-probe{animation:cfp04-fade 1.4s cubic-bezier(.3,0,.35,1) both}
.cfp-cluster.is-busy[data-probe-phase="brake"] .cfp-afterglow .cfp-side-cand,
.cfp-cluster.is-busy[data-probe-phase="brake"] .cfp-afterglow .cfp-side-cur{animation:cfp04-revive 1.4s cubic-bezier(.08,.62,.22,1) both}

/* ---- 减少动效：一条规则关掉全部 ---- */
@media (prefers-reduced-motion:reduce){
  .cfp-skin,.cfp-skin *,.cfp-glyph{animation:none!important;transition:none!important}
}
`

    function Styles() {
      return h('style', { 'data-cf-pin': 'client' }, CSS)
    }

    // ---------------------------------------------------------------- 小件

    function Dot({ tone }) {
      return h('span', { className: 'cfp-dot is-' + tone, 'aria-hidden': 'true' })
    }

    function Chevron({ open }) {
      return h('span', { className: 'cfp-chev' + (open ? ' is-open' : ''), 'aria-hidden': 'true' },
        h('svg', {
          viewBox: '0 0 16 16', width: 12, height: 12, fill: 'none',
          stroke: 'currentColor', strokeWidth: 1.5,
          strokeLinecap: 'round', strokeLinejoin: 'round',
        },
          h('path', { d: 'M6.2 3.6 10.6 8l-4.4 4.4' })))
    }

    function Switch({ checked, onChange, disabled, label }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        className: 'cfp-switch',
        'aria-checked': checked ? 'true' : 'false',
        'aria-label': label,
        disabled: disabled === true,
        onClick: () => onChange(!checked),
      })
    }

    /**
     * 数字输入。失焦或回车提交，Esc 放弃；服务端夹住范围后回写，所以这里不
     * 自己「记住」一个和真实配置不一致的值。
     */
    function NumberField({ value, min, max, unit, onCommit, disabled, ariaLabel }) {
      const [text, setText] = useState(String(value))
      const [focused, setFocused] = useState(false)

      useEffect(() => {
        if (!focused) setText(String(value))
      }, [value, focused])

      const commit = () => {
        const parsed = Number(text)
        if (!Number.isFinite(parsed)) {
          setText(String(value))
          return
        }
        const clamped = Math.min(max, Math.max(min, Math.round(parsed)))
        setText(String(clamped))
        if (clamped !== value) onCommit(clamped)
      }

      return h(React.Fragment, null,
        h('input', {
          className: 'cfp-input',
          type: 'text',
          inputMode: 'numeric',
          value: text,
          'aria-label': ariaLabel,
          disabled: disabled === true,
          onFocus: () => setFocused(true),
          onBlur: () => { setFocused(false); commit() },
          onChange: (event) => setText(event.target.value.replace(/[^\d]/g, '')),
          onKeyDown: (event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
            if (event.key === 'Escape') { setText(String(value)); event.currentTarget.blur() }
          },
        }),
        unit ? h('span', { className: 'cfp-unit' }, unit) : null)
    }

// ------------------------------------------------------ 皮肤渲染桥接

    /**
     * 两套皮肤都由纯函数生成一段 SVG 字符串。
     *
     * 为什么是字符串而不是 React 元素：皮肤是「怎么画」，是设计资产，
     * 应该能被单独拷走、单独预览、单独改，不依赖宿主里的 React。
     * 宿主只负责把字符串挂上去，并把 tier 算好传进来。
     *
     * 安全性：这些字符串完全由本文件的常量拼出（数值 + 固定类名），
     * 不含任何外部输入，所以用 dangerouslySetInnerHTML 是安全的。
     */

    /** TTFB 四档的唯一分档依据。皮肤不得自带阈值。 */
    const TIER_EDGES = [380, 490, 600]

    /**
     * 毫秒 → 档位名。
     *
     * @param {number | null} ms
     * @returns {'excellent' | 'good' | 'fair' | 'poor' | 'nodata'}
     */
    function tierOf(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return 'nodata'
      if (ms <= TIER_EDGES[0]) return 'excellent'
      if (ms <= TIER_EDGES[1]) return 'good'
      if (ms <= TIER_EDGES[2]) return 'fair'
      return 'poor'
    }

    /** 档位由好到差；`nodata` 表示「没有读数」。 */
    const TIER_ORDER = { excellent: 0, good: 1, fair: 2, poor: 3, nodata: 4 }

    /**
     * 两侧取更差的一档，挂到 `<svg data-tier>`。
     * 两侧都没有读数时归入 `poor`——「什么都测不到」不该被画成「优」。
     */
    function worseTier(a, b) {
      const wa = TIER_ORDER[a] == null ? 4 : TIER_ORDER[a]
      const wb = TIER_ORDER[b] == null ? 4 : TIER_ORDER[b]
      const w = wa >= wb ? a : b
      return w === 'nodata' ? 'poor' : w
    }

    /** 坐标中心：viewBox 25×25。 */
    const SKIN_K = 12.5

    // 早先这里有一张 TONE_ORB（档位 → 宿主状态色），是给「流式扩散波 / 完成环 /
    // 换线亮条」这些装饰层做第二通道的。那批装饰层随「一颗图标读两侧」一起删掉后，
    // 它就没有任何引用了；CSS 里的 --cfp-tone 同理。已一并移除，
    // 免得下一个人以为还有一条能用的取色通道。

    function round2(value) {
      return Math.round(value * 100) / 100
    }

    /** 一个点。`k` = 已点亮，`g` = 未点亮，`tp-<tier>` 决定色相。 */
    function skinDot(x, y, r, className, style) {
      return '<circle cx="' + round2(x) + '" cy="' + round2(y) + '" r="' + round2(r) +
        '" class="' + className + '"' + (style ? ' style="' + style + '"' : '') + '/>'
    }

    // ---- 皮肤一：环芯 ring-core ----

    const RING_N = 16
    /** 外环点亮几颗 = 候选档位。16/12/8/4/0 是四等分的「角度覆盖」。 */
    const RING_LIT = { excellent: 16, good: 12, fair: 8, poor: 4, nodata: 0 }
    /** 内芯点亮几颗 = 当前档位（十字五点的中心 + 四臂）。 */
    const CORE_LIT = { excellent: 5, good: 3, fair: 2, poor: 1, nodata: 0 }
    const CORE_POS = [[0, 0], [0, -3.1], [0, 3.1], [-3.1, 0], [3.1, 0]]

    /**
     * 环芯：外圈 16 点 = 候选，内芯 5 点 = 当前。
     *
     * 当前与候选是**同一个同心图形**的两层，不是左右拼接。
     * 每颗外圈点还带一份指向最近芯位的位移向量（`--tx/--ty`），换线时由 CSS
     * 把它们吸进圆心——位移数据在这里算好，CSS 只管播。
     *
     * @param {{ current: string, candidate: string }} options
     * @returns {string}
     */
    function renderRingCore(options) {
      const current = options.current
      const candidate = options.candidate
      const ring = []
      const core = []

      const n = RING_LIT[candidate] == null ? 0 : RING_LIT[candidate]
      let acc = 0
      for (let i = 0; i < RING_N; i += 1) {
        acc += n
        const lit = acc >= RING_N
        if (lit) acc -= RING_N
        const a = ((-90 + i * (360 / RING_N)) * Math.PI) / 180
        const j = i % CORE_POS.length
        const tx = CORE_POS[j][0] - 9.4 * Math.cos(a)
        const ty = CORE_POS[j][1] - 9.4 * Math.sin(a)
        ring.push(skinDot(
          SKIN_K + 9.4 * Math.cos(a), SKIN_K + 9.4 * Math.sin(a),
          lit ? 1.3 : 0.95,
          lit ? 'k tp-' + candidate : 'g',
          '--tx:' + round2(tx) + 'px;--ty:' + round2(ty) + 'px',
        ))
      }

      const cn = CORE_LIT[current] == null ? 0 : CORE_LIT[current]
      for (let q = 0; q < CORE_POS.length; q += 1) {
        core.push(skinDot(
          SKIN_K + CORE_POS[q][0], SKIN_K + CORE_POS[q][1],
          q === 0 ? 1.5 : 1.2,
          q < cn ? 'k tp-' + current : 'g',
        ))
      }

      // 测速读头：一段 8 点的弧，带尾迹。默认不可见，只在 probe 期间出现。
      const probe = []
      for (let p = 0; p < 8; p += 1) {
        const pa = ((-90 - p * 14) * Math.PI) / 180
        probe.push(skinDot(
          SKIN_K + 9.4 * Math.cos(pa), SKIN_K + 9.4 * Math.sin(pa),
          1.3 - p * 0.08, 'w',
          'opacity:' + round2(1 - p * 0.12),
        ))
      }

      return '<svg class="cfp-skin cfp-ring-core" viewBox="0 0 25 25" width="25" height="25" ' +
        'aria-hidden="true" focusable="false" data-tier="' + worseTier(current, candidate) + '">' +
        '<g class="cfp-side-cand">' + ring.join('') + '</g>' +
        '<g class="cfp-side-cur">' + core.join('') + '</g>' +
        '<g class="cfp-probe"><g class="cfp-probe-brake"><g class="cfp-probe-rotor">' +
        probe.join('') + '</g></g></g>' +
        '</svg>'
    }

    // ---- 皮肤二：余温 afterglow ----

    /** 四圈：半径、点数、点半径。 */
    /**
     * 四圈：半径、点数、点半径。
     *
     * 点半径按「25px 下要看得清」定的，不是按放大稿。外圈 14 点排在 r=9.2 上，
     * 弧长间距约 4.1，点直径 2.1 还留着一倍空隙，不会连成环。
     */
    const GLOW_RINGS = [[2.6, 5, 1.4], [4.8, 8, 1.3], [7.0, 11, 1.15], [9.2, 14, 1.05]]
    const GLOW_PROBE = [[2.6, 5, 0.8], [4.8, 8, 0.75], [7.0, 11, 0.7], [9.2, 14, 0.64]]
    /** 候选档位 → 光铺到第几圈。nodata 铺不出去（没有读数就没有光）。 */
    const GLOW_REACH = { excellent: 9.9, good: 7.6, fair: 5.4, poor: 3.2, nodata: 0 }
    /** 当前档位 → 中心多亮。nodata 只留一颗几乎看不见的芯。 */
    const GLOW_CORE = { excellent: 1, good: 0.82, fair: 0.6, poor: 0.34, nodata: 0.12 }
    /**
     * 超出 reach 的点：静态不可见，但**留在 DOM 里**，动效期间由 CSS 临时点亮。
     *
     * 这个值必须是 0。两条弯路都试过了：
     *  - 留 0.1 微光：25px 下五档全变满盘，读不出「光只铺到第几圈」；
     *  - 整颗不输出：fair / poor / nodata 三档候选侧变成空组，has-better 脉动、
     *    arrive 淡入、换线的 ext2/ext3 全都没有可动对象。
     * 而 opacity:0 的占位点单独放上去也一样没用——组级 opacity 动画乘出来还是 0。
     *
     * 所以走第三条路：点在 DOM 里、静态 opacity 为 0、**只在事件动画里被抬起来**。
     * 静止时读档位靠「哪几圈亮」，事件时靠 CSS 把整组点亮（见 cfp04-ghost 规则）。
     */
    const FAR_ALPHA = 0

    /**
     * 余温：点阵位置永远不动。光晕铺到第几圈 = 候选，中心多亮 = 当前。
     *
     * 两个读数共用一张光晕、靠两个参数表达，所以它天然是一个完整图形。
     *
     * @param {{ current: string, candidate: string }} options
     * @returns {string}
     */
    function renderAfterglow(options) {
      const current = options.current
      const candidate = options.candidate
      const reach = GLOW_REACH[candidate] == null ? 9.9 : GLOW_REACH[candidate]
      const core = GLOW_CORE[current] == null ? 0.16 : GLOW_CORE[current]
      const ghost = TIER_ORDER[current] === 4 && TIER_ORDER[candidate] === 4

      /**
       * 第 rr 圈那颗点该多亮。返回 0 表示这颗点在**静态**下不可见。
       *
       * 四条约束，缺一条这个皮肤就读不出档位：
       *  1. 圈外（rr > reach + 0.6）的点静态必须是 0，不能和圈内的点同亮。
       *     25px 下给到 0.1 就会让五档都变成满盘，只是略微变淡——读不出「光铺到第几圈」。
       *  2. 下限不能抬。原来 Math.max(0.14, …) 把 fair 和 poor 抬成同一个亮度，
       *     两档就分不开了；现在下限只用来保证圈内的点不至于完全消失。
       *  3. 圈内要有明显的内亮外暗梯度，否则「光从中心散出去」不成立。
       *  4. 静态为 0 的点仍然要**输出到 DOM**，并挂 cfp-far 类：它们靠事件动画
       *     （has-better / arrive / swap）被 CSS 抬起来，这样动效有可动对象，
       *     而静止时又真的看不见。
       */
      function alphaOf(rr) {
        if (reach <= 0) return FAR_ALPHA
        if (rr > reach + 0.6) return FAR_ALPHA
        const t = Math.min(1, rr / reach)
        return Math.max(0.06, core * (1 - 0.62 * Math.pow(t, 1.4)))
      }

      /**
       * 一圈点。alpha 为 0 时仍然输出，但挂上 cfp-far：静止不可见，动画期间点亮。
       */
      function ringDots(rr, count, dr, className, alpha, far) {
        const cls = far === true ? className + " cfp-far" : className
        const out = []
        for (let i = 0; i < count; i += 1) {
          const a = ((-90 + (i * 360) / count) * Math.PI) / 180
          out.push(skinDot(
            SKIN_K + rr * Math.cos(a), SKIN_K + rr * Math.sin(a), dr, cls,
            alpha == null ? "" : "opacity:" + round2(alpha),
          ))
        }
        return out.join("")
      }
      const ink = ghost ? 'g' : 'k'
      /** 这一圈相对当前 reach 是否在圈外（静态不可见，靠 cfp-far 在事件里点亮）。 */
      const farOf = (rr) => reach <= 0 || rr > reach + 0.6
      const r0 = skinDot(SKIN_K, SKIN_K, 1.35, ink, 'opacity:' + round2(core)) +
        ringDots(GLOW_RINGS[0][0], GLOW_RINGS[0][1], GLOW_RINGS[0][2], ink, alphaOf(GLOW_RINGS[0][0]), farOf(GLOW_RINGS[0][0]))
      const r1 = ringDots(GLOW_RINGS[1][0], GLOW_RINGS[1][1], GLOW_RINGS[1][2], ink, alphaOf(GLOW_RINGS[1][0]), farOf(GLOW_RINGS[1][0]))
      const r2 = ringDots(GLOW_RINGS[2][0], GLOW_RINGS[2][1], GLOW_RINGS[2][2], ink, alphaOf(GLOW_RINGS[2][0]), farOf(GLOW_RINGS[2][0]))
      const r3 = ringDots(GLOW_RINGS[3][0], GLOW_RINGS[3][1], GLOW_RINGS[3][2], ink, alphaOf(GLOW_RINGS[3][0]), farOf(GLOW_RINGS[3][0]))

      // 测速波纹：四圈，由 CSS 错开 delay 形成「由心向外」的扩散。
      const probe = [0, 1, 2, 3].map((i) => {
        const ring = GLOW_PROBE[i]
        const head = i === 0 ? skinDot(SKIN_K, SKIN_K, 1.1, 'w') : ''
        return '<g class="cfp-pw' + i + '">' + head +
          ringDots(ring[0], ring[1], ring[2], 'w') + '</g>'
      }).join('')

      return '<svg class="cfp-skin cfp-afterglow" viewBox="0 0 25 25" width="25" height="25" ' +
        'aria-hidden="true" focusable="false" data-tier="' + worseTier(current, candidate) + '">' +
        '<g class="cfp-side-cur tp-' + current + '">' +
        '<g class="cfp-r0">' + r0 + '</g><g class="cfp-r1">' + r1 + '</g>' +
        '</g>' +
        '<g class="cfp-side-cand tp-' + candidate + '">' +
        '<g class="cfp-r2">' + r2 + '</g><g class="cfp-r3">' + r3 + '</g>' +
        '</g>' +
        '<g class="cfp-probe"><g class="cfp-probe-settle">' + probe + '</g></g>' +
        '</svg>'
    }

    /** 皮肤 id → 渲染函数。id 与 normalizeSkin 的白名单一一对应。 */
    const SKIN_RENDERERS = {
      'ring-core': renderRingCore,
      afterglow: renderAfterglow,
    }

    /**
     * 把一段 SVG 字符串挂成 React 节点。
     *
     * 用 `dangerouslySetInnerHTML`：皮肤是设计资产，产出的是纯静态标记，
     * 不含事件与外部输入。这样皮肤可以脱离 React 独立预览与替换。
     *
     * 这个 span 就是 .cfp-glyph（25px 容器）。Banner 里不再套第二层——
     * 两层同名容器会让内层丢掉 display:block，图标缩在按钮左上角。
     *
     * @param {{ skin: string, current: string, candidate: string }} props
     * @returns {any}
     */
    function SkinGlyph({ skin, current, candidate }) {
      const renderer = SKIN_RENDERERS[skin] ?? SKIN_RENDERERS['ring-core']
      return h('span', {
        className: 'cfp-glyph',
        'aria-hidden': 'true',
        dangerouslySetInnerHTML: { __html: renderer({ current, candidate }) },
      })
    }

    function Banner(props) {
      const { snapshot, error } = useSnapshot()
      const [swap, setSwap] = useState(false)
      const [arriving, setArriving] = useState(false)
      const previous = useRef(null)
      const swapTimer = useRef(0)
      const arriveTimer = useRef(0)

      /** 测速收尾的时长。与皮肤 CSS 里的 brake 动画长度一致。 */
      const BRAKE_MS = 1400

      /**
       * 组件是否还挂着。卸载后置 false：正在跑的 runProbe 不再继续发请求。
       *
       * 为什么必须要它：runProbe 是「测速 → 等 1400ms → 写 hosts」的串行流程，
       * 而写 hosts 是**机器级副作用**。用户在等待期间切走会话或关掉配置页，
       * 组件卸载了，可那个 1400ms 的等待仍然会结束，然后照常发 `/apply` ——
       * 也就是说，一次已经被用户离开的操作，仍然改了他系统的 hosts。
       *
       * 以前这个等待是一个裸 `window.setTimeout`，既没有清理也没有挂载检查。
       * 声明必须在下面的 effect 之前：cleanup 闭包会引用它们。
       */
      const aliveRef = useRef(true)

      /**
       * 刹车等待的取消器（卸载时调用，让 await 立刻返回）。
       *
       * 只是提前结束等待还不够：等待结束后要判 `aliveRef`，才能真正拦住 /apply。
       * 这里把定时器句柄也存下来，避免卸载后的空转。
       */
      const brakeRef = useRef(/** @type {null | (() => void)} */ (null))
      const releaseBrake = () => {
        const release = brakeRef.current
        brakeRef.current = null
        if (release !== null) release()
      }

      /**
       * 可取消的等待。卸载时 `releaseBrake()` 会立刻兑现它。
       * @param {number} ms
       * @returns {Promise<void>}
       */
      const waitBrake = (ms) => new Promise((resolve) => {
        const timer = window.setTimeout(() => {
          brakeRef.current = null
          resolve()
        }, ms)
        brakeRef.current = () => {
          window.clearTimeout(timer)
          resolve()
        }
      })

      // 只有 current.ip 真的变了（或宿主记了新的 lastSwitch）才播换线动画。
      useEffect(() => {
        const before = previous.current
        previous.current = snapshot
        if (snapshot === null) return
        /**
         * 落位动画的判据是**全局的**，不是「这个组件第一次拿到数据」。
         *
         * 以前用 `before === null`，而每个会话的横幅是独立组件，各自第一次
         * 挂载的时机不同——于是每切到一个新会话都会重播一次落位，可图标
         * 其实一直都在。现在改看引擎的 `firstReadingAt`：只有全局首读刚发生
         * （几秒内）才播。
         */
        const firstAt = typeof snapshot.firstReadingAt === 'number' ? snapshot.firstReadingAt : 0
        const globalJustArrived = firstAt > 0 && Math.abs(snapshot.now - firstAt) < ARRIVE_WINDOW_MS
        if (before === null) {
          if (globalJustArrived) {
            setArriving(true)
            clearTimeout(arriveTimer.current)
            arriveTimer.current = setTimeout(() => setArriving(false), ARRIVE_MS)
          }
          return
        }
        const movedIp = before.current && snapshot.current
          && before.current.ip !== snapshot.current.ip
        const movedAt = snapshot.lastSwitch && before.lastSwitch
          && before.lastSwitch.at !== snapshot.lastSwitch.at
        if (!movedIp && !movedAt) return
        // 换线动画同理：只在这个组件亲眼看到变化时播，切到别的会话不补播。
        setSwap(true)
        clearTimeout(swapTimer.current)
        swapTimer.current = setTimeout(() => setSwap(false), SWAP_MS)
      }, [snapshot])

      useEffect(() => () => {
        aliveRef.current = false
        clearTimeout(swapTimer.current)
        clearTimeout(arriveTimer.current)
        // 释放「刹车等待」：卸载后再等满 1400ms 毫无意义，而且那之后
        // 原本还会接着发一次会改用户 hosts 的 /apply（见 runProbe）。
        releaseBrake()
      }, [])

      /**
       * 点击图标 = 测速 + 写入，走的是配置页那两个真实接口。
       *
       * 刻意**不做**乐观更新：状态只认 /state 快照。因为它真的会改用户的 hosts，
       * 屏幕上不能先假装成功了。
       *
       * 动效分成两段交给皮肤：先 spin，扫描结束后 brake 1400ms，再写入。
       * 刹车是**纯客户端动画**，所以它只在这里本地等待，不写回引擎——
       * 引擎的阶段只表达「后端真的在做什么」，动画不配占用公共状态。
       */
      const runProbe = async () => {
        // 别的会话正在测速时，这一枚按钮不该被点第二下（后端是同一个引擎）。
        if (snapshot?.manual?.busy === true) return
        try {
          await store.run(() => call('scan', {}))
          if (!aliveRef.current) return

          // 刹车：让旋转停在整齐角度上，再开始写入。
          // 这段是纯动画时间，不阻塞后端（apply 在它之后才发）。
          await waitBrake(BRAKE_MS)

          // 卸载检查：这里是最要紧的一道。`/apply` 会真的改写系统 hosts，
          // 用户已经离开这个组件（切会话/关配置页）就不该再替他写一次。
          if (!aliveRef.current) return

          try {
            // 用户要求：点击触发的写入不许被任何东西拦住。
            // 所以这里既不等 confirm，也不把 alreadyOptimal 当成「没执行」——
            // 后端现在会真的写一次，这里只负责如实报告写了哪些 IP。
            //
            // 「没测到数据」这一种情况由引擎的 manual.note 表达（它知道候选数），
            // 客户端不重复造一句自己的文案。
            await store.run(() => call('apply', {}))
          } catch {
            // 写入失败的文案同样由引擎的 manual.note 给出。
          }
        } catch {
          // 测速失败同理。
        } finally {
          // 立刻拉一次，让图标的忙碌状态尽快收敛（不等下一个 4s 轮询）。
          void store.refresh()
        }
      }

      // 宿主要求：新增 hook 必须在所有提前 return 之前，否则 hook 数量在两次
      // 渲染之间变化，React 直接抛错、整个 slot 被换成错误面。
      // 所以 runProbe 只是一个普通函数，不是 hook。

      // 宿主不可达且从未拿到过快照时，宁可不占位，也不编一个状态。
      if (snapshot === null) return null

      // 「显示图标」关掉后，横幅整块不渲染——但它只是不画，测量和自动切换
      // 照常进行。用户要的是眼不见，不是停用功能。
      if (snapshot.config?.showUi === false) return null

      /**
       * 手动操作的阶段全部来自快照（`snapshot.manual`），**不再用本地 state**。
       *
       * 原因：引擎在宿主进程里是全局唯一的，但每个会话的横幅是独立组件。
       * 以前「在测速」是组件本地 state，于是 A 会话点了测速、切到 B 会话，
       * B 画的是它自己的空闲状态（或者更糟：A 卸载后动画残留）。
       * 现在所有会话读同一份状态，切换会话不再让图标忽亮忽灭。
       *
       * 放在提前 return 之后：这两个 return 之后 snapshot 一定非 null。
       */
      const manual = snapshot.manual ?? { phase: '', note: '', busy: false }
      const probing = manual.busy === true
      const probePhase = manual.phase === 'scan' ? 'spin'
        : manual.phase === 'brake' ? 'brake'
          : ''
      const probeNote = manual.note ?? ''

      const current = snapshot.current
      const best = snapshot.best
      const currentMs = current && typeof current.p50 === 'number' ? current.p50 : null
      const bestMs = best && typeof best.p50 === 'number' ? best.p50 : null
      const offline = snapshot.state === 'offline'
      /**
       * 候选读数是**借用**自当前值的。
       *
       * 启动瞬间还没测过候选，后端会拿当前读数顶上，好让图标一开始就有完整的
       * 两侧读数。但借用值只能用于**显示**：
       *   - 不能参与 gap/better 判断（否则会算出 gap=0 之外的假结论）；
       *   - 不能算「候选过期」；
       *   - 读屏要说清「候选沿用当前」。
       */
      const borrowed = snapshot.bestBorrowed === true
      const stale = !borrowed && best !== null && best !== undefined && !isCandidateFresh(snapshot)
      const stream = streamOf(snapshot, props)
      const hold = holdOf(snapshot.state)

      // 断网时当前格只剩底点，不给任何「快」的暗示。
      // 断网时不给任何「快」的暗示：当前读数按无数据处理。
      const curMs = offline ? null : currentMs

      /**
       * 候选够阈值才算「值得挪」；只快一点不催。借用值不参与。
       *
       * 两侧都必须有真实读数：`advantageMs` 是宿主算的，但单侧缺数据时它可能
       * 仍是上一轮的值。没有当前读数就没有「比当前快」可言，没有候选读数就没有
       * 比较对象——两种情况下都不能让界面暗示「有更快的线路」。
       */
      const advantage = borrowed || typeof snapshot.advantageMs !== 'number'
        ? null
        : snapshot.advantageMs
      const threshold = typeof snapshot.thresholdMs === 'number'
        ? snapshot.thresholdMs
        : (snapshot.config?.switchThresholdMs ?? 150)
      const comparable = !borrowed && currentMs !== null && bestMs !== null
      const gap = !comparable
        ? null
        : (advantage !== null ? advantage : currentMs - bestMs)
      const better = comparable && gap !== null && gap >= threshold
      // 「候选侧在催」= 候选确实更快（够不够阈值都算）：够阈值是 better，
      // 不够是弱提示。受阻那种状态要靠它，所以必须含 better。
      const arrow = comparable && gap !== null && gap > 0

      const tone = offline ? ' is-dead'
        : snapshot.state === 'all-degraded' ? ' is-alert'
          : ''

      const spoken = '当前 ' + (currentMs === null ? '暂无数据' : formatMs(currentMs))
        + '，候选 ' + (borrowed
          ? '沿用当前（尚未测速）'
          : (bestMs === null ? '暂无数据' : formatMs(bestMs)))
        + (stale ? '，候选数据已过期' : '')
        + '，' + (stream === 'stream' ? '正在生成' : '空闲')
        + (error === null ? '' : '，状态未更新')

      /**
       * 告警文字。
       *
       * 纯视觉只能表达「有点不对」，表达不了「为什么没换、你要做什么」。
       * 只有需要用户动手的那一类才给字，否则用户看到候选格在呼吸却不知道
       * 要做什么：
       *   - need-admin：他能解决（用管理员身份重启）
       * 其余状态（正常/观察中/等待写入/无候选/断网/全劣化/降级）不加字——
       * 那些不需要用户动作，加了就是噪音，违背「平时不打扰」。
       */
      const WARN_TEXT = {
        'need-admin': '需要管理员权限才能切换',
        'offline': '网络连不上',
        'all-degraded': '当前线路偏慢，且无更好候选',
        // 降级切换只是一次「矮子里拔将军」：不喊得比 need-admin 更急，但必须
        // 和常规切换分开——否则「全部偏慢」会被读成「已经好了」。
        //
        // 降级还要再分一层：如果写入的候选丢包率比原线路更高，那它连「相对较好」
        // 都算不上，只是一条「延迟低但更不稳」的线。这两句话不能混。
        'degraded-switched': snapshot.lastSwitchLossy === true
          ? '全部偏慢，已切到延迟较低的一条（丢包更多）'
          : '全部偏慢，已切到相对较好的一条',
        'probe-failed': '这一轮没测到数据',
      }
      const warn = WARN_TEXT[snapshot.state] ?? ''

      /**
       * cluster 上的一组修饰类。原来这里拼了字符串却从不使用，于是
       * 「候选过期 / 有更快候选 / 受阻 / 可挪」四种语义在界面上全部消失。
       * 现在每一条都对应 CSS 里的一条真实动效（见「动效接线」段）：
       *   is-stale   → 候选读数不作数，图标压到 .6
       *   has-better → 候选已测到且差距够，环上亮一次
       *   is-blocked → 需要提权，慢呼吸
       *   is-held    → 自动关闭，慢呼吸
       *   is-donor   → 换线中，亮条从候选侧横扫
       */
      const candExtra = (stale ? ' is-stale' : '')
        + (better ? ' has-better' : '')
        + (arrow && hold === 'blocked' ? ' is-blocked' : '')
        + (arrow && hold === 'held' ? ' is-held' : '')
        + (swap ? ' is-donor' : '')

      /**
       * 皮肤：ring（辐条，circle 02）/ taiji（太极，circle2），都是 25px 单图标。
       *
       * id 仍然是 'ring'（配置里已存的值），但画法换成辐条了点阵了——
       * 用户明确要求「用 circle 的 02 替换同心圆」。改 id 会让已存配置失效，
       * 所以保留 id、换实现。
       */
      const skin = snapshot.config?.skin === 'afterglow' ? 'afterglow' : 'ring-core'

      // 点击测速不适用于纯展示：断网时连测都测不了，按钮就是假的。
      const canProbe = !probing && snapshot.state !== 'offline'

      // 两侧各算一个档位；皮肤只认 tier，不认毫秒。
      const curTier = tierOf(curMs)
      const candTier = tierOf(bestMs)
      const glyph = h(SkinGlyph, { skin, current: curTier, candidate: candTier })

      /**
       * 悬停提示的两行：当前 / 候选的延迟。
       *
       * 用的是和图标**同一份读数**（curMs / bestMs），不另算一遍，否则图标的
       * 档位和提示里的数字会对不上。文字坚持「纯提示」定位：
       * 它只在悬停/聚焦时出现，不抢占常态下的注意力。
       */
      const tipMs = (ms) => {
        if (typeof ms !== 'number' || !Number.isFinite(ms)) return '暂无数据'
        // 提示里给到个位，比图标里的档位更有信息量（档位只是四档）。
        return Math.round(ms) + 'ms'
      }
      const tipCurrent = offline ? '断网，测不到' : tipMs(curMs)
      const tipBest = borrowed
        ? '沿用当前（尚未测速）'
        : (bestMs === null ? '暂无数据' : tipMs(bestMs))
      const tipNote = stale ? '候选读数已过期'
        : ''

      return h('div', {
        className: 'cfp-root cfp-dock',
        'data-state': snapshot.state,
        'data-skin': skin,
        'data-current': currentMs === null ? '' : String(Math.round(currentMs)),
        'data-best': bestMs === null ? '' : String(Math.round(bestMs)),
        // 借用标记：候选读数沿用当前值（启动瞬间还没测过候选）。
        'data-borrowed': borrowed ? '1' : '0',
        'data-stale': stale ? '1' : '0',
        'data-stream': stream,
        'data-arrow': arrow ? '1' : '0',
        'data-swap': swap ? '1' : '0',
        'data-probing': probing ? '1' : '0',
        'data-warn': warn === '' ? '' : snapshot.state,
      },
        h(Styles),
        h('div', {
          className: 'cfp-cluster' + tone
            + (probing ? ' is-busy' : '')
            + (swap ? ' is-swap' : '')
            + (borrowed ? ' is-borrowed' : '')
            + (arriving ? ' is-arriving' : '')
            // 候选侧的四种语义现在真的生效（原 candExtra 从未被插入）。
            + candExtra
            + (error === null ? '' : ' is-dim'),
          // 测速阶段：'' → spin（加速+匀速）→ brake（缓停）。CSS 靠它切动画。
          'data-probe-phase': probePhase,
        },
          h('button', {
            type: 'button',
            className: 'cfp-skinBtn',
            /**
             * 读屏文案必须与「能不能点」一致。
             *
             * 以前恒为「…，点击测速并切换」，但按钮在测速中 / 断网时是 disabled：
             * 读屏用户被告知可点、实际点不动；而且 disabled 会把焦点踢掉，
             * 键盘用户的提示（`:focus-within`）会中途消失。
             */
            'aria-label': canProbe
              ? spoken + '，点击测速并切换'
              : spoken + (probing ? '，正在测速' : '，断网，暂不可测速'),
            disabled: !canProbe,
            onClick: () => { void runProbe() },
          },
            // 图标本体。SkinGlyph 自带 .cfp-glyph 容器，这里不再套一层。
            // 所有动效都由皮肤内部 CSS 驱动，宿主不给它任何 transform。
            glyph),
          // 告警文字：只有「用户需要做点什么」的状态才出现，其余保持纯视觉。
          warn === '' ? null : h('span', { className: 'cfp-warn' }, warn),
          probeNote === '' ? null : h('span', { className: 'cfp-warn is-probe' }, probeNote),
          // 悬停提示：当前 / 候选延迟。
          // aria-hidden —— 同样的信息已经在按钮的 aria-label 里（spoken），
          // 这里再读一遍会让读屏用户听两遍。
          h('span', { className: 'cfp-tip', 'aria-hidden': 'true' },
            h('span', { className: 'cfp-tipRow' },
              h('span', { className: 'cfp-tipKey' }, '当前'),
              h('span', { className: 'cfp-tipVal' }, tipCurrent)),
            h('span', { className: 'cfp-tipRow' },
              h('span', { className: 'cfp-tipKey' }, '候选'),
              h('span', { className: 'cfp-tipVal' }, tipBest)),
            tipNote === '' ? null : h('span', { className: 'cfp-tipNote' }, tipNote))),
        h('span', { className: 'cfp-sr' }, spoken))
    }

    // ------------------------------------------------------------ 配置页

    function summaryOf(snapshot) {
      const copy = copyOf(snapshot.state)
      return copy.text
    }

    function ConfigSummary({ snapshot }) {
      if (snapshot === null) {
        return h('div', { className: 'cfp-root' },
          h(Styles),
          h('div', { className: 'cfp-summary' },
            h(Dot, { tone: 'idle' }),
            h('span', { className: 'cfp-text' }, '正在读取状态…')))
      }
      const copy = copyOf(snapshot.state)
      return h('div', { className: 'cfp-root' },
        h(Styles),
        h('div', { className: 'cfp-summary' },
          h(Dot, { tone: copy.tone }),
          h('span', { className: 'cfp-text' }, summaryOf(snapshot)),
          h('span', { className: 'cfp-summaryTail' },
            snapshot.autoWrite === true ? '自动切换：开' : '自动切换：关')))
    }

    function Facts({ snapshot }) {
      const now = nowOf(snapshot)
      const current = snapshot.current
      const round = snapshot.round ?? {}
      const finishedAt = round.finishedAt ?? 0
      const rows = []

      rows.push(['当前 IP', (snapshot.hosts?.currentIps ?? [])[0] || '未设置'])
      rows.push(['当前延迟', current && typeof current.p50 === 'number'
        ? formatMs(current.p50) + ' · ' + formatAge(now - current.at)
        : '还没测到'])
      if (snapshot.best) {
        rows.push(['更快候选', snapshot.best.ip + ' · ' + formatMs(snapshot.best.p50)
          + (isCandidateFresh(snapshot) ? ' · ' + formatAge(now - finishedAt) : ' · 数据已过期')])
      } else {
        rows.push(['更快候选', '没有'])
      }
      rows.push(['最近一轮', round.running === true
        ? '正在测'
        : (finishedAt > 0 ? formatAge(now - finishedAt) + ' · 每 ' + (snapshot.config?.roundIntervalMin ?? 0) + ' 分钟一轮' : '还没跑过')])
      rows.push(['上次切换', snapshot.lastSwitch
        ? formatAge(now - snapshot.lastSwitch.at)
          // 最近一次到底是「找到更快的线」还是「矮子里拔将军」，只有这里能说清。
          // 降级标记由引擎给（lastSwitchDegraded），前端不自己推断。
          + (snapshot.lastSwitchDegraded === true ? ' · 本次为降级切换' : '')
          /**
           * 降级还可能是「拿丢包换延迟」——候选更快但更容易丢包。用户已明确
           * 这种情况仍然写入，但文案必须如实说，不能把「更差」说成「相对较好」。
           */
          + (snapshot.lastSwitchLossy === true ? ' · 丢包率更高' : '')
          // 闸门跳过了哪些 IP，也只有引擎知道。
          + (typeof snapshot.lastSwitchCertNote === 'string' && snapshot.lastSwitchCertNote !== ''
            ? ' · ' + snapshot.lastSwitchCertNote
            : '')
        : '还没换过'])
      rows.push(['权限', snapshot.admin === true ? '管理员' : '普通用户，无法改写 hosts'])
      rows.push(['hosts', snapshot.hosts?.path || '—'])
      rows.push(['域名', (snapshot.hosts?.currentDomains ?? []).join(', ') || '—'])
      /**
       * 最近一次真实失败的原因。
       *
       * 引擎把「读 hosts 失败 / 采样失败 / 候选轮失败 / 写入失败」的具体原因
       * 一路写进 `lastError`，但以前客户端一个地方都不读——用户只看得到
       * `COPY[state]` 的泛化文案（「这一轮没测到数据，稍后自动重试」），
       * 永远不知道到底是权限、断网还是写不进去。有值才显示，不占空行。
       */
      if (typeof snapshot.lastError === 'string' && snapshot.lastError !== '') {
        rows.push(['最近错误', snapshot.lastError])
      }

      const children = []
      rows.forEach((row, index) => {
        children.push(h('dt', { key: 'k' + index }, row[0]))
        children.push(h('dd', {
          key: 'v' + index,
          className: row[0] === 'hosts' ? 'cfp-mono' : undefined,
        }, row[1]))
      })

      return h('dl', { className: 'cfp-facts' }, children)
    }

    /** 并发 → 一轮时长的派生读数。值一变就闪一下，让变化被看见。 */
    function DerivedReadout({ snapshot }) {
      const derived = snapshot.derived ?? {}
      const durationMs = derived.roundDurationMs ?? 0
      const [flash, setFlash] = useState(false)
      const previous = useRef(durationMs)

      useEffect(() => {
        if (previous.current === durationMs) return undefined
        previous.current = durationMs
        setFlash(true)
        const timer = window.setTimeout(() => setFlash(false), FLASH_MS)
        return () => window.clearTimeout(timer)
      }, [durationMs])

      const concurrency = snapshot.config?.candidateConcurrency ?? 0
      const count = derived.candidateCount ?? 0
      const slotMs = derived.slotMs ?? 0

      return h('div', { className: 'cfp-derive' + (flash ? ' is-flash' : '') },
        h('div', { className: 'cfp-deriveMain' },
          '一轮完整探测约 ' + formatDuration(durationMs)),
        h('div', { className: 'cfp-deriveSub' },
          count + ' 个候选 ÷ ' + concurrency + ' 并发 × '
          + Math.round(slotMs / 1000) + ' 秒'))
    }

    function AddressList({ snapshot, disabled, onSave, onResetDefaults }) {
      const addresses = snapshot.config?.addresses ?? []
      const [draft, setDraft] = useState('')

      const save = (list) => {
        onSave(list
          .filter((item) => item.address.trim().length > 0)
          .map((item) => ({ address: item.address.trim(), enabled: item.enabled !== false })))
      }

      const rows = addresses.map((item, index) => h('div', {
        className: 'cfp-addrRow',
        key: 'addr-' + index,
      },
        h('input', {
          className: 'cfp-check',
          type: 'checkbox',
          checked: item.enabled !== false,
          disabled,
          'aria-label': '参与探测：' + item.address,
          onChange: (event) => {
            const next = addresses.map((entry, position) => position === index
              ? { address: entry.address, enabled: event.target.checked }
              : entry)
            save(next)
          },
        }),
        h(AddressText, {
          value: item.address,
          disabled,
          onCommit: (text) => {
            const trimmed = text.trim()
            if (trimmed.length === 0 || trimmed === item.address) return
            const next = addresses.map((entry, position) => position === index
              ? { address: trimmed, enabled: entry.enabled !== false }
              : entry)
            save(next)
          },
        }),
        h('button', {
          type: 'button',
          className: 'cfp-btn is-ghost',
          disabled,
          'aria-label': '移除 ' + item.address,
          onClick: () => save(addresses.filter((entry, position) => position !== index)),
        }, '移除')))

      // 新地址直接用受控输入：失焦才提交的写法会让「添加」按钮在输入过程中
      // 一直是禁用的，点不动。
      const add = () => {
        const trimmed = draft.trim()
        if (trimmed.length === 0) return
        setDraft('')
        save(addresses.concat([{ address: trimmed, enabled: true }]))
      }

      return h(React.Fragment, null,
        rows,
        h('div', { className: 'cfp-addrRow' },
          h('input', {
            className: 'cfp-input',
            type: 'text',
            value: draft,
            placeholder: '添加一个探测域名',
            spellCheck: false,
            disabled: disabled === true,
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => { if (event.key === 'Enter') add() },
          }),
          h('button', {
            type: 'button',
            className: 'cfp-btn',
            disabled: disabled === true || draft.trim().length === 0,
            onClick: add,
          }, '添加')),
        h('div', { className: 'cfp-actions' },
          h('button', {
            type: 'button',
            className: 'cfp-btn is-ghost',
            disabled: disabled === true,
            onClick: onResetDefaults,
          }, '恢复默认地址')))
    }

    /**
     * 地址文本：失焦提交。放在单独组件里，是为了让每行的编辑态不随列表刷新
     * 被整体重置。
     */
    function AddressText({ value, onCommit, disabled, placeholder }) {
      const [text, setText] = useState(value)
      const [focused, setFocused] = useState(false)

      useEffect(() => {
        if (!focused) setText(value)
      }, [value, focused])

      return h('input', {
        className: 'cfp-input',
        type: 'text',
        value: text,
        placeholder,
        spellCheck: false,
        disabled,
        onFocus: () => setFocused(true),
        onBlur: () => { setFocused(false); onCommit(text) },
        onChange: (event) => setText(event.target.value),
        onKeyDown: (event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
          if (event.key === 'Escape') { setText(value); event.currentTarget.blur() }
        },
      })
    }

    /**
     * 皮肤选项。id 与后端 normalizeSkin 的白名单一一对应——
     * 加新皮肤要同时改三处：这里、lib/types.js 的 SkinId、index.js 的 normalizeSkin。
     *
     * 注意 id 与画法不再同名：'ring' 现在画的是 circle 的 02 辐条方案
     * （用户要求用它替换同心圆）。id 不能改，否则已存配置会失效。
     */
    const SKIN_CHOICES = [
      { id: 'ring-core', name: '环芯', desc: '外环覆盖读候选，内芯点亮读当前' },
      { id: 'afterglow', name: '余温', desc: '光晕铺多远读候选，中心多亮读当前' },
    ]

    /** 设置页里的静态缩略图：用固定延迟画一颗，不连真实状态。 */
    /** 设置页里的静态缩略图：用固定档位画一颗，不连真实状态。 */
    function SkinPreview({ id }) {
      return h(SkinGlyph, { skin: id, current: 'excellent', candidate: 'good' })
    }
    function ConfigPage(props) {
      // 宿主传 view: 'summary' | 'page'。summary 只用于插件那一行的摘要，
      // page 才是整页配置。
      //
      // 原来的写法是 `props?.view === 'page' ? 'page' : 'summary'`——把**任何**
      // 拿不到 view 的情况（属性没传、键名变了、宿主版本不同）都静默降级成
      // summary，结果就是用户点进去只看到一行字，一个开关都没有，而且不报错。
      // 那正是我们反复说过不能接受的那种「界面在撒谎」。
      //
      // 现在的判据反过来：只有**明确**说自己是 summary 才渲染摘要，其余一律
      // 渲染完整页。少见的异常情况应该表现为「配置页出现了」，而不是「配置消失了」。
      const view = props?.view === 'summary' ? 'summary' : 'page'
      const { snapshot, error } = useSnapshot()
      // 设置默认展开：用户打开这一页就是想看设置，不需要再点一次。
      const [settingsOpen, setSettingsOpen] = useState(true)
      const [notice, setNotice] = useState(null)
      const [busyAction, setBusyAction] = useState('')
      const [confirmReset, setConfirmReset] = useState(false)
      // 「取消固定」的二次确认：它动的是用户的 hosts，和恢复默认一样值得停一拍。
      const [confirmUnpin, setConfirmUnpin] = useState(false)
      const [paths, setPaths] = useState(null)

      if (view === 'summary') return h(ConfigSummary, { snapshot })
      if (snapshot === null) {
        // 读不到快照时不能只留一行字就走人：用户打开配置页是想**做事**的。
        // 这里给出重试入口和实际错误，否则「点进去什么都没有」跟插件坏了没区别。
        return h('div', { className: 'cfp-page' },
          h(Styles),
          h('div', { className: 'cfp-note' },
            error === null ? '正在读取状态…' : '读不到宿主状态：' + String(error.message ?? error)),
          h('div', { className: 'cfp-actions' },
            h('button', {
              type: 'button',
              className: 'cfp-btn',
              onClick: () => { void store.refresh() },
            }, '重试')))
      }

      const config = snapshot.config ?? {}
      const derived = snapshot.derived ?? {}
      const copy = copyOf(snapshot.state)
      // 长动作（检测 / 写入）期间锁住控件；日常保存只锁动作按钮。
      const busy = busyAction !== ''
      const locked = busyAction === 'scan' || busyAction === 'apply'
      /**
       * 引擎侧的手动状态。**只用于两个动作按钮**，不参与 `locked`。
       *
       * 这是轮 4 那条根因的漏网之鱼：图标点测速时引擎已经把 phase 设成 scan，
       * 但配置页读的是自己的本地 `busyAction`，于是切过来看还是「立即检测」、
       * 按下去还会在引擎里并发再跑一次扫描（现在引擎把它合并掉了，但按钮
       * 仍然在撒谎）。
       *
       * 刻意**不**把 `locked` 也接上去：那会让图标那边的测速顺手锁死整页开关，
       * 用户在另一个会话点一下图标，回来发现设置全灰了。§1.5 也明确
       * `busyAction` 这类「我正在做什么」应当留在组件里。
       */
      const manual = snapshot.manual ?? { phase: '', busy: false, note: '' }
      const remoteBusy = manual.busy === true
      const remoteLabel = manual.phase === 'scan' ? '检测中…'
        : manual.phase === 'brake' ? '收尾中…'
          : manual.phase === 'write' ? '写入中…'
            : ''

      const say = (text, isError) => setNotice({ text, isError: isError === true })

      const saveConfig = async (patch, label) => {
        setBusyAction(label)
        try {
          const value = await store.run(() => call('config', { config: patch }))
          setNotice(null)
          return value
        } catch (cause) {
          say('保存失败：' + String(cause.message ?? cause), true)
          return null
        } finally {
          setBusyAction('')
        }
      }

      const saveAddresses = async (list) => {
        setBusyAction('addresses')
        try {
          await store.run(() => call('addresses', { addresses: list }))
          setNotice(null)
        } catch (cause) {
          say('地址保存失败：' + String(cause.message ?? cause), true)
        } finally {
          setBusyAction('')
        }
      }

      // 只重置地址列表，不连带其他配置。
      const resetAddresses = async () => {
        setBusyAction('addresses')
        try {
          const result = await store.run(() => call('addresses/reset', {}))
          say(result?.saved === false
            ? '已恢复默认地址，但没能写进配置文件'
            : '探测地址已恢复默认')
        } catch (cause) {
          say('恢复默认地址失败：' + String(cause.message ?? cause), true)
        } finally {
          setBusyAction('')
        }
      }

      const doScan = async () => {
        setBusyAction('scan')
        say('正在检测，大约 1 分钟…')
        try {
          // rescan:true —— 用户点的检测必须真的重新扫，不能拿这一轮旧结果糊弄他。
          // 后端现在也默认重扫，这里显式传一次，两边都表明意图。
          const result = await store.run(() => call('scan', { rescan: true }))
          say('检测完成，拿到 ' + (result?.candidates?.length ?? 0) + ' 个候选')
        } catch (cause) {
          say('检测失败：' + String(cause.message ?? cause), true)
        } finally {
          setBusyAction('')
        }
      }

      // 用户点的「立即切换」不讲条件：不问 confirm，不等二次确认。
      // 后端也不会再返回 needs-confirm（那道拦截已按用户要求删除）。
      const doApply = async () => {
        setBusyAction('apply')
        say('正在写入…')
        try {
          const result = await store.run(() => call('apply', {}))
          const ips = result?.ips ?? []
          const written = ips.length > 0 ? '已写入 ' + ips.join('、') : '已写入'
          // 0 个合格候选时后端也会真的写入（相对择优），结果带 degraded。
          // 这行提示是用户唯一的知情渠道，不能吞掉。
          say(written + (result?.degraded === true ? '（全部偏慢，按相对择优写入）' : ''))
        } catch (cause) {
          say('写入失败：' + String(cause.message ?? cause), true)
        } finally {
          setBusyAction('')
        }
      }

      // 取消固定：删掉 hosts 里的 CLOUDFLARE-PIN 标记段、回退系统 DNS。
      //
      // 这是「所有候选都不值得固定」时插件内唯一的逃生口：以前全劣化时既不能
      // 自动换、手动换也被拒，用户只能去跑 cf_pin.py。它只动标记段，不改配置，
      // 也不进 switchLog（不是一次切换）。
      const doUnpin = async () => {
        setBusyAction('unpin')
        say('正在取消固定…')
        try {
          await store.run(() => call('unpin', {}))
          setConfirmUnpin(false)
          say('已取消固定，回退系统 DNS')
        } catch (cause) {
          say('取消固定失败：' + String(cause.message ?? cause), true)
        } finally {
          setBusyAction('')
        }
      }

      const doReset = async () => {
        setBusyAction('reset')
        try {
          await store.run(() => call('reset', {}))
          setConfirmReset(false)
          say('已恢复默认设置')
        } catch (cause) {
          say('恢复默认失败：' + String(cause.message ?? cause), true)
        } finally {
          setBusyAction('')
        }
      }

      const doReveal = async () => {
        try {
          const value = await call('reveal', {})
          setPaths(value)
        } catch (cause) {
          say('读不到文件位置：' + String(cause.message ?? cause), true)
        }
      }

      const switchRow = (label, help, checked, name) => h('div', {
        className: 'cfp-item',
      },
        h('div', { className: 'cfp-itemMain' },
          h('div', { className: 'cfp-itemLabel' }, label),
          h('div', { className: 'cfp-itemHelp' }, help)),
        h('div', { className: 'cfp-itemCtl' },
          h(Switch, {
            checked,
            label,
            disabled: locked,
            onChange: (next) => { void saveConfig({ [name]: next }, name) },
          })))

      const numberRow = (label, help, field, min, max, unit) => h('div', {
        className: 'cfp-item',
      },
        h('div', { className: 'cfp-itemMain' },
          h('div', { className: 'cfp-itemLabel' }, label),
          help ? h('div', { className: 'cfp-itemHelp' }, help) : null),
        h('div', { className: 'cfp-itemCtl' },
          h(NumberField, {
            value: field.value,
            min,
            max,
            unit,
            ariaLabel: label,
            disabled: locked,
            onCommit: (next) => { void saveConfig({ [field.key]: next }, field.key) },
          })))

      return h('div', { className: 'cfp-page' },
        h(Styles),

        h('div', { className: 'cfp-statusRow' },
          h(Dot, { tone: copy.tone }),
          h('span', null, copy.text)),
        h(Facts, { snapshot }),

        h('div', { className: 'cfp-actions' },
          h('button', {
            type: 'button',
            className: 'cfp-btn',
            disabled: busy || remoteBusy,
            onClick: doScan,
          }, busyAction === 'scan'
            ? '检测中…'
            : (manual.phase === 'scan' || manual.phase === 'brake' ? remoteLabel : '立即检测')),
          h('button', {
            type: 'button',
            className: 'cfp-btn',
            disabled: busy || remoteBusy,
            // 一次点击就写入，不再有「确认写入」二次状态。
            onClick: () => { void doApply() },
          }, busyAction === 'apply'
            ? '写入中…'
            : (manual.phase === 'write' ? remoteLabel : '立即切换')),
          h('button', {
            type: 'button',
            className: 'cfp-btn is-ghost',
            onClick: doReveal,
          }, '文件位置'),
          // 取消固定：全劣化时的逃生口。复用「恢复默认」的两段式确认，
          // 第一下只换文案，第二下才真的动 hosts。
          h('button', {
            type: 'button',
            className: 'cfp-btn is-ghost',
            disabled: busy || remoteBusy,
            onClick: () => (confirmUnpin ? void doUnpin() : setConfirmUnpin(true)),
          }, busyAction === 'unpin'
            ? '取消中…'
            : (confirmUnpin ? '确认取消固定？' : '取消固定（恢复系统 DNS）')),
          confirmUnpin
            ? h('button', {
              type: 'button',
              className: 'cfp-btn is-ghost',
              onClick: () => setConfirmUnpin(false),
            }, '取消')
            : null,
          notice === null ? null : h('span', {
            className: 'cfp-notice' + (notice.isError ? ' is-error' : ''),
          }, notice.text)),

        paths === null ? null : h('div', { className: 'cfp-note cfp-mono', style: { marginTop: '8px' } },
          h('div', null, paths.dataDir),
          h('div', null, paths.state),
          h('div', null, paths.hosts)),

        // ---- 设置：**一个**二级折叠，含全部参数。
        //
        // 原来是「自动切换」一段 + 「高级」再一段，等于配置页 → 分区 → 高级
        // 三层；用户要的是两级。所以这里收成一个折叠头，里面按「怎么切」「怎么测」
        // 两小组排列——组只是视觉分节，不再各自可折叠，层次仍是一级入口。
        h('section', { className: 'cfp-section' },
          h('button', {
            type: 'button',
            className: 'cfp-advHead',
            'aria-expanded': settingsOpen ? 'true' : 'false',
            onClick: () => setSettingsOpen((value) => !value),
          },
            h(Chevron, { open: settingsOpen }),
            '设置'),

          settingsOpen ? h('div', { className: 'cfp-advBody' },

            h('h4', { className: 'cfp-sub' }, '图标皮肤'),
            h('div', { className: 'cfp-item' },
              h('div', { className: 'cfp-itemMain' },
                h('div', { className: 'cfp-itemHelp' },
                  '横幅上那枚图标的样子。两颗新皮肤都是「一颗图标同时读当前与候选」：'
                  + '左半是当前线路，右半是候选线路。'))),
            h('div', { className: 'cfp-skins', role: 'radiogroup', 'aria-label': '图标皮肤' },
              SKIN_CHOICES.map((choice) => {
                const active = (snapshot.config?.skin ?? 'ring-core') === choice.id
                return h('button', {
                  key: choice.id,
                  type: 'button',
                  role: 'radio',
                  'aria-checked': active ? 'true' : 'false',
                  className: 'cfp-skinChoice' + (active ? ' is-active' : ''),
                  disabled: locked,
                  onClick: () => {
                    if (active) return
                    void saveConfig({ skin: choice.id }, 'skin')
                  },
                },
                  h('span', { className: 'cfp-skinPreview', 'aria-hidden': 'true' },
                    h(SkinPreview, { id: choice.id })),
                  h('span', { className: 'cfp-skinName' }, choice.name),
                  h('span', { className: 'cfp-skinDesc' }, choice.desc))
              })),

            h('h4', { className: 'cfp-sub' }, '显示'),
            switchRow(
              '在输入框显示图标',
              '关掉后输入框左上角不再出现这枚图标，测量与自动切换照常进行。',
              config.showUi !== false,
              'showUi',
            ),

            h('h4', { className: 'cfp-sub' }, '怎么切'),
            switchRow(
              '链路变慢时自动切换',
              '关掉后只测量、不改 hosts；手动切换仍然可用。',
              snapshot.autoWrite === true,
              'autoWrite',
            ),
            // 每日切换上限已按用户要求删除：那一项原本在这里（「每天最多自动
            // 切换 N 次」）。删它不只是省一个输入框——它是唯一会让「该切不切」
            // 的自动侧闸门，与「烂死在一条线路上」直接冲突。
            numberRow(
              '切换阈值',
              '候选要快过当前这么多，才值得切换。',
              { key: 'switchThresholdMs', value: config.switchThresholdMs ?? 150 },
              0, 5000, 'ms'),

            h('h4', { className: 'cfp-sub' }, '怎么测'),
            h(DerivedReadout, { snapshot }),
            h('div', { className: 'cfp-note' },
              '测量方式：每个候选测 ' + Math.round((derived.windowMs ?? 0) / 1000)
              + ' 秒，' + (derived.candidateCount ?? 0) + ' 个候选轮完算一轮。'),
            switchRow(
              '回复进行中也探测',
              '关掉后，回复进行中不测量，等空闲再测。',
              config.probeWhileThinking === true,
              'probeWhileThinking',
            ),
            numberRow(
              '并发数',
              '同时测几个候选。改它，一轮时长和轮间隔都会跟着变。',
              { key: 'candidateConcurrency', value: config.candidateConcurrency ?? 2 },
              1, 12, '个'),
            // 候选轮间隔是**推导值**，不给输入框：它由「并发数 → 一轮时长」算出，
            // 用户没有独立可调的理由。只读展示，并说清是谁决定的。
            h('div', { className: 'cfp-item' },
              h('div', { className: 'cfp-itemMain' },
                h('div', { className: 'cfp-itemLabel' },
                  '候选轮间隔 ' + (config.roundIntervalMin ?? 0) + ' 分钟'),
                h('div', { className: 'cfp-itemHelp' },
                  '由并发数自动算出（' + (derived.candidateCount ?? 12) + ' 个候选 ÷ '
                  + (config.candidateConcurrency ?? 2) + ' 并发 × '
                  + Math.round((derived.slotMs ?? 25000) / 1000) + ' 秒），不能单独修改。')),
              h('div', { className: 'cfp-itemCtl' },
                h('span', { className: 'cfp-derived' },
                  (config.roundIntervalMin ?? 0) + ' 分钟'))),
            h('div', { className: 'cfp-item' },
              h('div', { className: 'cfp-itemMain' },
                h('div', { className: 'cfp-itemLabel' }, '当前线路采样间隔'),
                h('div', { className: 'cfp-itemHelp' },
                  '测当前 IP 的频率，影响发现变慢的速度。')),
              h('div', { className: 'cfp-itemCtl' },
                h(NumberField, {
                  value: Math.round((config.currentProbeMs ?? 6000) / 1000),
                  min: 1,
                  max: 60,
                  unit: '秒',
                  ariaLabel: '当前线路采样间隔（秒）',
                  disabled: locked,
                  onCommit: (next) => {
                    void saveConfig({ currentProbeMs: next * 1000 }, 'currentProbeMs')
                  },
                }))),

            h('h4', { className: 'cfp-sub' }, '探测地址'),
            h('div', { className: 'cfp-item' },
              h('div', { className: 'cfp-itemMain' },
                h('div', { className: 'cfp-itemHelp' },
                  '只有勾选的地址参与测量和写入。地址写错会让所有状态看起来像「没测到」。'))),
            h(AddressList, {
              snapshot,
              disabled: locked,
              onSave: (list) => { void saveAddresses(list) },
              onResetDefaults: () => { void resetAddresses() },
            }),

            h('div', { className: 'cfp-actions' },
              h('button', {
                type: 'button',
                className: 'cfp-btn',
                disabled: locked,
                onClick: () => (confirmReset ? void doReset() : setConfirmReset(true)),
              }, confirmReset ? '确认恢复默认？' : '恢复默认设置'),
              confirmReset
                ? h('button', {
                  type: 'button',
                  className: 'cfp-btn is-ghost',
                  onClick: () => setConfirmReset(false),
                }, '取消')
                : null))
            : null))
    }

    /**
     * 插件详情页里的设置区块。
     *
     * 详情页会为**每一个** subject 派发这个 slot（别人的包、某个 row 的配置页、
     * 官方插件）。只有本包自己的页面才该出现这些控件，所以这里做门禁：
     * 不是本包就直接返回 null。
     *
     * 门禁必须放在**没有 hook 的外层包装**里。写在 hooks 之后会让 React 在
     * 两次渲染之间看到不同的 hook 数量而报错——所以带 hooks 的本体拆成了
     * ConfigPage，只有本包的页面才会挂载它。
     *
     * 注意 subject 的形状：bundle 页是 `{ kind: 'bundle', pkg: { name, … } }`，
     * row 的配置页是 `{ kind: 'row', pkg, row }`，官方插件是
     * `{ kind: 'package', … }`。包名在 `subject.pkg.name`，不在 subject 顶层。
     */
    function DetailSettingsSection(props) {
      if (props?.subject?.pkg?.name !== PACKAGE_NAME) return null
      // 详情页这一块是要「直接看到设置」的，所以按 page 视图渲染，
      // 不经过插件的二级页面。
      return h('div', { className: 'cfp-detailSection' }, h(ConfigPage, { view: 'page' }))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 插件详情页（bundle 页）：设置直接铺在这里，不用再点进「优选线路」。
        ctx.slots.inject('plugins.detail.section', () => ctx.slots.register({
          name: 'plugins.detail.section',
          id: 'cf-pin-settings',
          order: 40,
          label: () => '优选线路设置',
        }, DetailSettingsSection))

        // 配置页：保留。插件那一行的「配置」仍能打开同一套设置。
        ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config',
          key: '@local/dsh-cf-pin#cf-pin',
        }, ConfigPage))

        // 会话横幅
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'cf-pin-banner',
          order: 30,
        }, Banner))
      },
    }
  },
})
