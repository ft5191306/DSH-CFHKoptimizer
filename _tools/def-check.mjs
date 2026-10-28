// Precise definition check: look for "--<name>:" OR "<name>:" preceded by --dsw-
// and print the actual defining snippet, so we can tell "defined" from "only referenced".
import fs from 'node:fs'

const ASAR = 'C:\\Users\\Administrator\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar'
const asar = fs.readFileSync(ASAR).toString('latin1')

const names = process.argv.slice(2)
for (const name of names) {
  const needle = name + ':'
  let at = 0
  let found = null
  while (true) {
    at = asar.indexOf(needle, at)
    if (at === -1) break
    // must be a declaration: preceded by start/;/space/{ and the name starts with --
    const before = asar.slice(Math.max(0, at - 40), at)
    if (before.includes('--') || /[;{\s]$/.test(asar.slice(at - 1, at))) {
      const context = asar.slice(Math.max(0, at - 45), at + 90)
      if (/-[-a-z0-9]+$/.test(asar.slice(Math.max(0, at - 30), at + 1)) || before.trim().endsWith('--')) {
        found = context
        break
      }
    }
    at += needle.length
  }
  if (found === null) {
    console.log(`${name}  => NOT DEFINED`)
  } else {
    console.log(`${name}  => DEFINED: ${JSON.stringify(found.replace(/\s+/g, ' ').slice(0, 130))}`)
  }
}
