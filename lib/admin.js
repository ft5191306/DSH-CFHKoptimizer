/**
 * 管理员判定与非提权约束。
 *
 * 设计上的硬规则：**绝不尝试 UAC 提权**。UAC 需要用户在安全桌面自己确认，
 * 插件没有任何办法自动完成，所以「没权限」只能是一个被显示出来的状态，
 * 不能是一个弹窗。
 *
 * @module @local/dsh-cf-pin/lib/admin
 */

import { execFileSync } from 'node:child_process'

/** 缓存：权限在一次进程生命周期内不会变。 */
let cached = null

/**
 * 当前进程是否具备写 hosts 的权限。
 *
 * Windows 上没有 `os.geteuid()`，可用手段是 `net session`（需要管理员才成功）
 * 或读令牌。这里用 `net session`：它由系统自带、无副作用、失败快。
 *
 * @returns {boolean}
 */
export function isAdmin() {
  if (cached !== null) return cached
  if (process.platform !== 'win32') {
    cached = typeof process.getuid === 'function' && process.getuid() === 0
    return cached
  }
  try {
    execFileSync('net', ['session'], { stdio: 'ignore', windowsHide: true, timeout: 5_000 })
    cached = true
  } catch {
    cached = false
  }
  return cached
}

/** 便于自测：重置缓存。 */
export function resetAdminCache() {
  cached = null
}
