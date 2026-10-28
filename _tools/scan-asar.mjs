// 在 app.asar 里定位宿主给 composer / conversation 列用的 CSS 变量与容器宽度。
// 只读：整份缓冲读进内存，按字节扫 ASCII 子串，不解析归档结构。
import fs from 'node:fs'

const ASAR = 'C:\\Users\\Administrator\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar'
const buf = fs.readFileSync(ASAR)
const text = buf.toString('latin1')

/** 收集形如 --dsw-xxx 的变量名（去重）。 */
function collect(needles) {
  const found = new Map()
  for (const needle of needles) {
    let at = 0
    while (true) {
      at = text.indexOf(needle, at)
      if (at === -1) break
      const around = text.slice(at, at + 220)
      found.set(`${needle}@${at}`, around)
      at += needle.length
      if (found.size > 400) break
    }
  }
  return found
}

const needles = process.argv.slice(2)
for (const needle of needles) {
  const hits = collect([needle])
  console.log(`\n===== ${needle} : ${hits.size} 处 =====`)
  let printed = 0
  for (const [key, around] of hits) {
    const at = Number(key.split('@').pop())
    console.log(`--- @${at} ---`)
    console.log(JSON.stringify(around.slice(0, 200)))
    if (++printed >= 8) { console.log(`…（共 ${hits.size} 处）`); break }
  }
}
