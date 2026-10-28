/**
 * hosts 读写：与 cf_pin.py 逐字节同语义。
 *
 * 这里的每一条规则都来自 cf_pin.py，不是自拟：
 *   - 只动 CLOUDFLARE-PIN 标记段，其余内容原样保留（含未知注释、其他工具的段）
 *   - 换行符沿用旧文件（Windows hosts 是 CRLF），写入不翻译、不加 BOM
 *   - 写前备份，**单份 hosts.bak 覆盖**（无时间戳增量，与插件外的手动模式一致）
 *   - 原子替换 os.replace 最多 4 次退避，仍被占用则退化为原地重写
 *   - 写完 `ipconfig /flushdns`，不等待、不校验、不观察
 *
 * 与 Python 版的唯一差别：备份文件名固定为 `hosts.bak`，
 * 而不是 `hosts.bak.<时间戳>`。这是本次设计明确要求的改动（单份覆盖），
 * 并且 cf_pin.py 侧同步改成一致语义。
 *
 * @module @local/dsh-cf-pin/lib/hosts
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

/** 标记段起止行。任何字节变化都会让旧段无法被识别，不要改。 */
export const BEGIN_MARK = '# >>> CLOUDFLARE-PIN BEGIN (managed by cf_pin.py) >>>'
export const END_MARK = '# <<< CLOUDFLARE-PIN END <<<'

/**
 * hosts 的绝对路径。
 *
 * 认 %SystemRoot%，与 cf_pin.py 一致（有些机器的 Windows 不在 C:）。
 * 这是 32/64 位无关的写法：不经过 SysWOW64 重定向，因为 Node 进程与宿主同位数。
 *
 * @returns {string}
 */
export function hostsPath() {
  const root = process.env.SystemRoot ?? 'C:\\Windows'
  return path.join(root, 'System32', 'drivers', 'etc', 'hosts')
}

/**
 * 读 hosts。
 *
 * 用 utf8 + 替换字符解码、保留原始换行，与 cf_pin.py 的
 * `open(..., encoding="utf-8", errors="replace", newline="")` 等价。
 * 注意：非 UTF-8 的旧注释会在下一次写入时被替换字符破坏——这是原工具的既有行为，
 * 保持它是为了两边语义一致，不是这里想修的 bug。
 *
 * @param {string} [file]
 * @returns {string}
 */
export function readHosts(file = hostsPath()) {
  return fs.readFileSync(file, 'utf8')
}

/**
 * 探测换行符。只要出现过 CRLF 就整段用 CRLF，与 cf_pin `detect_eol` 一致。
 *
 * @param {string} text
 * @returns {'\r\n' | '\n'}
 */
export function detectEol(text) {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

/**
 * 去掉标记段（含标记行本身）。
 *
 * 按 Python `str.splitlines(keepends=True)` 的分隔集合来切，
 * 而不是 `split(/\r?\n/)`：旧文件里若混入 \f、\u2028 等，切法不同会让
 * 段边界落在错误的位置。这里保留同样的分隔符集合，行为才对得上。
 *
 * @param {string} text
 * @returns {string}
 */
export function stripBlock(text) {
  const out = []
  let skipping = false
  for (const line of splitLinesKeepEnds(text)) {
    const bare = pythonStrip(line)
    if (bare === BEGIN_MARK) { skipping = true; continue }
    if (bare === END_MARK) { skipping = false; continue }
    if (!skipping) out.push(line)
  }
  return out.join('')
}

/**
 * 渲染标记段。域名在外层、IP 在内层——同一域名的多个 IP 必须相邻，
 * 这是 cf_pin `render_block` 的形状，也是「候选 ≥2 写 2 个」的顺序表达。
 *
 * @param {readonly string[]} ips  按优劣排序，最优在前
 * @param {readonly string[]} domains
 * @param {'\r\n' | '\n'} [eol]
 * @returns {string}
 */
export function renderBlock(ips, domains, eol = '\r\n') {
  const lines = [BEGIN_MARK]
  for (const domain of domains) {
    for (const ip of ips) lines.push(`${ip} ${domain}`)
  }
  lines.push(END_MARK)
  return lines.join(eol) + eol
}

/**
 * 读出当前 pin 段里的 IP 与域名。
 *
 * 返回的顺序是**文件里的出现顺序**（IP 去重、保持首次出现位置），
 * 因为「当前 IP」的语义是「标记段第一行」，不是排序后的第一个。
 *
 * @param {string} text
 * @returns {{ ips: string[], domains: string[] }}
 */
export function currentPin(text) {
  const ips = []
  const domains = []
  let inside = false
  for (const line of splitLinesKeepEnds(text)) {
    const bare = pythonStrip(line)
    if (bare === BEGIN_MARK) { inside = true; continue }
    if (bare === END_MARK) { inside = false; continue }
    if (!inside || bare.length === 0 || bare.startsWith('#')) continue
    const parts = bare.split(/\s+/)
    if (parts.length >= 2) {
      if (!ips.includes(parts[0])) ips.push(parts[0])
      if (!domains.includes(parts[1])) domains.push(parts[1])
    }
  }
  return { ips, domains }
}

/**
 * 把标记段替换成新的 IP 集合，同时保留文件其余部分。
 *
 * @param {string} text
 * @param {readonly string[]} ips
 * @param {readonly string[]} domains
 * @returns {string}
 */
export function composeHosts(text, ips, domains) {
  const eol = detectEol(text)
  let base = stripBlock(text)
  if (base.length > 0 && !/[\r\n]$/.test(base)) base += eol
  return base + renderBlock(ips, domains, eol)
}

/**
 * 写 hosts：备份 → 原子替换（4 次退避）→ 原地重写兜底。
 *
 * @param {string} newText
 * @param {{ file?: string, backup?: boolean }} [options]
 * @returns {{ mode: 'atomic' | 'in-place', backup: string | null }}
 */
export function writeHosts(newText, options = {}) {
  const file = options.file ?? hostsPath()
  const backup = options.backup !== false

  let backupFile = null
  if (backup && fs.existsSync(file)) {
    backupFile = file + '.bak'
    fs.copyFileSync(file, backupFile)
  }

  const tmp = file + '.cfpin.tmp'
  fs.writeFileSync(tmp, newText, 'utf8')

  // 一级：原子替换。hosts 是全系统被盯得最紧的文件之一，DNS 客户端 / 杀软 /
  // 索引器都会短暂打开它；这期间 os.replace 会拿到 ACCESS_DENIED / SHARING_VIOLATION，
  // 而且通常几十毫秒后就自己消失。所以退避重试，而不是立刻报「权限不足」。
  const delays = [150, 400, 800, 1500]
  for (let attempt = 0; attempt < delays.length; attempt++) {
    try {
      fs.renameSync(tmp, file)
      return { mode: 'atomic', backup: backupFile }
    } catch (error) {
      if (!isTransientReplaceError(error)) {
        unlinkQuietly(tmp)
        throw error
      }
      if (attempt === delays.length - 1) break
      sleepSync(delays[attempt])
    }
  }

  // 二级：原地重写。保留原文件的 ACL / 属性 / 硬链接，只是不再原子。
  fs.writeFileSync(file, newText, 'utf8')
  unlinkQuietly(tmp)
  return { mode: 'in-place', backup: backupFile }
}

/**
 * 刷新 DNS 缓存。**不等待结果、不重试、不观察**——这是设计的明确要求：
 * 写完刷完即结束，不做写入后观察，也不自动切回。
 */
export function flushDns() {
  try {
    const child = spawn('ipconfig', ['/flushdns'], { stdio: 'ignore', windowsHide: true })
    child.on('error', () => {})
    child.unref()
  } catch {
    // 刷不动就算了：hosts 已经写进去了，缓存过期后自然生效
  }
}

/**
 * 旧版 Node 没有真正的同步 sleep，这里用一个极短的忙等。
 * 只用在上面的退避里（最长 1.5s，最多 3 次），不会占用探测节奏。
 *
 * @param {number} ms
 */
function sleepSync(ms) {
  const end = Date.now() + ms
  while (Date.now() < end) { /* spin */ }
}

/**
 * 判断 rename 失败是不是「被短暂独占」，值得重试。
 *
 * Windows 上三种错误码对应同一类现象：文件正被别的进程打开着看一眼。
 * 其它错误（真的没权限、路径不存在）必须立刻抛，不要浪费时间重试。
 *
 * @param {unknown} error
 * @returns {boolean}
 */
function isTransientReplaceError(error) {
  const code = /** @type {any} */ (error)?.code
  if (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY') return true
  const winerror = /** @type {any} */ (error)?.winerror
  return winerror === 5 || winerror === 32 || winerror === 33
}

/** @param {string} file */
function unlinkQuietly(file) {
  try { fs.unlinkSync(file) } catch { /* 已经没了 */ }
}

/**
 * 复刻 Python `str.splitlines(keepends=True)` 的切分。
 *
 * 分隔符集合（Python 文档）：\n \r \r\n \v \f \x1c \x1d \x1e \x85 \u2028 \u2029。
 * 用 JS 的 split(/\r?\n/) 会在这些字符上切错，段边界因此偏移。
 *
 * @param {string} text
 * @returns {string[]}
 */
export function splitLinesKeepEnds(text) {
  return text.match(/[^\r\n\v\f\x1c-\x1e\x85\u2028\u2029]*(?:\r\n|[\r\n\v\f\x1c-\x1e\x85\u2028\u2029]|$)/g)
    ?.filter((line) => line.length > 0) ?? []
}

/**
 * 复刻 Python `str.strip()` 的空白集合（含 \x1c-\x1f、\x85、NBSP）。
 * JS 的 `trim()` 少了 \x1c-\x1f、多了 \uFEFF，标记行是否匹配会不一样。
 *
 * @param {string} value
 * @returns {string}
 */
export function pythonStrip(value) {
  return value.replace(/^[\s\x1c-\x1f\x85\u00a0]+|[\s\x1c-\x1f\x85\u00a0]+$/g, '')
}
