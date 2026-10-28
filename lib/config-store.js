/**
 * 配置的持久化。
 *
 * 为什么不用宿主 settings 服务：那一层要求字段声明为 `.volatile()` 才可实时编辑，
 * 且写的是 profile patch（整段替换语义，会覆盖掉补丁里的同名字段）。这里的配置
 * 全是本插件自用的运行参数，没有跨插件可见的需要，所以落在自己的数据目录里：
 * 语义单一、重启后可恢复、不需要改动 profile。
 *
 * 优先级：数据目录里的 config.json > cordis.patch.yml 里的 config > 内置默认值。
 * 面板改的每一项都写进 config.json，因此重启后仍然生效。
 *
 * @module @local/dsh-cf-pin/lib/config-store
 */

import fs from 'node:fs'
import path from 'node:path'

/** 文件名。 */
const FILE = 'config.json'

/**
 * 读持久化配置。
 *
 * @param {string} dataDir
 * @returns {Record<string, unknown> | null}
 */
export function readPersistedConfig(dataDir) {
  try {
    const file = path.join(dataDir, FILE)
    if (!fs.existsSync(file)) return null
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    // 配置坏了不能拦住插件启动：按「没有持久化配置」处理，用默认值继续。
    return null
  }
}

/**
 * 写持久化配置。
 *
 * @param {string} dataDir
 * @param {import('./types.js').PinConfig} config
 * @returns {boolean} 是否写成功
 */
export function writePersistedConfig(dataDir, config) {
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(path.join(dataDir, FILE), JSON.stringify(config, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

export { FILE as CONFIG_FILE }
