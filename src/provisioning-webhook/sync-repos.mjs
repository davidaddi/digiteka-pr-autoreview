#!/usr/bin/env node
import { loadEnv } from '../provisioning/github-provision.mjs'
import * as github from './github-webhook.mjs'
import * as gitlab from './gitlab-webhook.mjs'
import * as store from './hooks-store.mjs'
import { url as tunnelUrl } from './tunnel-lifecycle.mjs'
import { find, key, label, parseTarget, read, slug, upsert, write } from '../provisioning/registry.mjs'

// The webhook mode of src/provisioning/sync-repos.mjs. Same registry, same statuses, same
// commands — but a repository is served by a webhook pointing at one long-lived receiver,
// not by a workflow file and a self-hosted runner. Nothing here imports runner-lifecycle.mjs
// or touches .github/workflows: in this mode both are dead weight.
loadEnv()

// Deliberately not WEBHOOK_SECRET: setup.sh regenerates that one on every run for the
// single-repo mode. Sharing the key would mean every restart of setup.sh silently invalidated
// the signature on every webhook created here, and the receiver would answer 401 to real
// deliveries — a failure that looks exactly like an attack.
//
// GitLab gets a second secret rather than the same one because it does not sign anything: the
// value below travels in an X-Gitlab-Token header on every delivery, in the clear as far as
// this process is concerned. GitHub's secret is only ever proved, never sent.
function secret(provider) {
  const name = provider === 'gitlab' ? 'WEBHOOK_MULTI_SECRET_GITLAB' : 'WEBHOOK_MULTI_SECRET'
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set. Put the same value in .env and in the receiver environment.`)
  return value
}

// Both forges answer the same five questions; only the arguments and the shape of a hook
// differ. GitHub nests the url under config and can leave a hook inactive, GitLab keeps the
// url at the top level and has no such flag: a hook there exists and fires, or it is gone.
function hooks(entry) {
  const repo = slug(entry)
  if (entry.provider === 'github') {
    return {
      get: (id) => github.getWebhook(repo, id),
      list: () => github.listWebhooks(repo),
      create: (url) => github.createWebhook(repo, url, secret('github')),
      update: (id, url) => github.updateWebhook(repo, id, url, secret('github')),
      remove: (id) => github.deleteWebhook(repo, id),
      urlOf: (hook) => hook.config?.url,
      live: (hook) => hook.active === true,
    }
  }
  if (entry.provider === 'gitlab') {
    return {
      get: (id) => gitlab.getWebhook(entry.host, repo, id),
      list: () => gitlab.listWebhooks(entry.host, repo),
      create: (url) => gitlab.createWebhook(entry.host, repo, url, secret('gitlab')),
      update: (id, url) => gitlab.updateWebhook(entry.host, repo, id, url, secret('gitlab')),
      remove: (id) => gitlab.deleteWebhook(entry.host, repo, id),
      urlOf: (hook) => hook.url,
      live: () => true,
    }
  }
  throw new Error(`${label(entry)}: unknown provider "${entry.provider}", expected github or gitlab`)
}

// One tunnel, one receiver, one url: which forge posts to it changes nothing here.
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

// webhooks.json used to be keyed on the bare owner/name, before an entry could name a
// provider and a host. Move that record onto the new key instead of ignoring it: an id we
// cannot find is a hook we create a second time, and then every delivery arrives twice.
function stored(entry, id) {
  const known = store.get(id)
  if (known) return known
  const legacy = entry.provider === 'github' ? store.remove(slug(entry)) : null
  return legacy ? store.set(id, { hookId: legacy.hookId, url: legacy.url }) : null
}

// Idempotent on purpose: the id we stored is the source of truth, and a hook that already
// exists is re-pointed rather than duplicated. Two hooks on one repository would double
// every delivery, and the second one would be invisible to teardown.
async function provision(entry) {
  const api = hooks(entry)
  const id = key(entry)
  const url = publicUrl()
  const known = stored(entry, id)
  const existing = known?.hookId ? await api.get(known.hookId) : null

  if (existing) {
    if (api.urlOf(existing) === url && api.live(existing)) {
      store.set(id, { hookId: existing.id, url })
      return `webhook ${existing.id} unchanged`
    }
    await api.update(existing.id, url)
    store.set(id, { hookId: existing.id, url })
    return `webhook ${existing.id} re-pointed at ${url}`
  }

  const hookId = await api.create(url)
  store.set(id, { hookId, url })
  return `webhook ${hookId} created on ${url}`
}

// A hook we cannot name is a hook nobody will ever delete, so when the sidecar has lost the
// id, fall back to the only other thing that identifies ours: the url it posts to.
async function teardown(entry) {
  const api = hooks(entry)
  const id = key(entry)
  const known = stored(entry, id)

  if (known?.hookId) {
    const gone = await api.remove(known.hookId)
    store.remove(id)
    return `webhook ${known.hookId} ${gone}`
  }

  const url = currentUrl()
  const ours = url ? (await api.list()).filter((hook) => api.urlOf(hook) === url) : []
  for (const hook of ours) await api.remove(hook.id)
  store.remove(id)
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
  const entries = read().filter((entry) => !target || key(entry) === key(target))
  if (target && entries.length === 0) throw new Error(`${label(target)} is not in repos.yml`)

  let failed = 0
  for (const entry of entries) {
    try {
      console.log(`${label(entry)} [${entry.status}] ${await syncEntry(entry)}`)
    } catch (error) {
      failed += 1
      console.error(`${label(entry)} [${entry.status}] failed: ${error.message}`)
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
  if (!find(target)) throw new Error(`${label(target)} is not in repos.yml`)
  upsert({ ...target, status: 'removed' })
  return find(target)
}

export function forget(target) {
  write(read().filter((entry) => key(entry) !== key(target)))
}

// stale is the thing to watch after a tunnel restart: the hook exists, it is just talking to
// a hostname that no longer resolves to this machine. `sync` with no argument repairs it.
export function list() {
  const url = currentUrl()
  return read().map((entry) => {
    const hook = store.get(key(entry))
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
    const repo = target ? parseTarget(target) : null
    if (command === 'add') {
      if (!repo) throw new Error('add needs <owner/name> or <gitlab@host:group/project>')
      add(repo)
      return sync(repo)
    }
    if (command === 'remove') {
      if (!repo) throw new Error('remove needs <owner/name> or <gitlab@host:group/project>')
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
      'usage: sync-repos.mjs [sync|refresh [repo] | add <repo> | remove <repo> | list | url]\n' +
        '  repo is owner/name on github.com, or provider@host:path elsewhere,' +
        ' e.g. gitlab@gitlab.digiteka.com:group/subgroup/project',
    )
  }

  run().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
