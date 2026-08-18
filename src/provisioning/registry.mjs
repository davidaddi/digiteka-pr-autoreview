#!/usr/bin/env node
import { existsSync, renameSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { load } from '../review/config.mjs'

export const ROOT = fileURLToPath(new URL('../../', import.meta.url))
export const FILE = process.env.REPOS_FILE ?? join(ROOT, 'repos.yml')

const STATUS = ['pending', 'active', 'removed']
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

const HEADER = [
  '# Repositories served by the local multi-repo mode.',
  '# One line per repository: owner/name:status',
  '# status is pending (to provision), active (provisioned, runner started) or removed (to tear down).',
  '# src/provisioning/sync-repos.mjs owns this file. The web UI never writes it directly.',
  '',
]

export function slug(entry) {
  return `${entry.owner}/${entry.name}`
}

export function parseSlug(text) {
  const [owner, name, extra] = String(text ?? '').trim().split('/')
  if (!SLUG.test(owner ?? '') || !SLUG.test(name ?? '') || extra !== undefined) {
    throw new Error(`not a repository: ${text}`)
  }
  return { owner, name }
}

function parseEntry(item, index) {
  const at = String(item).lastIndexOf(':')
  const text = at < 0 ? String(item) : String(item).slice(0, at)
  const status = at < 0 ? 'pending' : String(item).slice(at + 1).trim()
  if (!STATUS.includes(status)) throw new Error(`repos.yml entry ${index + 1}: unknown status "${status}"`)
  return { ...parseSlug(text), status }
}

export function read(file = FILE) {
  if (!existsSync(file)) return []
  const repos = load(file).repos
  return Array.isArray(repos) ? repos.map(parseEntry) : []
}

export function write(entries, file = FILE) {
  const body = [...HEADER, 'repos:', ...entries.map((e) => `  - ${slug(e)}:${e.status}`), ''].join('\n')
  const temp = `${file}.tmp`
  writeFileSync(temp, body, { mode: 0o644 })
  renameSync(temp, file)
  return entries
}

export function upsert(entry, file = FILE) {
  const entries = read(file)
  const found = entries.find((e) => e.owner === entry.owner && e.name === entry.name)
  if (found) found.status = entry.status
  else entries.push(entry)
  write(entries, file)
  return found ?? entry
}

export function find(target, file = FILE) {
  return read(file).find((e) => e.owner === target.owner && e.name === target.name)
}

if (process.argv[1]?.endsWith('registry.mjs')) {
  console.log(JSON.stringify(read(), null, 2))
}
