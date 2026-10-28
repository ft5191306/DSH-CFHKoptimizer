// 逐条核对 handoff 文档的 UI 要求与 client.js 实际实现。
// 用法：node _tools/audit-ui.mjs
import fs from 'node:fs'
import path from 'node:path'

const s = fs.readFileSync(path.join(import.meta.dirname, '..', 'client.js'), 'utf8')

const say = (ok, label, detail = '') =>
  console.log((ok ? '  OK    ' : '  **MISS** ').padEnd(11) + label + (detail ? '  — ' + detail : ''))

console.log('=== 文档 §三 UI：配置页必须包含全部参数 ===')
const params = [
  ['autoWrite', '自动切换'],
  ['currentProbeMs', '当前探测间隔 6000'],
  ['candidateConcurrency', '候选并发'],
  ['roundIntervalMin', '轮间隔'],
  ['switchThresholdMs', '切换阈值 150'],
  ['maxSwitchesPerDay', '每日上限 12'],
  ['probeWhileThinking', '思考中探测'],
]
for (const [key, label] of params) {
  const hit = s.includes(`'${key}'`) || s.includes(`.${key}`)
  say(hit, `${label} (${key})`)
}

console.log('\n=== 文档 §三 UI：地址列表「可改可加，每项带启用勾选」===')
say(/address\.enabled/.test(s) || /\.enabled\b/.test(s), '读取每项 enabled')
say(/setAddresses|addresses'\)/.test(s) || /call\('addresses'/.test(s), '增删改地址（调 addresses 端点）')
say(/addresses\/reset/.test(s), '恢复默认地址')

console.log('\n=== 横幅：三格点阵，一个可见字都没有 ===')
const bannerStart = s.indexOf('// -------------------------------------------------------------- 横幅')
const bannerFn = s.slice(bannerStart)
const bannerBody = bannerFn.slice(0, bannerFn.indexOf('// ------------------------------------------------------------ 配置页'))
say(bannerBody.length > 0, 'Banner 存在')
say(/cfp-current/.test(bannerBody) && /cfp-cand/.test(bannerBody)
  && /cfp-stream/.test(bannerBody), '当前 / 流式 / 候选 三格齐全')
say(/cfp-sr/.test(bannerBody), '读屏文案单独放进 cfp-sr')
say(!/cfp-row|cfp-metric|cfp-label/.test(s), '没有可展开的行按钮与内联文字')
say(!/onClick/.test(bannerBody), '横幅不可点击')
say(/data-current/.test(bannerBody) && /data-best/.test(bannerBody)
  && /data-stream/.test(bannerBody) && /data-cur-lit/.test(bannerBody),
  '状态写进 data-* 供调试与断言')
say(/function qualityOf/.test(s), '延迟换算成质量，决定点亮几颗点')
say(/is-stale/.test(bannerBody) && /is-blocked/.test(bannerBody)
  && /is-held/.test(bannerBody), '过期/被挡/被限制的候选改成慢呼吸')
say(/is-alert/.test(bannerBody) && /is-dead/.test(bannerBody), '全劣化/断网有整体态')
say(/cfp-orb/.test(bannerBody) && /is-arrive/.test(bannerBody)
  && /is-donor/.test(bannerBody), '换线时飞光点 + 落地回弹')
say(/@keyframes cfp-handoff/.test(s) && /@keyframes cfp-complete/.test(s)
  && /@keyframes cfp-wave/.test(s), '动效关键帧在样式里')
say(/cfp-dock\{position:relative;display:flex;justify-content:flex-start/.test(s), '贴住输入框左上角')
say(/prefers-reduced-motion[\s\S]{0,700}\.cfp-orb,\.cfp-ring\{display:none\}/.test(s),
  '减弱动效时停掉位移')

console.log('\n=== 文档 §三 UI：降级徽标（需要管理员/等待写入/切换过多/无合格候选）===')
for (const st of ['need-admin', 'waiting-write', 'daily-limit', 'no-candidate']) {
  say(s.includes(`'${st}'`), `状态码 ${st} 有文案`)
}

console.log('\n=== 文档：「无 enabled 开关」——不该有插件启用开关 ===')
say(!/启用插件|pluginEnabled|setEnabled/.test(s), '没有额外的插件启用开关')

console.log('\n=== 配置页三层结构 ===')
say(s.includes('高级'), '有「高级」折叠区')
say(s.includes('测量方式'), '有「测量方式」只读说明（20s 窗口）')
say(/roundDurationMs/.test(s), '有并发→一轮时长的派生读数')

console.log('\n=== 手动两按钮「永不禁用」===')
const hasScan = s.includes('立即检测')
const hasApply = s.includes('立即切换')
say(hasScan, '「检测」按钮存在')
say(hasApply, '「写入」按钮存在（立即切换）')
// 检查 disabled 条件：不应受 autoWrite 影响
const applyBtn = s.slice(s.indexOf("busyAction === 'apply'") - 600, s.indexOf("busyAction === 'apply'"))
say(!/autoWrite/.test(applyBtn), '写入按钮不受 autoWrite 影响')


