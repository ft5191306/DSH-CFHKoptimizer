// 只读：查宿主 composer 相关容器的 CSS 是否裁剪（overflow / contain / clip / z-index）。
// 用法: node _tools\clip-check.mjs <classSubstring...>
import fs from 'node:fs'

const ASAR = 'C:\\Users\\Administrator\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar'
const buf = fs.readFileSync(ASAR)
const text = buf.toString('latin1')

const needles = process.argv.slice(2)
if (needles.length === 0) needles.push('composerStack')

for (const needle of needles) {
  console.log(`\n########## ${needle} ##########`)
  let at = 0
  let n = 0
  while (true) {
    at = text.indexOf(needle, at)
    if (at === -1) break
    n++
    // 取一段窗口，尽量覆盖该选择器所在的 CSS 规则
    const from = Math.max(0, at - 260)
    const chunk = text.slice(from, at + 900)
    // 只打印看起来像 CSS 的片段（含 { 和 : ）
    if (chunk.includes('{') && chunk.includes(':')) {
      console.log(`--- @${at} ---`)
      console.log(chunk.replace(/\\n/g, '\n').replace(/\\"/g, '"'))
    }
    at += needle.length
    if (n > 24) { console.log(`…(>${n})`); break }
  }
  console.log(`(${n} hits)`)
}
