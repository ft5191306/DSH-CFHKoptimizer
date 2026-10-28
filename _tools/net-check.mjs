// 实测探测原语：确认 TLS/TTFB 口径与证书闸门在真链路上成立。
// 用法：node _tools/net-check.mjs
import { certOk, probeDomain, tcpRtt, tlsTrace } from '../lib/probe.js'
import { currentPin, readHosts } from '../lib/hosts.js'

const ips = currentPin(readHosts()).ips
console.log('当前 hosts IP:', ips.join(', '))

// 1) 当前 IP 的快速读数（插件的 6s 采样就是这个形状）
const t0 = performance.now()
const quick = await probeDomain(ips[0], 'open-design.ai', { windowMs: 1200, intervalMs: 100, timeoutMs: 1500 })
console.log(`快速读数 (${Math.round(performance.now() - t0)}ms):`, JSON.stringify(quick))

// 2) 完整 20s 窗口（候选轮的口径）
const t1 = performance.now()
const full = await probeDomain(ips[0], 'open-design.ai', {})
console.log(`完整窗口 (${Math.round((performance.now() - t1) / 1000)}s):`, JSON.stringify(full))

// 3) 机房识别
const trace = await tlsTrace(ips[0])
console.log('colo:', JSON.stringify(trace))

// 4) 证书闸门（应通过）
const cert = await certOk(ips[0], 'amr-link.open-design.ai')
console.log('cert(amr-link):', JSON.stringify(cert))

// 5) 故意用一个错的主机名，确认闸门会拦住
const bad = await certOk('162.159.148.1', 'example.invalid')
console.log('cert(无效域名，应失败):', JSON.stringify(bad))

// 6) TCP 粗筛口径
const rtt = await tcpRtt(ips[0], { tries: 3, timeoutMs: 1200 })
console.log('tcp rtt:', JSON.stringify(rtt))
