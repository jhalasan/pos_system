const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const markdown = fs.readFileSync(path.join(root, 'USER_MANUAL.md'), 'utf8')

function escapeRtf(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/[^\x00-\x7F]/g, (char) => `\\u${char.charCodeAt(0)}?`)
}

const body = markdown.split(/\r?\n/).map((source) => {
  const line = source.trim()
  if (!line) return '\\par'
  const heading = line.match(/^(#{1,3})\s+(.+)$/)
  if (heading) {
    const size = heading[1].length === 1 ? 36 : heading[1].length === 2 ? 30 : 26
    return `\\par\\keepn\\b\\fs${size} ${escapeRtf(heading[2].replace(/\*\*/g, ''))}\\b0\\fs22\\par`
  }
  if (line.startsWith('- ')) return `\\pard\\li360\\fi-180 \\bullet\\tab ${escapeRtf(line.slice(2).replace(/\*\*/g, ''))}\\par\\pard`
  if (/^\d+\.\s/.test(line)) return `\\pard\\li360\\fi-180 ${escapeRtf(line.replace(/\*\*/g, ''))}\\par\\pard`
  return `${escapeRtf(line.replace(/\*\*/g, '').replace(/\*/g, ''))}\\par`
}).join('\n')

const rtf = `{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Calibri;}}\\viewkind4\\uc1\\f0\\fs22\n${body}\n}`
fs.writeFileSync(path.join(root, 'USER_MANUAL.rtf'), rtf)
console.log('Saved:', path.join(root, 'USER_MANUAL.rtf'))
