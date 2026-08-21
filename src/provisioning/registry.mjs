#!/usr/bin/env node
import { existsSync, renameSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { load } from '../review/config.mjs'

export const ROOT = fileURLToPath(new URL('../../', import.meta.url))
export const FILE = process.env.REPOS_FILE ?? join(ROOT, 'repos.yml')

const STATUS = ['pending', 'active', 'removed']
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
// The optional provider@host: in front of a path. A line without it is a github.com
// repository, which is what every line written before this file knew about GitLab looks like.
const ORIGIN = /^([a-z][a-z0-9-]*)@([^:]+):(.+)$/

const HEADER = [
  '# Repositories served by the local multi-repo mode.',
  '# One line per repository: [provider@host:]path:status',
  '#   owner/name:active                            a github.com repository, the default',
  '#   gitlab@gitlab.com:group/project:active       a gitlab.com project',
  '#   gitlab@gitlab.example.com:g/sub/proj:active  a project on a self-hosted GitLab',
  '# status is pending (to provision), active (provisioned, runner started) or removed (to tear down).',
  '# src/provisioning/sync-repos.mjs owns this file. The web UI never writes it directly.',
  '',
]

export function slug(entry) {
  return `${entry.owner}/${entry.name}`
}

// Entries read from a line without a prefix, and targets built from a bare owner/name, carry
// no provider and no host: that spelling only ever meant a repository on github.com.
function origin(entry) {
  return { provider: entry.provider ?? 'github', host: entry.host ?? 'github.com' }
}

// The identity of a repository, and the only safe key for a map: a GitHub repository, a
// gitlab.com project and a self-hosted GitLab project can all be called group/project, and
// keying on the path alone would silently merge the three.
export function key(entry) {
  const { provider, host } = origin(entry)
  return `${provider}@${host}:${slug(entry)}`.toLowerCase()
}

// How the entry is written in repos.yml, and how it is shown to a human. No prefix on
// github.com, so a file written before this existed round-trips through write() byte for byte.
export function label(entry) {
  const { provider, host } = origin(entry)
  return provider === 'github' && host === 'github.com' ? slug(entry) : `${provider}@${host}:${slug(entry)}`
}

// A GitLab project can sit under nested subgroups, so the namespace is everything before the
// last slash rather than a single owner. On a GitHub owner/name that is the same split as
// before; every segment is still checked on its own.
export function parseSlug(text) {
  const path = String(text ?? '').trim()
  const segments = path.split('/')
  if (segments.length < 2 || !segments.every((segment) => SLUG.test(segment))) {
    throw new Error(`not a repository: ${text}`)
  }
  return { owner: segments.slice(0, -1).join('/'), name: segments[segments.length - 1] }
}

export function parseTarget(text) {
  const found = String(text ?? '').trim().match(ORIGIN)
  const [provider, host, path] = found ? found.slice(1) : ['github', 'github.com', text]
  return { ...parseSlug(path), provider, host }
}

function parseEntry(item, index) {
  const at = String(item).lastIndexOf(':')
  const text = at < 0 ? String(item) : String(item).slice(0, at)
  const status = at < 0 ? 'pending' : String(item).slice(at + 1).trim()
  if (!STATUS.includes(status)) throw new Error(`repos.yml entry ${index + 1}: unknown status "${status}"`)
  return { ...parseTarget(text), status }
}

export function read(file = FILE) {
  if (!existsSync(file)) return []
  const repos = load(file).repos
  return Array.isArray(repos) ? repos.map(parseEntry) : []
}

export function write(entries, file = FILE) {
  const body = [...HEADER, 'repos:', ...entries.map((e) => `  - ${label(e)}:${e.status}`), ''].join('\n')
  const temp = `${file}.tmp`
  writeFileSync(temp, body, { mode: 0o644 })
  renameSync(temp, file)
  return entries
}

export function upsert(entry, file = FILE) {
  const entries = read(file)
  const found = entries.find((e) => key(e) === key(entry))
  if (found) found.status = entry.status
  else entries.push(entry)
  write(entries, file)
  return found ?? entry
}

export function find(target, file = FILE) {
  return read(file).find((e) => key(e) === key(target))
}

if (process.argv[1]?.endsWith('registry.mjs')) {
  console.log(JSON.stringify(read(), null, 2))
}
