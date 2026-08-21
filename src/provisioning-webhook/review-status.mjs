#!/usr/bin/env node
// Answers "what is /review doing right now" the same way sync-repos.mjs answers "is the
// webhook up": a console.table, not logs to read by hand. There is no in-memory registry to
// query -- receiver.mjs keeps its chain map to itself -- so this reconstructs the picture from
// the two things that already exist: the live process tree, and the receiver's own log lines.
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from '../provisioning/registry.mjs'

// Every live review is a `hermes -z "You orchestrate the \"ACTION\" action on REPO REQUEST
// #PR..."` process (see dispatch.mjs's prompt()). Nothing else on this machine starts hermes
// with -z, so matching on that finds all of them, whichever forge.
const ORCHESTRATE = /orchestrate the "([a-z]+)" action on (\S+) (pull|merge) request #(\d+)/

function sh(command) {
  try {
    return execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return ''
  }
}

function running() {
  const rows = new Map()
  for (const line of sh('ps -eo pid=,etime=,args=').split('\n')) {
    const match = line.match(ORCHESTRATE)
    if (!match) continue
    const [, action, repo, kind, pr] = match
    const etime = line.trim().split(/\s+/)[1]
    rows.set(`${repo}#${pr}`, { repo, pr, action, kind: kind === 'pull' ? 'PR' : 'MR', detail: `running ${etime}` })
  }
  return rows
}

// queued/failed are printed by receiver.mjs itself in a fixed shape (see enqueue() and the
// request handler), so they parse cleanly. A clean finish is not: hermes reports it in its own
// words with no fixed string to match, so "queued, nothing since, not running" is the best
// this can say without dispatch.mjs's PUBLISH_MARKER file -- reported as such rather than
// guessed at as "posted".
const QUEUED = /^(.+) #(\d+): ([a-z]+) queued$/
const FAILED = /^(.+)#(\d+) failed: (.+)$/

function recentLog(lines) {
  const unit = 'hermes-receiver'
  const underSystemd = sh('systemctl --user is-active ' + unit).trim() === 'active'
  if (underSystemd) return sh(`journalctl --user -u ${unit} -n ${lines} --no-pager -o cat`)
  const file = join(ROOT, 'receiver.log')
  if (!existsSync(file)) return ''
  return readFileSync(file, 'utf8').split('\n').slice(-lines).join('\n')
}

function lastLoggedByKey(lines) {
  const rows = new Map()
  for (const line of recentLog(lines).split('\n')) {
    const queued = line.match(QUEUED)
    const failed = line.match(FAILED)
    if (queued) {
      const [, repo, pr, action] = queued
      rows.set(`${repo}#${pr}`, { repo, pr, action, status: 'queued' })
    } else if (failed) {
      const [, repo, pr, reason] = failed
      rows.set(`${repo}#${pr}`, { repo, pr, action: '', status: 'failed', detail: reason })
    }
  }
  return rows
}

const lines = Number(process.argv[2] ?? 200)
const live = running()
const logged = lastLoggedByKey(lines)

const rows = []
for (const key of new Set([...live.keys(), ...logged.keys()])) {
  const proc = live.get(key)
  const last = logged.get(key)
  if (proc) {
    rows.push({ repo: proc.repo, pr: proc.pr, action: last?.action ?? proc.action, status: 'running', detail: proc.detail })
  } else if (last?.status === 'failed') {
    rows.push({ repo: last.repo, pr: last.pr, action: last.action, status: 'failed', detail: last.detail })
  } else if (last) {
    rows.push({ repo: last.repo, pr: last.pr, action: last.action, status: 'done', detail: '' })
  }
}

if (rows.length) {
  console.table(rows)
  if (rows.some((r) => r.status === 'done')) {
    console.log(
      'note: "done" means queued, not running, no failure logged -- hermes\'s own exit code',
      'cannot prove it actually posted (see AGENTS.md), so check the pull/merge request to be sure.',
    )
  }
} else {
  console.log(`no reviews in the scanned window, try a bigger N: review-status.mjs ${lines * 2}`)
}
