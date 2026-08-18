#!/usr/bin/env node
import { readFileSync } from 'node:fs'

const FILE = process.env.REVIEW_CONFIG ?? 'review.config.yml'

function scalar(raw) {
  const text = raw.trim()
  if (text.startsWith('[') && text.endsWith(']')) {
    return text
      .slice(1, -1)
      .split(',')
      .map((item) => scalar(item))
      .filter((item) => item !== '')
  }
  if (/^-?\d+$/.test(text)) return Number(text)
  if (text === 'true' || text === 'false') return text === 'true'
  return text.replace(/^["']|["']$/g, '')
}

export function load(file = FILE) {
  const config = {}
  let section = null

  readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.replace(/\s+#.*$/, ''))
    .forEach((line, index) => {
      if (!line.trim() || line.trim().startsWith('#')) return
      const indented = /^\s/.test(line)
      const dash = line.trim().startsWith('- ')

      if (dash) {
        if (!section) throw new Error(`${file}:${index + 1} list item outside a key`)
        const target = config[section.key]
        if (!Array.isArray(target)) config[section.key] = []
        config[section.key].push(scalar(line.trim().slice(2)))
        return
      }

      const match = line.match(/^(\s*)([A-Za-z0-9_]+):\s*(.*)$/)
      if (!match) throw new Error(`${file}:${index + 1} cannot parse: ${line}`)
      const [, indent, key, value] = match

      if (!indented) {
        section = { key, nested: value === '' }
        config[key] = value === '' ? {} : scalar(value)
        return
      }
      if (!section?.nested) throw new Error(`${file}:${index + 1} unexpected indent`)
      if (indent.length === 0) throw new Error(`${file}:${index + 1} bad indent`)
      config[section.key][key] = scalar(value)
    })

  return config
}

if (process.argv[2] === 'get') {
  const path = process.argv[3] ?? ''
  const value = path.split('.').reduce((node, key) => node?.[key], load())
  if (value === undefined) {
    console.error(`unknown config key: ${path}`)
    process.exit(1)
  }
  console.log(Array.isArray(value) ? value.join(',') : String(value))
}
