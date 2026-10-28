// 对真实 hosts 做只读验证 + 生成一份快照样本给前端契约用。
// 用法：node _tools/live-check.mjs
import { currentPin, readHosts, hostsPath, composeHosts } from '../lib/hosts.js'
import { Engine, resolveDataDir } from '../lib/engine.js'
import { isAdmin } from '../lib/admin.js'

const file = hostsPath()
console.log('hosts 路径 :', file)

const text = readHosts()
const { ips, domains } = currentPin(text)
console.log('当前 IP    :', ips.join(', ') || '（无标记段）')
console.log('生效域名   :', domains.join(', ') || '（无）')
console.log('管理员     :', isAdmin())

// 只在内存里演练一次改写，确认段外内容一个字都不动。
if (ips.length > 0) {
  const next = composeHosts(text, [ips[0]], domains)
  const before = text.length
  const after = next.length
  const outside = (t) => t.replace(/# >>> CLOUDFLARE-PIN BEGIN[\s\S]*?# <<< CLOUDFLARE-PIN END <<<\r?\n/, '')
  console.log('段外内容一致:', outside(text) === outside(next))
  console.log('字符数      :', before, '->', after)
}

const dir = resolveDataDir({ profileDir: process.env.DSH_PROFILE_DIR })
console.log('数据目录   :', dir)

// 【唯一一个刻意读真实 hosts 的测试】它的目的就是核对线上文件的实际状态。
// 因此这里**只读**：绝不调用 engine.apply()。若将来要在这里演练写入，
// 必须像 optimal-check.mjs 那样新建一个 hostsFile 指向临时文件的 Engine。
const engine = new Engine({ dataDir: dir, config: (await import('../lib/engine.js')).defaultConfig(), log: () => {} })
engine.loadState()
engine.reloadFromHosts()
const snap = engine.snapshot()
console.log('\n快照（未探测，冷启动态）:')
console.log(JSON.stringify({
  state: snap.state,
  admin: snap.admin,
  current: snap.current,
  candidates: snap.candidates.length,
  derived: snap.derived,
  hosts: snap.hosts,
  switchesToday: snap.switchesToday,
}, null, 2))
