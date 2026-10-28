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
 * 视觉纪律：
 *  - 条长 = 延迟量级（60ms 起跳，760ms 顶满），颜色只做第二通道；
 *  - 当前是实心条，候选是空心轨 + 半透明填充，过期的候选换成斜线纹理；
 *  - 没有数据就是空轨，不做假读数；
 *  - hosts 真的换了 IP 时，一枚亮条从候选格滑进当前格，同时当前格扩散一圈；
 *  - `prefers-reduced-motion` 下所有位移与循环动画停掉，只留状态色。
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-cf-pin',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useReducer, useRef } = React

    const POLL_MS = 4000
    const FLASH_MS = 320
    /** 换线动画在屏幕上停留的时长；飞行本身 520ms，留一点余量给收尾。 */
    const SWAP_MS = 640
    /** 回复结束时完成环的时长，与 CSS 里的 .9s 对齐。 */
    const COMPLETE_MS = 940
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
      const response = await fetch('/api/dsh-cf-pin/' + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
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
      observing: { text: '不用处理 · 有更快的线路，但差距不够', tone: 'idle' },
      'auto-off': { text: '有更快的线路，但自动切换是关的', tone: 'idle' },
      'waiting-write': { text: '有更快的线路，等这条回复结束就切', tone: 'work' },
      'no-candidate': { text: '没有更好的线路，继续用当前的', tone: 'idle' },
      'all-degraded': { text: '当前线路偏慢，也没有更好的可选', tone: 'warn' },
      offline: { text: '网络连不上，暂停检测', tone: 'idle' },
      'probe-failed': { text: '这一轮没测到数据，稍后自动重试', tone: 'idle' },
      'daily-limit': { text: '今天不再自动切换了', tone: 'idle' },
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

    /** 换线被挡住的三种情形：候选格不闪作「可以挪」，改成慢呼吸。 */
    function holdOf(state) {
      if (state === 'need-admin') return 'blocked'
      if (state === 'auto-off' || state === 'daily-limit') return 'held'
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
       * scan / apply 进行中时暂停轮询，避免和一轮 1 分钟的检测抢链路、也避免
       * 拿到半截状态。
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

      async function refresh() {
        if (inflight || busy > 0) return
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
/* 告警文字：只在需要用户动手时出现（权限 / 上限 / 断网等）。
   刻意做小、做淡——它是提示不是警告弹窗，不能盖过点阵本身。 */
.cfp-warn{flex:none;font-size:11.5px;line-height:16px;letter-spacing:.01em;
  color:var(--dsw-alias-state-warn-primary);white-space:nowrap;
  animation:cfp-warn-in .22s ease both}
.cfp-warn::before{content:"·";margin-right:5px;opacity:.7}
/* 断网用中性色：这不是插件的错，用户也没法通过插件解决。 */
.cfp-cluster.is-dead .cfp-warn{color:var(--dsw-alias-label-tertiary)}
.cfp-cluster.is-alert .cfp-warn{color:var(--dsw-alias-state-error-primary,#d9534f)}
@keyframes cfp-warn-in{from{opacity:0;transform:translateX(-3px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.cfp-warn{animation:none}}
/* 断网 / 全劣化：整颗图标压暗或缓慢明暗，表示真的慢。 */
.cfp-cluster.is-dead .cfp-skin{opacity:.5}
.cfp-cluster.is-dim{opacity:.55}
.cfp-cluster.is-alert .cfp-skin{animation:cfp-alert 2.4s ease-in-out infinite}
.cfp-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;
  clip-path:inset(50%);white-space:nowrap;border:0}
.cfp-dot{flex:none;width:6px;height:6px;border-radius:50%;
  background:var(--dsw-alias-label-tertiary,#8b8f96)}
.cfp-dot.is-ok{background:var(--dsw-alias-state-success-primary)}
.cfp-dot.is-work{background:var(--dsw-alias-state-business-primary)}
.cfp-dot.is-warn{background:var(--dsw-alias-state-warn-primary)}
.cfp-text{flex:0 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cfp-chev{flex:none;margin-left:auto;display:inline-flex;align-items:center;
  color:var(--dsw-alias-label-tertiary,#8b8f96);transition:transform .18s ease}
.cfp-chev.is-open{transform:rotate(90deg)}
.cfp-mono{font-family:var(--dsh-font-family-code-default,ui-monospace,Consolas,monospace);font-size:11.5px}
.cfp-muted{color:var(--dsw-alias-label-tertiary)}

.cfp-page{box-sizing:border-box;max-width:760px;padding:16px 20px 28px;
  color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55}
.cfp-statusRow{display:flex;align-items:center;gap:8px;margin:0 0 10px;
  font-size:15px;line-height:22px}
.cfp-statusRow .cfp-dot{width:7px;height:7px}
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
.cfp-h{margin:0 0 8px;font-size:12px;font-weight:600;letter-spacing:.02em;
  color:var(--dsw-alias-label-secondary)}
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
@keyframes cfp-breathe{0%,100%{opacity:.4}50%{opacity:.9}}
@keyframes cfp-wave{0%,100%{opacity:.16;transform:scale(.84)}50%{opacity:.95;transform:scale(1.14)}}
@keyframes cfp-throb{0%,100%{transform:scale(1)}50%{transform:scale(1.32)}}
@keyframes cfp-punch{0%{transform:scale(1)}38%{transform:scale(1.17)}100%{transform:scale(1)}}
@keyframes cfp-complete{0%{opacity:.95;transform:scale(.24)}70%{opacity:.45}
  100%{opacity:0;transform:scale(1)}}
@keyframes cfp-hold{0%,100%{opacity:.42}50%{opacity:.74}}
@keyframes cfp-ready{0%,52%,100%{opacity:.78}68%{opacity:1}}
@keyframes cfp-alert{0%,100%{opacity:.5}50%{opacity:1}}
@keyframes cfp-arrive{0%{transform:scale(.93);opacity:.55}58%{transform:scale(1.07)}
  100%{transform:scale(1);opacity:1}}
@keyframes cfp-handoff{0%{opacity:0;transform:translate3d(64.2px,0,0) scale(.7)}
  16%{opacity:.95}74%{opacity:.95;transform:translate3d(12px,0,0) scale(1.15)}
  100%{opacity:0;transform:translate3d(1.2px,0,0) scale(.7)}}
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
.cfp-skin{display:block;flex:none;overflow:visible;width:25px;height:25px;
  /* transform-box 必须显式给：SVG 元素的默认变换基准与 HTML 不同，
     不写的话 rotate 可能绕画布左上角转，而不是绕图标中心。 */
  transform-box:view-box;transform-origin:center}
/* ---- 测速：分段旋转（与设计稿 spinWhile 一致）----
   原来只有缩放到 0.94 的脉冲，缺少真正的旋转，看起来像「在呼吸」而不是「在测速」。
   设计稿是四段：
     起步加速 600ms → 匀速高速 620ms/圈 → 刹车 1400ms → 停在 180° 整数倍
   这里用 CSS 三条动画接力（CSS 无法读当前角度做接力，所以用两段常速 + 一段减速，
   并由 JS 在测速结束时切到「刹车」状态）。 */
/* 测速期间的旋转由外层 .cfp-skin 负责（两种皮肤通用）。
   太极内部还有一层待机 60s 慢转，必须让位，否则会叠成「转两遍、速度打架」。 */
.cfp-cluster.is-busy .cfp-skin{animation:cfp-spin-up .6s cubic-bezier(.45,0,.85,.45) 1,
  cfp-spin-loop .62s linear .6s infinite}
.cfp-cluster.is-busy .cfp-taiji .t-motion,
.cfp-cluster.is-busy .cfp-taiji[data-tier='poor'] .t-tremor,
.cfp-cluster.is-busy .cfp-taiji[data-tier='fair'] .t-tremor{animation:none}
/* 刹车：测速收尾时把 loop 换成一次缓停。用 data-probe 标记阶段。 */
.cfp-cluster.is-busy[data-probe-phase='brake'] .cfp-skin{
  animation:cfp-spin-brake 1.4s cubic-bezier(.08,.62,.22,1) 1 both}
@keyframes cfp-spin-up{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
@keyframes cfp-spin-loop{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
@keyframes cfp-spin-brake{
  from{transform:rotate(0deg)}
  to{transform:rotate(540deg)}}
/* 交接旋转只给辐条：太极内部有自己的 .t-spin 层，
   两条规则同时命中会让它转两次（变成 360° 且节奏被两段动画争抢）。 */
.cfp-cluster.is-swap .cfp-spokes{animation:cfp-handoff-spin .56s cubic-bezier(.55,0,.15,1)}

/* ---- 辐条（circle 02）：点从中心沿 10 根辐条向外点亮 ---- */
.cfp-spoke-base{fill:var(--dsw-alias-label-tertiary,#8b8f96);opacity:.28}
.cfp-spoke-lit{transition:opacity .26s ease,fill .55s ease}
/* 候选读数是借来的（启动时还没测速）：整体压淡，表明「这不是测出来的数」。 */
.cfp-cluster.is-borrowed .cfp-skin{opacity:.72}
.cfp-cluster.is-borrowed .cfp-taiji{--cfp-eye:1}

/* ---- 太极（circle2）：实心=当前，空心=候选；两侧各自被延迟侵蚀 ----
   显示尺寸 25px、viewBox 64 —— 比例约 0.39。设计稿在 25px 下就是这套描边值，
   所以这里**不要**按 25 再缩一遍：CSS 的 stroke-width 作用在 viewBox 坐标系里，
   缩放由外层 width 完成。 */
.cfp-taiji .t-ink{stroke:var(--cfp-ink,var(--dsw-alias-label-primary,#e7f0eb))}
.cfp-taiji .t-outline{fill:none;stroke-width:2.6}
.cfp-taiji .t-s{fill:none;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}
.cfp-taiji .t-half-l{fill:var(--cfp-ink,var(--dsw-alias-label-primary,#e7f0eb))}
.cfp-taiji .t-half-r{fill:transparent}
.cfp-taiji .t-eye{transform-box:fill-box;transform-origin:center;
  transform:scaleY(var(--cfp-eye,1));transition:transform .32s ease}
.cfp-taiji .t-eye-disc{transition:fill .32s ease}
.cfp-taiji .t-eye-top .t-eye-disc{fill:var(--cfp-plate,var(--dsw-alias-bg-layer-1,#16161a))}
.cfp-taiji .t-eye-bottom .t-eye-disc{fill:var(--cfp-ink,var(--dsw-alias-label-primary,#e7f0eb))}
.cfp-taiji .t-half,.cfp-taiji .t-eye-disc{transition:fill .32s ease}

/* 三层动效容器必须用 view-box 作为变换基准，否则 rotate 会绕错点。 */
.cfp-taiji .t-motion,
.cfp-taiji .t-tremor,
.cfp-taiji .t-spin{transform-box:view-box;transform-origin:50% 50%}

/* 待机：每分钟匀速一圈。设计稿的 idle-turn 是 60s，这里照抄——
   慢到几乎察觉不到「在转」，但眼睛会发现它在动，这就是待机感。 */
.cfp-taiji .t-motion{animation:cfp-idle-turn 60s linear infinite}
/* 抖动按「两侧里更差的那一档」决定强度：差档肉眼可见，中档缓慢。 */
.cfp-taiji[data-tier='poor'] .t-tremor{animation:cfp-tremor .14s steps(2,end) infinite}
.cfp-taiji[data-tier='fair'] .t-tremor{animation:cfp-tremor-soft 3.4s ease-in-out infinite}
/* 交接：一次 180° 急转；转的时候停掉待机转和抖动，避免叠成一团。 */
.cfp-cluster.is-swap .cfp-taiji .t-spin{
  animation:cfp-handoff-spin .56s cubic-bezier(.55,0,.15,1) both}
.cfp-cluster.is-swap .cfp-taiji .t-motion,
.cfp-cluster.is-swap .cfp-taiji[data-tier='poor'] .t-tremor,
.cfp-cluster.is-swap .cfp-taiji[data-tier='fair'] .t-tremor{animation:none}

@keyframes cfp-idle-turn{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
@keyframes cfp-tremor{
  0%,100%{transform:translate(0,0) rotate(0)}
  25%{transform:translate(-1.6px,.6px) rotate(-1.5deg)}
  50%{transform:translate(1.3px,-.4px) rotate(1.1deg)}
  75%{transform:translate(-.6px,-.8px) rotate(-.9deg)}}
@keyframes cfp-tremor-soft{
  0%,100%{transform:translateY(0)}
  50%{transform:translateY(.7px) rotate(.4deg)}}

@keyframes cfp-handoff-spin{
  0%{transform:rotate(0deg) scale(1)}
  58%{transform:rotate(190deg) scale(1.06)}
  100%{transform:rotate(180deg) scale(1)}}

@media (prefers-reduced-motion: reduce){
  .cfp-chev,.cfp-switch,.cfp-switch::after,.cfp-derive{transition:none}
  .cfp-skin,.cfp-skinBtn,.cfp-cluster.is-busy .cfp-skin,
  .cfp-cluster.is-swap .cfp-skin,.cfp-cluster.is-alert .cfp-skin,
  .cfp-cluster.is-swap .cfp-spokes,
  /* 太极的三层动效全部停掉：待机转、抖动、交接急转。 */
  .cfp-taiji .t-motion,.cfp-taiji .t-tremor,.cfp-taiji .t-spin,
  .cfp-taiji[data-tier='poor'] .t-tremor,
  .cfp-taiji[data-tier='fair'] .t-tremor{
    animation:none!important;transition:none!important}
  .cfp-taiji .t-eye{transition:none}
}`

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

    // -------------------------------------------------------------- 横幅

    /**
     * composer 左上角的一枚网络状态图标。一个字的正文都没有：
     * 形状说两侧延迟，动效说刚换没换线。读屏文案在 cfp-sr 里（视觉隐藏），
     * 不违背「不要文字」。
     *
     * 皮肤只剩两种：辐条（circle 的 02 方案）与太极（circle2 的小图标）。
     * 三格点阵已按用户要求删除——它把「当前 / 流式 / 候选」摊成三个并排小图，
     * 而这两套皮肤是「一颗图标同时读两侧」，后者更省地方，也更符合原设计。
     */

    /**
     * 延迟 → 点亮程度（0–1）。380ms 及以内算「优秀」，点满一圈；
     * 越慢点亮的外环越少，700ms 六颗、900ms 三颗、1200ms 只剩尖端。
     */
    function qualityOf(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return 0
      const stops = [[60, 0.96], [380, 0.78], [700, 0.55], [1000, 0.36], [1400, 0.12], [2000, 0.04]]
      if (ms <= stops[0][0]) return stops[0][1]
      for (let i = 1; i < stops.length; i += 1) {
        const [x1, y1] = stops[i]
        if (ms <= x1) {
          const [x0, y0] = stops[i - 1]
          return y0 + (y1 - y0) * ((ms - x0) / (x1 - x0))
        }
      }
      return stops[stops.length - 1][1]
    }

    const TONE = {
      good: 'var(--dsw-alias-state-success-primary)',
      mid: 'var(--dsw-alias-state-warn-primary)',
      // 曾经写的是 --dsw-alias-label-error：宿主题里没有这个变量（405 个已声明变量里
      // 不含它），SVG fill 拿到未定义变量会退回**黑色**，于是「慢」的红色点阵在深色
      // 背景上直接消失。真正存在的是 state-error-primary。
      bad: 'var(--dsw-alias-state-error-primary,#d9534f)',
    }

    /** 分档只用来给不支持颜色插值的环境兜底，正常走 tintOf 的渐变。 */
    function baseToneOf(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return ''
      if (ms <= 380) return 'good'
      if (ms <= 900) return 'mid'
      return 'bad'
    }

    /**
     * 延迟 → 点阵颜色。380ms 及以内是「优秀」的绿，之后连续渐变到琥珀，
     * 再往深里渐变到红——中间没有硬跳档，阈值只改渐变起点。
     */
    function tintOf(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return ''
      if (ms <= 380) return TONE.good
      if (ms <= 900) {
        const part = Math.round(((ms - 380) / (900 - 380)) * 100)
        return 'color-mix(in oklab, ' + TONE.mid + ' ' + part + '%, ' + TONE.good + ')'
      }
      if (ms <= 1500) {
        const part = Math.round(((ms - 900) / (1500 - 900)) * 100)
        return 'color-mix(in oklab, ' + TONE.bad + ' ' + part + '%, ' + TONE.mid + ')'
      }
      return TONE.bad
    }

    /**
     * 一颗点被点亮多少：质量越高，越外圈的点也开始亮。
     *
     * @param {number} quality 0–1
     * @param {number} order 该点在第几圈（0 最内）
     * @param {number} [span] 一个质量单位能点亮几圈。辐条只有 3 圈，
     *   用原来同心环的 4.9 会在 380ms 就把三圈全点亮，所以这里按圈数收窄。
     */
    function litOf(quality, order, span = 4.9) {
      const t = Math.max(0, Math.min(1, quality * span - order))
      return t * t * (3 - 2 * t)
    }

    // ------------------------------------------------------ 皮肤：单图标

    /**
     * 辐条点阵（来自 circle-matrix 的 02 方案）。
     *
     * 左右各 5 根辐条、每根 3 颗点，加一颗圆心点：右半圆属于当前线路，
     * 左半圆属于候选。延迟越好，点亮的圈数越多——读法与其他皮肤一致，
     * 但形状是「向外放射」而不是「同心环」，在 25px 下更容易分辨方向。
     *
     * 坐标沿用设计稿的 30×30 坐标系（圆心 15,15）。
     */
    const SPOKE_DOTS = (() => {
      // 右半：-72° 到 72°，等分 5 根；左半：108° 到 252°，同样 5 根。
      // 两半各自对称，交接（左右互换）后形状仍然成立。
      const spokes = { r: [-72, -36, 0, 36, 72], l: [108, 144, 180, 216, 252] }
      const radii = [4.2, 7.7, 11.1]
      const out = []
      Object.keys(spokes).forEach((side) => {
        spokes[side].forEach((deg) => {
          radii.forEach((radius, ring) => {
            const rad = (deg * Math.PI) / 180
            out.push({
              x: 15 + radius * Math.cos(rad),
              y: 15 + radius * Math.sin(rad),
              o: ring,
              side,
            })
          })
        })
      })
      // 圆心：算作最内一圈，两侧都会点亮它，读作「两条线共同的起点」。
      out.push({ x: 15, y: 15, o: 0, side: 'c' })
      return out
    })()

    /** 一个质量单位点亮几圈：辐条只有 3 圈。 */
    const SPOKE_SPAN = 3.6

    /** 辐条皮肤。25px 显示、30×30 坐标系（与设计稿一致）。 */
    function SpokeIcon({ curQuality, bestQuality, curMs, bestMs }) {
      const dots = []
      SPOKE_DOTS.forEach((dot, index) => {
        // 设计稿约定：左半 = 当前线路，右半 = 候选（与 circle-matrix 一致）。
        // 圆心两侧共用：取更好的一侧，避免两条线都在圆心处变暗。
        const isCurrent = dot.side === 'l'
        const quality = dot.side === 'c'
          ? Math.max(curQuality, bestQuality)
          : (isCurrent ? curQuality : bestQuality)
        const ms = dot.side === 'c'
          ? (curQuality >= bestQuality ? curMs : bestMs)
          : (isCurrent ? curMs : bestMs)
        const amount = litOf(quality, dot.o, SPOKE_SPAN)
        const radius = dot.side === 'c' ? 1.15 : 1.02
        dots.push(h('circle', {
          key: 'b' + index,
          className: 'cfp-spoke-base',
          cx: dot.x.toFixed(2),
          cy: dot.y.toFixed(2),
          r: radius,
        }))
        dots.push(h('circle', {
          key: 'l' + index,
          className: 'cfp-spoke-lit',
          cx: dot.x.toFixed(2),
          cy: dot.y.toFixed(2),
          r: (radius + 0.14 * amount).toFixed(2),
          // 颜色必须走 style，不能写成 fill 属性。
          // SVG 的表现属性**不接受 var()**（那只在 CSS 声明里成立），
          // 传进去会被判为非法值并退回默认黑色——深色背景上等于隐形。
          // 这是本项目栽过一次的同一类 bug（见 README 里 quaternary 那条）。
          style: {
            fill: tintOf(ms) || 'var(--dsw-alias-label-tertiary,#8b8f96)',
            opacity: amount.toFixed(3),
          },
        }))
      })
      return h('svg', {
        className: 'cfp-skin cfp-spokes',
        viewBox: '0 0 30 30',
        'aria-hidden': 'true',
        focusable: 'false',
      }, dots)
    }

    const TAIJI_LEFT_HALF = 'M32 2A15 15 0 0 1 32 32A15 15 0 0 0 32 62A30 30 0 0 1 32 2Z'
    const TAIJI_RIGHT_HALF = 'M32 2A15 15 0 0 1 32 32A15 15 0 0 0 32 62A30 30 0 0 0 32 2Z'
    const TAIJI_S = 'M32 2A15 15 0 0 1 32 32A15 15 0 0 0 32 62'
    /** 外环拆成左右两条弧，才能让两侧按各自档位独立侵蚀。 */
    const TAIJI_ARC_LEFT = 'M32 2A30 30 0 0 0 32 62'
    const TAIJI_ARC_RIGHT = 'M32 2A30 30 0 0 1 32 62'

    /** 延迟 → 四档（与皮肤原设计一致的阈值）。 */
    function erodeTierOf(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return 'poor'
      if (ms <= 400) return 'excellent'
      if (ms <= 500) return 'good'
      if (ms <= 600) return 'fair'
      return 'poor'
    }

    /**
     * 侵蚀缺口：角度 + 半径。全部落在 150°–230° 一段，
     * 左右两侧各用自己那份，所以两侧的破损互不影响。
     */
    const EROSION = {
      excellent: [],
      good: [[197, 5.2]],
      fair: [[204, 4.6], [190, 3.6], [176, 2.8]],
      poor: [[214, 11.2], [200, 8.6], [187, 6.6], [175, 5], [163, 3.8], [151, 2.8], [229, 3.2]],
    }
    const EYE_OPEN = { excellent: 1, good: 0.78, fair: 0.5, poor: 0.2 }

    function taijiMask(id, tier, mirrored) {
      const holes = (EROSION[tier] || []).map(([deg, radius], index) => {
        const angle = ((mirrored ? deg + 180 : deg) * Math.PI) / 180
        return h('circle', {
          key: 'h' + index,
          cx: (32 + 30 * Math.cos(angle)).toFixed(2),
          cy: (32 + 30 * Math.sin(angle)).toFixed(2),
          r: radius,
          fill: '#000',
        })
      })
      return h('mask', {
        id,
        maskUnits: 'userSpaceOnUse',
        x: 0,
        y: 0,
        width: 64,
        height: 64,
      }, h('rect', { width: 64, height: 64, fill: '#fff' }), holes)
    }

    /**
     * 遮罩 id 必须在组件的**整个生命周期内稳定**。
     *
     * 原实现每次渲染都 taijiUid += 1，于是每 4 秒的轮询刷新都会换一套 id。
     * React 在提交阶段先更新 defs、再更新引用它的 g，中间那一瞬 g 还指向已被
     * 移除的旧 mask；mask 引用不到就按「完全裁掉」处理——用户看到的就是
     * 「图标一闪而过然后消失」。用 useRef 固定一个 id，重新渲染时不再变。
     */
    let taijiIdSeed = 0

    function useStableId() {
      const ref = useRef(null)
      if (ref.current === null) {
        taijiIdSeed += 1
        ref.current = 'cfp-taiji-' + taijiIdSeed
      }
      return ref.current
    }

    /**
     * 太极皮肤。
     *
     * 实心 = 当前线路，空心 = 候选线路；两侧各自按自己的延迟被侵蚀，
     * 眼睑取两侧里更差的那一档——眼睛是一对，不能左睁右闭。
     */
    function TaijiIcon({ curMs, bestMs }) {
      const curTier = erodeTierOf(curMs)
      const bestTier = erodeTierOf(bestMs)
      const uid = useStableId()
      const idLeft = uid + '-l'
      const idRight = uid + '-r'
      // 两侧都不应在「没有数据」时显得完好，所以取更差的一档。
      // 注意方向：order 越大表示越差，所以取**大**的那个。
      const eyeTier = curQualityOrder(curTier) >= curQualityOrder(bestTier) ? curTier : bestTier

      return h('svg', {
        className: 'cfp-skin cfp-taiji',
        viewBox: '0 0 64 64',
        'aria-hidden': 'true',
        focusable: 'false',
        'data-tier': eyeTier,
        style: { '--cfp-eye': String(EYE_OPEN[eyeTier] ?? 1) },
      },
        h('defs', null,
          taijiMask(idLeft, curTier, false),
          taijiMask(idRight, bestTier, true)),
        // 三层动效容器，与设计稿同构（顺序不能反）：
        //   icon-motion → 待机 60s 一圈（最慢的外层）
        //   icon-tremor → 按档位抖动（差档肉眼可见，中档缓慢）
        //   icon-spin   → 交接时的急转（一次性）
        // 分开三层是因为三者要能叠加：抖动期间照样在转，交接时停掉前两者。
        h('g', { className: 't-motion' },
          h('g', { className: 't-tremor' },
            h('g', { className: 't-spin' },
              h('g', { mask: 'url(#' + idLeft + ')' },
                h('path', { className: 't-half t-half-l', d: TAIJI_LEFT_HALF }),
                h('path', { className: 't-ink t-outline', d: TAIJI_ARC_LEFT })),
              h('g', { mask: 'url(#' + idRight + ')' },
                h('path', { className: 't-half t-half-r', d: TAIJI_RIGHT_HALF }),
                h('path', { className: 't-ink t-outline', d: TAIJI_ARC_RIGHT })),
              h('path', { className: 't-ink t-s', d: TAIJI_S }),
              h('g', { className: 't-eye t-eye-top' },
                h('circle', { className: 't-eye-disc', cx: 32, cy: 17, r: 5.4 })),
              h('g', { className: 't-eye t-eye-bottom' },
                h('circle', { className: 't-eye-disc', cx: 32, cy: 47, r: 5.4 }))))))
    }

    /** 档位排序用：数值越大越差，用来挑「两侧里更差的」。 */
    function curQualityOrder(tier) {
      return { excellent: 0, good: 1, fair: 2, poor: 3 }[tier] ?? 3
    }

    function Banner(props) {
      const { snapshot, error } = useSnapshot()
      const [swap, setSwap] = useState(false)
      const [complete, setComplete] = useState(false)
      const [probing, setProbing] = useState(false)
      const [probePhase, setProbePhase] = useState('')
      const [probeNote, setProbeNote] = useState('')
      const previous = useRef(null)
      const previousStream = useRef(null)
      const swapTimer = useRef(0)
      const doneTimer = useRef(0)
      const probeTimer = useRef(0)
      const brakeTimer = useRef(0)

      // 只有 current.ip 真的变了（或宿主记了新的 lastSwitch）才播换线动画。
      useEffect(() => {
        const before = previous.current
        previous.current = snapshot
        if (snapshot === null || before === null) return
        const movedIp = before.current && snapshot.current
          && before.current.ip !== snapshot.current.ip
        const movedAt = snapshot.lastSwitch && before.lastSwitch
          && before.lastSwitch.at !== snapshot.lastSwitch.at
        if (!movedIp && !movedAt) return
        setSwap(true)
        clearTimeout(swapTimer.current)
        swapTimer.current = setTimeout(() => setSwap(false), SWAP_MS)
      }, [snapshot])

      // 流停下那一刻扩一圈完成环；只在「真的在流」之后才算。
      useEffect(() => {
        const now = snapshot === null ? null : streamOf(snapshot, props)
        const before = previousStream.current
        previousStream.current = now
        if (before !== 'stream' || now !== 'idle') return
        setComplete(true)
        clearTimeout(doneTimer.current)
        doneTimer.current = setTimeout(() => setComplete(false), COMPLETE_MS)
      }, [snapshot, props && props.streaming, props && props.busy])

      useEffect(() => () => {
        clearTimeout(swapTimer.current)
        clearTimeout(doneTimer.current)
        clearTimeout(probeTimer.current)
      }, [])

      /**
       * 点击图标 = 测速 + 写入，走的是配置页那两个真实接口。
       *
       * 刻意**不做**乐观更新：状态只认 /state 快照。因为它真的会改用户的 hosts，
       * 屏幕上不能先假装成功了。
       *
       * 动效按设计稿 spinWhile 的四段来：
       *   加速 600ms → 匀速 620ms/圈（CSS 负责，测速期间一直在转）
       *   → 刹车 1400ms（scan 一结束就切到 brake，缓停）
       *   → 写入。这样「转完了才写」和设计稿的观感一致。
       */
      const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

      const runProbe = async () => {
        if (probing) return
        setProbing(true)
        setProbePhase('spin')
        setProbeNote('测速中…')
        try {
          const scanned = await store.run(() => call('scan', {}))
          const count = scanned?.candidates?.length ?? 0

          // 刹车：让旋转停在一个整齐的角度上，再开始写入。
          // 这段是纯动画时间，不阻塞后端（apply 在它之后才发）。
          setProbePhase('brake')
          await delay(1400)
          setProbePhase('')

          setProbeNote('写入中…')
          try {
            // 用户要求：点击触发的写入不许被任何东西拦住。
            // 所以这里既不等 confirm，也不把 alreadyOptimal 当成「没执行」——
            // 后端现在会真的写一次，这里只负责如实报告写了哪些 IP。
            const applied = await store.run(() => call('apply', {}))
            const ips = applied?.ips ?? []
            setProbeNote(ips.length > 0 ? '已切到 ' + ips.join('、') : '已写入')
          } catch (cause) {
            setProbeNote('写入失败：' + String(cause?.message ?? cause))
          }
          if (count === 0) setProbeNote((prev) => (prev === '' ? '没测到数据' : prev))
        } catch (cause) {
          setProbeNote('测速失败')
        } finally {
          setProbing(false)
          setProbePhase('')
          clearTimeout(brakeTimer.current)
          clearTimeout(probeTimer.current)
          probeTimer.current = setTimeout(() => setProbeNote(''), 4200)
        }
      }

      // 宿主要求：新增 hook 必须在所有提前 return 之前，否则 hook 数量在两次
      // 渲染之间变化，React 直接抛错、整个 slot 被换成错误面。
      // 所以 runProbe 只是一个普通函数，不是 hook。

      // 宿主不可达且从未拿到过快照时，宁可不占位，也不编一个状态。
      if (snapshot === null) return null

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
      const curQuality = currentMs === null || offline ? 0 : qualityOf(currentMs)
      const bestQuality = bestMs === null ? 0 : qualityOf(bestMs)
      const curMs = offline ? null : currentMs

      // 候选够阈值才算「值得挪」；只快一点不催。借用值不参与。
      const advantage = borrowed || typeof snapshot.advantageMs !== 'number'
        ? null
        : snapshot.advantageMs
      const threshold = typeof snapshot.thresholdMs === 'number'
        ? snapshot.thresholdMs
        : (snapshot.config?.switchThresholdMs ?? 150)
      const gap = borrowed
        ? null
        : (advantage !== null
          ? advantage
          : (currentMs !== null && bestMs !== null ? currentMs - bestMs : null))
      const better = gap !== null && gap >= threshold
      const arrow = better || (gap !== null && gap > 0 && gap < threshold)

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

      const orbTone = TONE[baseToneOf(bestMs)] || TONE.good

      /**
       * 告警文字。
       *
       * 纯视觉只能表达「有点不对」，表达不了「为什么没换、你要做什么」。
       * 这两类必须给字，否则用户看到候选格在呼吸，却不知道是要去提权还是等明天：
       *   - need-admin：他能解决（用管理员身份重启）
       *   - daily-limit：他也能解决（临时调高上限，或等明天）
       * 其余状态（正常/观察中/等待写入/无候选/断网）不加字——那些不需要用户动作，
       * 加了就是噪音，违背「平时不打扰」。
       */
      const WARN_TEXT = {
        'need-admin': '需要管理员权限才能切换',
        'daily-limit': '今日已达切换上限',
        'offline': '网络连不上',
        'all-degraded': '当前线路偏慢，且无更好候选',
        'probe-failed': '这一轮没测到数据',
      }
      const warn = WARN_TEXT[snapshot.state] ?? ''

      const candExtra = (stale ? 'is-stale' : '')
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
      const skin = snapshot.config?.skin === 'taiji' ? 'taiji' : 'ring'

      // 点击测速不适用于纯展示：断网时连测都测不了，按钮就是假的。
      const canProbe = !probing && snapshot.state !== 'offline'

      const glyph = skin === 'taiji'
        ? h(TaijiIcon, { key: 'taiji', curMs, bestMs })
        : h(SpokeIcon, {
          key: 'spokes',
          curQuality: offline ? 0 : curQuality,
          bestQuality,
          curMs,
          bestMs,
        })

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
            + (error === null ? '' : ' is-dim'),
          // 测速阶段：'' → spin（加速+匀速）→ brake（缓停）。CSS 靠它切动画。
          'data-probe-phase': probePhase,
          style: { '--cfp-tone': orbTone },
        },
          h('button', {
            type: 'button',
            className: 'cfp-skinBtn',
            'aria-label': spoken + '，点击测速并切换',
            disabled: !canProbe,
            onClick: () => { void runProbe() },
          }, glyph),
          // 告警文字：只有「用户需要做点什么」的状态才出现，其余保持纯视觉。
          warn === '' ? null : h('span', { className: 'cfp-warn' }, warn),
          probeNote === '' ? null : h('span', { className: 'cfp-warn is-probe' }, probeNote)),
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
        : '还没换过'])
      rows.push(['今日切换', (snapshot.switchesToday ?? 0) + ' 次 · 上限 '
        + (snapshot.config?.maxSwitchesPerDay ?? 0) + ' 次'])
      rows.push(['权限', snapshot.admin === true ? '管理员' : '普通用户，无法改写 hosts'])
      rows.push(['hosts', snapshot.hosts?.path || '—'])
      rows.push(['域名', (snapshot.hosts?.currentDomains ?? []).join(', ') || '—'])

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
      { id: 'ring', name: '辐条', desc: '左半当前、右半候选，圈数读速度' },
      { id: 'taiji', name: '太极', desc: '实心当前、空心候选，侵蚀读延迟' },
    ]

    /** 设置页里的静态缩略图：用固定延迟画一颗，不连真实状态。 */
    function SkinPreview({ id }) {
      if (id === 'taiji') {
        return h(TaijiIcon, { curMs: 340, bestMs: 470 })
      }
      return h(SpokeIcon, { curQuality: 0.9, bestQuality: 0.72, curMs: 240, bestMs: 380 })
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
          say(ips.length > 0 ? '已写入 ' + ips.join('、') : '已写入')
        } catch (cause) {
          say('写入失败：' + String(cause.message ?? cause), true)
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
            disabled: busy,
            onClick: doScan,
          }, busyAction === 'scan' ? '检测中…' : '立即检测'),
          h('button', {
            type: 'button',
            className: 'cfp-btn',
            disabled: busy,
            // 一次点击就写入，不再有「确认写入」二次状态。
            onClick: () => { void doApply() },
          }, busyAction === 'apply' ? '写入中…' : '立即切换'),
          h('button', {
            type: 'button',
            className: 'cfp-btn is-ghost',
            onClick: doReveal,
          }, '文件位置'),
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
                const active = (snapshot.config?.skin ?? 'ring') === choice.id
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

            h('h4', { className: 'cfp-sub' }, '怎么切'),
            switchRow(
              '链路变慢时自动切换',
              '关掉后只测量、不改 hosts；手动切换仍然可用。',
              snapshot.autoWrite === true,
              'autoWrite',
            ),
            h('div', { className: 'cfp-item' },
              h('div', { className: 'cfp-itemMain' },
                h('div', { className: 'cfp-itemLabel' },
                  '每天最多自动切换 ' + (config.maxSwitchesPerDay ?? 48) + ' 次'),
                h('div', { className: 'cfp-itemHelp' },
                  '超过这个次数当天就不再自动切换，避免反复折腾你的机器。')),
              h('div', { className: 'cfp-itemCtl' },
                h(NumberField, {
                  value: config.maxSwitchesPerDay ?? 48,
                  min: 1,
                  max: 48,
                  unit: '次',
                  ariaLabel: '每天最多自动切换次数',
                  disabled: locked,
                  onCommit: (next) => { void saveConfig({ maxSwitchesPerDay: next }, 'maxSwitchesPerDay') },
                }))),
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

