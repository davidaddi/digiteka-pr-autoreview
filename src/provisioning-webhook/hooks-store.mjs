#!/usr/bin/env node
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from '../provisioning/registry.mjs'

// repos.yml stays the registry: one line per repository, [provider@host:]path:status, parsed
// by the hand-rolled loader in src/review/config.mjs. It has nowhere to put a hook id without
// teaching that loader a new shape, so the ids live here instead, in a sidecar only the
// webhook mode reads. Losing this file does not break a review, but it does orphan every
// webhook it described: the forge keeps them, and nothing here knows their ids any more.
//
// Keys are registry.mjs's key(entry), provider@host:owner/name, not the bare path: the same
// group/project can exist on github.com, on gitlab.com and on a self-hosted GitLab at once,
// and three hooks sharing one entry here would each delete the others' id.
export const FILE = process.env.WEBHOOKS_FILE ?? join(ROOT, 'webhooks.json')

export function read(file = FILE) {
  if (!existsSync(file)) return {}
  const text = readFileSync(file, 'utf8').trim()
  if (!text) return {}
  let data
  try {
    data = JSON.parse(text)
  } catch (error) {
    throw new Error(`${file} is not valid JSON (${error.message}). Fix it by hand: it holds the webhook ids.`)
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${file} must hold a JSON object`)
  return data
}

export function write(hooks, file = FILE) {
  const temp = `${file}.tmp`
  writeFileSync(temp, `${JSON.stringify(hooks, null, 2)}\n`, { mode: 0o644 })
  renameSync(temp, file)
  return hooks
}

export function get(key, file = FILE) {
  return read(file)[key] ?? null
}

export function set(key, record, file = FILE) {
  const hooks = read(file)
  hooks[key] = { ...record, updatedAt: new Date().toISOString() }
  write(hooks, file)
  return hooks[key]
}

export function remove(key, file = FILE) {
  const hooks = read(file)
  if (!(key in hooks)) return null
  const gone = hooks[key]
  delete hooks[key]
  write(hooks, file)
  return gone
}

if (process.argv[1]?.endsWith('hooks-store.mjs')) {
  console.log(JSON.stringify(read(), null, 2))
}
