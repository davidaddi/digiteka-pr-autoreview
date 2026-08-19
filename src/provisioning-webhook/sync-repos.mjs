#!/usr/bin/env node
import { loadEnv } from '../provisioning/github-provision.mjs'
import { createWebhook, deleteWebhook, getWebhook, listWebhooks, updateWebhook } from './github-webhook.mjs'
import * as store from './hooks-store.mjs'
import { url as tunnelUrl } from './tunnel-lifecycle.mjs'
import { find, parseSlug, read, slug, upsert, write } from '../provisioning/registry.mjs'

// The webhook mode of src/provisioning/sync-repos.mjs. Same registry, same statuses, same
// commands — but a repository is served by a webhook pointing at one long-lived receiver,
// not by a workflow file and a self-hosted runner. Nothing here imports runner-lifecycle.mjs
// or touches .github/workflows: in this mode both are dead weight.
loadEnv()

// Deliberately not WEBHOOK_SECRET: setup.sh regenerates that one on every run for the
// single-repo mode. Sharing the key would mean every restart of setup.sh silently invalidated
// the signature on every webhook created here, and the receiver would answer 401 to real
// deliveries — a failure that looks exactly like an attack.
function secret() {
  const value = process.env.WEBHOOK_MULTI_SECRET
  if (!value) {
    throw new Error('WEBHOOK_MULTI_SECRET is not set. Put the same value in .env and in the receiver environment.')
  }
  return value
}

export function publicUrl() {
  const configured = process.env.WEBHOOK_PUBLIC_URL || tunnelUrl()
  if (!configured) {
    throw new Error(
      'no public url: start the tunnel (node src/provisioning-webhook/tunnel-lifecycle.mjs start) ' +
        'or set WEBHOOK_PUBLIC_URL to a hostname that reaches the receiver',
    )
  }
  return configured.replace(/\/$/, '')
}

function currentUrl() {
  try {
    return publicUrl()
  } catch {
    return null
  }
}

// Idempotent on purpose: the id we stored is the source of truth, and a hook that already
// exists is re-pointed rather than duplicated. Two hooks on one repository would double
// every delivery, and the second one would be invisible to teardown.
async function provision(entry) {
  const repo = slug(entry)
  const url = publicUrl()
  const known = store.get(repo)
  const existing = known?.hookId ? await getWebhook(repo, known.hookId) : null

  if (existing) {
    if (existing.config?.url === url && existing.active) {
      store.set(repo, { hookId: existing.id, url })
      return `webhook ${existing.id} unchanged`
    }
    await updateWebhook(repo, existing.id, url, secret())
    store.set(repo, { hookId: existing.id, url })
    return `webhook ${existing.id} re-pointed at ${url}`
  }

  const hookId = await createWebhook(repo, url, secret())
  store.set(repo, { hookId, url })
  return `webhook ${hookId} created on ${url}`
}

// A hook we cannot name is a hook nobody will ever delete, so when the sidecar has lost the
// id, fall back to the only other thing that identifies ours: the url it posts to.
async function teardown(entry) {
  const repo = slug(entry)
  const known = store.get(repo)

  if (known?.hookId) {
    const gone = await deleteWebhook(repo, known.hookId)
    store.remove(repo)
    return `webhook ${known.hookId} ${gone}`
  }

  const url = currentUrl()
  const ours = url ? (await listWebhooks(repo)).filter((hook) => hook.config?.url === url) : []
  for (const hook of ours) await deleteWebhook(repo, hook.id)
  store.remove(repo)
  return ours.length ? `webhook ${ours.map((h) => h.id).join(', ')} deleted (matched by url)` : 'no webhook registered'
}

// A removal that fails leaves the entry behind as removed, so the next sync retries it.
// One that works drops the entry: there is nothing left to keep.
async function syncEntry(entry) {
  if (entry.status === 'removed') {
    const report = await teardown(entry)
    forget(entry)
    return report
  }
  const report = await provision(entry)
  upsert({ ...entry, status: 'active' })
  return report
}

export async function sync(target) {
  const entries = read().filter((entry) => !target || (entry.owner === target.owner && entry.name === target.name))
  if (target && entries.length === 0) throw new Error(`${slug(target)} is not in repos.yml`)

  let failed = 0
  for (const entry of entries) {
    try {
      console.log(`${slug(entry)} [${entry.status}] ${await syncEntry(entry)}`)
    } catch (error) {
      failed += 1
      console.error(`${slug(entry)} [${entry.status}] failed: ${error.message}`)
    }
  }
  if (failed) throw new Error(`${failed} of ${entries.length} repositories did not sync`)
  return entries.length
}

export function add(target) {
  const known = find(target)
  if (!known || known.status === 'removed') upsert({ ...target, status: 'pending' })
  return find(target)
}

export function markRemoved(target) {
  if (!find(target)) throw new Error(`${slug(target)} is not in repos.yml`)
  upsert({ ...target, status: 'removed' })
  return find(target)
}

export function forget(target) {
  write(read().filter((entry) => entry.owner !== target.owner || entry.name !== target.name))
}

// stale is the thing to watch after a tunnel restart: the hook exists, it is just talking to
// a hostname that no longer resolves to this machine. `sync` with no argument repairs it.
export function list() {
  const url = currentUrl()
  return read().map((entry) => {
    const hook = store.get(slug(entry))
    return {
      ...entry,
      hook: hook?.hookId ?? null,
      url: hook?.url ?? null,
      webhook: !hook ? 'none' : !url ? 'unknown' : hook.url === url ? 'up' : 'stale',
    }
  })
}

if (process.argv[1]?.endsWith('sync-repos.mjs')) {
  const [command = 'sync', target] = process.argv.slice(2)

  const run = async () => {
    const repo = target ? parseSlug(target) : null
    if (command === 'add') {
      if (!repo) throw new Error('add needs <owner/name>')
      add(repo)
      return sync(repo)
    }
    if (command === 'remove') {
      if (!repo) throw new Error('remove needs <owner/name>')
      markRemoved(repo)
      return sync(repo)
    }
    // refresh is sync under another name: after the quick tunnel changed hostname, it is
    // what re-points every registered hook at the new url.
    if (command === 'sync' || command === 'refresh') return sync(repo)
    if (command === 'list') {
      const entries = list()
      return entries.length ? console.table(entries) : console.log('no repositories registered')
    }
    if (command === 'url') return console.log(publicUrl())
    throw new Error(
      'usage: sync-repos.mjs [sync|refresh [owner/name] | add <owner/name> | remove <owner/name> | list | url]',
    )
  }

  run().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
