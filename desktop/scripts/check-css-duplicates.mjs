import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import postcss from 'postcss'

const cssFiles = process.argv.slice(2)
const targets = cssFiles.length > 0 ? cssFiles : ['src/index.css']
const duplicates = []

for (const target of targets) {
  const absolute = path.resolve(target)
  const root = postcss.parse(fs.readFileSync(absolute, 'utf8'), { from: absolute })
  const seen = new Map()

  root.walkRules((rule) => {
    const ancestry = []
    let parent = rule.parent
    while (parent && parent.type !== 'root') {
      ancestry.unshift(parent.type === 'atrule'
        ? `@${parent.name} ${parent.params}`
        : parent.selector)
      parent = parent.parent
    }
    const declarations = rule.nodes
      .map((node) => node.toString().replace(/\s+/g, ' ').trim())
      .join(';')
    const key = JSON.stringify([ancestry, rule.selector, declarations])
    const existing = seen.get(key)
    if (existing) {
      duplicates.push({
        target,
        selector: rule.selector,
        firstLine: existing,
        duplicateLine: rule.source?.start?.line ?? 0,
      })
    } else {
      seen.set(key, rule.source?.start?.line ?? 0)
    }
  })
}

if (duplicates.length > 0) {
  console.error('Exact duplicate CSS rules found:')
  for (const duplicate of duplicates) {
    console.error(
      `- ${duplicate.target}:${duplicate.duplicateLine} duplicates `
      + `${duplicate.target}:${duplicate.firstLine} (${duplicate.selector})`,
    )
  }
  process.exitCode = 1
} else {
  console.log(`No exact duplicate CSS rules found in ${targets.join(', ')}.`)
}
