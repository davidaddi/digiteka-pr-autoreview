#!/usr/bin/env node
import { createServer } from 'node:http'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { loadEnv } from '../provisioning/github-provision.mjs'
import { FILE as REGISTRY, ROOT as CHECKOUT, read as readRegistry } from '../provisioning/registry.mjs'
import { runHermes } from '../review/dispatch.mjs'

// src/review/receiver.mjs serves the one repository named by REPO. This one serves every
// repository marked active in repos.yml, from a single process and a single webhook secret,
// and it is the whole of the machinery in this mode: no workflow file, no runner, no job
// queue on GitHub's side. A comment arrives here and hermes starts here.
loadEnv()

const PORT = Number(process.env.WEBHOOK_PORT || 8789)
const SECRET = required('WEBHOOK_MULTI_SECRET')
const MAX_PARALLEL = Number(process.env.MAX_PARALLEL || 2)
const MAX_BODY = Number(process.env.MAX_BODY || 5 * 1024 * 1024)
const ROOT = (process.env.SANDBOX_ROOT || CHECKOUT).replace(/\/$/, '')

const COMMANDS = new Map([
  ['/review', 'review'],
  ['/fix', 'fix'],
  ['/revert', 'revert'],
])

function required(name) {
  const value = process.env[name]
  if (!value) {
    console.error(`missing required env var: ${name}`)
    process.exit(1)
  }
  return value
}

// review.sh sources .runtime.env with set -a, so whatever REPO that file holds wins over the
// one we hand the child. In the single-repo mode that is the point; here it would silently
// review the wrong repository, on every delivery, for every repository but one.
function refuseStaleRuntimeEnv() {
  const file = join(ROOT, '.runtime.env')
  if (!existsSync(file)) return
  console.error(`${file} pins REPO for every review and would send them all to one repository.`)
  console.error('It belongs to setup.sh, which deletes it on exit. Remove it, then start this again.')
  process.exit(1)
}

let known = { at: -1, repos: new Map() }

// repos.yml is re-read only when it changes, so adding a repository takes effect without a
// restart and a delivery storm does not re-parse it a thousand times. A parse error keeps
// the last good list rather than dropping every repository at once.
function activeRepos() {
  const at = existsSync(REGISTRY) ? statSync(REGISTRY).mtimeMs : 0
  if (at === known.at) return known.repos

  try {
    const repos = new Map(
      readRegistry()
        .filter((entry) => entry.status === 'active')
        .map((entry) => [`${entry.owner}/${entry.name}`.toLowerCase(), `${entry.owner}/${entry.name}`]),
    )
    known = { at, repos }
  } catch (error) {
    console.error(`could not read ${REGISTRY}: ${error.message}, keeping the previous list`)
  }
  return known.repos
}

const seen = new Set()
function alreadyHandled(deliveryId) {
  if (seen.has(deliveryId)) return true
  seen.add(deliveryId)
  if (seen.size > 500) seen.delete(seen.values().next().value)
  return false
}

function signatureMatches(header, rawBody) {
  if (typeof header !== 'string') return false
  const expected = 'sha256=' + createHmac('sha256', SECRET).update(rawBody).digest('hex')
  const a = Buffer.from(expected)
  const b = Buffer.from(header)
  return a.length === b.length && timingSafeEqual(a, b)
}

function parseCommand(body) {
  const first = String(body ?? '').trim().split('\n')[0].trim()
  for (const [prefix, action] of COMMANDS) {
    if (first === prefix || first.startsWith(prefix + ' ')) {
      return { action, argument: first.slice(prefix.length).trim() }
    }
  }
  return null
}

const chains = new Map()
let inFlight = 0
const waiting = []

function acquire() {
  if (inFlight < MAX_PARALLEL) {
    inFlight += 1
    return Promise.resolve()
  }
  return new Promise((resolve) => waiting.push(resolve))
}

function release() {
  const next = waiting.shift()
  if (next) return next()
  inFlight -= 1
}

// One chain per pull request, keyed by repository too: two repositories numbering their
// pull requests #7 would otherwise queue behind each other for no reason.
function enqueue(repo, pr, task) {
  const key = `${repo}#${pr}`
  const chain = (chains.get(key) ?? Promise.resolve())
    .then(async () => {
      await acquire()
      try {
        await task()
      } finally {
        release()
      }
    })
    .catch(async (error) => {
      console.error(`${key} failed:`, error.message)
      await reportFailure(repo, pr, error.message)
    })
  chains.set(key, chain)
  return chain
}

// runHermes copies process.env into the child inside a synchronous spawn, and nothing awaits
// between these two lines, so REPO is set for exactly the length of that call. That is what
// tells review.sh and github.mjs which repository this delivery was about, without a shared
// .runtime.env file that two concurrent reviews would fight over.
function dispatch(repo, pr, command) {
  const previous = process.env.REPO
  process.env.REPO = repo
  try {
    return runHermes({ repo, pr, root: ROOT, ...command })
  } finally {
    if (previous === undefined) delete process.env.REPO
    else process.env.REPO = previous
  }
}

async function acknowledge(repo, commentId) {
  const token = process.env.GITHUB_TOKEN
  if (!token || !commentId) return
  try {
    await fetch(`https://api.github.com/repos/${repo}/issues/comments/${commentId}/reactions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ content: 'eyes' }),
    })
  } catch (error) {
    console.error('could not react to the comment:', error.message)
  }
}

function reportFailure(repo, pr, reason) {
  return new Promise((resolve) => {
    const child = spawn('node', ['src/review/github.mjs', 'fail', String(pr), reason], {
      cwd: ROOT,
      env: { ...process.env, REPO: repo },
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    child.on('error', () => resolve())
    child.on('close', () => resolve())
  })
}

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end(`ok, ${activeRepos().size} repositories\n`)
    return
  }
  if (req.method !== 'POST') {
    res.writeHead(405).end()
    return
  }

  // The signature can only be checked once the whole body is in memory, so anyone who finds
  // the tunnel can make this process hold whatever they send. The single-repo mode gets away
  // with no cap because its tunnel lives for one demo; this one is meant to stay up.
  const chunks = []
  let size = 0
  let refused = false

  req.on('data', (chunk) => {
    if (refused) return
    size += chunk.length
    if (size > MAX_BODY) {
      refused = true
      res.writeHead(413).end('too large')
      req.destroy()
      return
    }
    chunks.push(chunk)
  })
  req.on('end', () => {
    if (refused) return
    const raw = Buffer.concat(chunks)

    if (!signatureMatches(req.headers['x-hub-signature-256'], raw)) {
      res.writeHead(401).end('bad signature')
      return
    }
    if (alreadyHandled(req.headers['x-github-delivery'])) {
      res.writeHead(200).end('duplicate')
      return
    }

    let payload
    try {
      payload = JSON.parse(raw.toString('utf8'))
    } catch {
      res.writeHead(400).end('bad json')
      return
    }

    // The signature only proves the delivery came from a hook holding the shared secret. It
    // says nothing about which repository sent it, so the registry decides that separately.
    const sender = String(payload.repository?.full_name ?? '')
    if (!activeRepos().has(sender.toLowerCase())) {
      if (sender) console.log(`${sender}: not active in repos.yml, ignored`)
      res.writeHead(200).end('ignored')
      return
    }

    const isPullRequestComment = payload.action === 'created' && payload.issue?.pull_request
    const canWrite = ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(payload.comment?.author_association)
    const command = isPullRequestComment ? parseCommand(payload.comment?.body) : null

    if (!command || !canWrite) {
      res.writeHead(200).end('ignored')
      return
    }

    const pr = payload.issue.number
    console.log(`${sender} #${pr}: ${command.action} queued`)
    res.writeHead(202).end('queued')

    acknowledge(sender, payload.comment.id)
    enqueue(sender, pr, () => dispatch(sender, pr, command))
  })
})

refuseStaleRuntimeEnv()
required('GITHUB_TOKEN')
// review.sh drives the gh CLI, which reads GH_TOKEN. One token, one identity, both names.
process.env.GH_TOKEN ??= process.env.GITHUB_TOKEN

server.listen(PORT, '127.0.0.1', () => {
  const repos = activeRepos()
  console.log(`multi-repo receiver on 127.0.0.1:${PORT}, ${repos.size} active: ${[...repos.values()].join(', ')}`)
})
