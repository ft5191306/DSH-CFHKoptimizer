// 打印 app.asar 里指定偏移附近的一段可读文本，用于读宿主源码。
import fs from 'node:fs'

const ASAR = 'C:\\Users\\Administrator\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar'
const buf = fs.readFileSync(ASAR)
const text = buf.toString('latin1')

const start = Number(process.argv[2])
const len = Number(process.argv[3] ?? 1500)
console.log(text.slice(start, start + len))
