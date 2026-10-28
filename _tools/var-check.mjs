// Ground truth: extract the theme's variable DECLARATION SET from app.asar, then
// check every --dsw-* the plugin uses against it.
//
// Declaration = the name appears immediately followed by ":" inside one of the
// big "a{--dsw-...:value;--dsw-...:value;...}" theme blocks. We find those blocks
// by locating the known anchor "--dsw-static-neutral-bluish-00" chain instead of
// regex-matching the whole 180MB file.
import fs from 'node:fs'

const ASAR = 'C:\\Users\\Administrator\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar'
const CLIENT = 'C:\\Users\\Administrator\\dsh-plugins\\cf-pin\\client.js'

const asar = fs.readFileSync(ASAR).toString('latin1')
const src = fs.readFileSync(CLIENT, 'utf8')

// Collect declarations by scanning for "--dsw-" then reading the token name and
// checking the very next char is ':' (declaration) rather than ')' or ',' (usage).
const declared = new Set()
const RE = /--dsw-[a-z0-9-]+/g
let m
while ((m = RE.exec(asar)) !== null) {
  const after = asar[m.index + m[0].length]
  if (after === ':') declared.add(m[0])
}

const used = new Set()
for (const mm of src.matchAll(/var\((--dsw-[a-z0-9-]+)/g)) used.add(mm[1])

const missing = [...used].filter((n) => !declared.has(n)).sort()
const ok = [...used].filter((n) => declared.has(n)).sort()

console.log(`宿主题里声明的 --dsw-* 变量: ${declared.size}`)
console.log(`插件用到: ${used.size}`)
console.log(`\n有定义 (${ok.length}): ${ok.join(', ')}`)
console.log(`\n未定义 (${missing.length}):`)
for (const n of missing) console.log(`   MISSING  ${n}`)

// Suggest the closest real name for each missing one.
function suggest(name) {
  const base = name.replace('--dsw-alias-', '').replace('--dsw-', '')
  const cands = [...declared].filter((d) => {
    const db = d.replace('--dsw-alias-', '').replace('--dsw-', '')
    return db.includes(base.split('-')[0]) || base.includes(db.split('-')[0])
  })
  return cands.slice(0, 5)
}
if (missing.length > 0) {
  console.log('\n候选替代：')
  for (const n of missing) console.log(`   ${n} -> ${suggest(n).join(' | ') || '(无相近)'}`)
}
process.exit(missing.length === 0 ? 0 : 1)
