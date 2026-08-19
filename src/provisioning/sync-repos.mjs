#!/usr/bin/env node
import { assertAdmin, commitWorkflow, deleteWorkflow, setRepoVars } from './github-provision.mjs'
import { start, status, stop } from './runner-lifecycle.mjs'
import { find, parseSlug, read, slug, upsert, write } from './registry.mjs'

const PROVIDER = process.env.HERMES_PROVIDER
const MODEL = process.env.HERMES_MODEL

// The workflow goes on last and comes off first. A repository that has the workflow but no
// runner parks every /review as a queued job nobody will ever pick up, so if any of this
// half fails, fail on the harmless side: a runner waiting for a workflow that is not there.
async function provision(entry) {
  const repo = slug(entry)
  await assertAdmin(repo)
  const vars = await setRepoVars(repo, PROVIDER, MODEL)
  const runner = await start(entry.owner, entry.name)
  const workflow = await commitWorkflow(repo)
  return `workflow ${workflow}, vars ${vars}, runner ${runner}`
}

async function teardown(entry) {
  const repo = slug(entry)
  const workflow = await deleteWorkflow(repo)
  const runner = await stop(entry.owner, entry.name)
  return `runner ${runner}, workflow ${workflow}`
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

export function list() {
  return read().map((entry) => ({
    ...entry,
    runner: entry.status === 'active' ? status(entry.owner, entry.name) : 'down',
  }))
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
    if (command === 'sync') return sync(repo)
    if (command === 'list') {
      const entries = list()
      return entries.length ? console.table(entries) : console.log('no repositories registered')
    }
    throw new Error('usage: sync-repos.mjs [sync [owner/name] | add <owner/name> | remove <owner/name> | list]')
  }

  run().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
