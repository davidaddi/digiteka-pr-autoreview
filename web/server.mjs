#!/usr/bin/env node
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, find, parseSlug } from '../src/provisioning/registry.mjs'
import { list } from '../src/provisioning-webhook/sync-repos.mjs'
import { state as tunnelState, status as tunnelStatus } from '../src/provisioning-webhook/tunnel-lifecycle.mjs'

// Webhook mode console (branch webhook-mode). Same routes as the runner-mode one on main,
// but adding a repository hangs a webhook on it instead of committing a workflow and
// starting a self-hosted runner.
//
// This process reaches a personal access token that can create webhooks on every repository
// you own. There is no authentication on these routes: the only thing standing between the
// internet and that token is the loopback bind below. Never move it to 0.0.0.0, never put it
// behind a tunnel — the tunnel in this mode is for the receiver, on another port, and it must
// stay that way. The Host and Origin guards below keep a browser on another site from driving
// this through DNS rebinding.
const HOST = '127.0.0.1'
const PORT = Number(process.env.WEB_PORT ?? 8788)
const PAGE = join(ROOT, 'web', 'index.html')
const SYNC = join(ROOT, 'src', 'provisioning-webhook', 'sync-repos.mjs')
const MAX_BODY = 4096

const jobs = new Map()
let chain = Promise.resolve()

function enqueue(task) {
  const next = chain.then(task, task)
  chain = next.catch(() => {})
  return next
}

function allowed(req) {
  const host = req.headers.host ?? ''
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
  if (!['127.0.0.1', 'localhost', '::1'].includes(name)) return false

  const origin = req.headers.origin
  if (!origin) return true
  try {
    const url = new URL(origin)
    return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.hostname === '::1'
  } catch {
    return false
  }
}

function send(res, code, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    // Keep draining once it is too long, so the 413 still reaches the client, but stop
    // accumulating: an upload must never grow this process.
    req.on('data', (chunk) => {
      if (body.length > MAX_BODY) return
      body += chunk
      if (body.length > MAX_BODY) reject(new Error('body too large'))
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

function runSync(command, target) {
  const key = `${target.owner}/${target.name}`
  const job = { state: 'running', command, at: new Date().toISOString(), output: '' }
  jobs.set(key, job)

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SYNC, command, key], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
    const collect = (chunk) => {
      job.output = `${job.output}${chunk}`.slice(-4000)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.on('error', (error) => {
      job.state = 'error'
      job.output = error.message
      resolve()
    })
    child.on('close', (code) => {
      job.state = code === 0 ? 'ok' : 'error'
      job.output = job.output.trim()
      console.log(`${command} ${key} -> ${job.state}`)
      // A removal that worked took the entry out of the registry. Drop the job too,
      // otherwise the row it left behind would come back as a ghost.
      if (command === 'remove' && job.state === 'ok') jobs.delete(key)
      resolve()
    })
  })
}

function view(job) {
  return job ? { state: job.state, command: job.command, output: job.output } : null
}

// A repository queued a second ago is not in repos.yml yet, the sync child writes it.
// Show it anyway, otherwise the row disappears until the job starts.
function repos() {
  const entries = list()
  const known = new Set(entries.map((entry) => `${entry.owner}/${entry.name}`))
  const rows = entries.map((entry) => ({ ...entry, job: view(jobs.get(`${entry.owner}/${entry.name}`)) }))

  for (const [key, job] of jobs) {
    if (known.has(key)) continue
    const [owner, name] = key.split('/')
    rows.push({ owner, name, status: 'pending', webhook: 'none', hook: null, url: null, job: view(job) })
  }
  return rows
}

// Every hook points at this url. When the quick tunnel restarts it publishes a different
// hostname, every hook goes stale at once and the page has to say so: nothing else on it
// would look wrong, and no /review would ever arrive again.
function tunnel() {
  const current = tunnelState()
  return { state: tunnelStatus(), url: tunnelStatus() === 'up' ? (current?.url ?? null) : null }
}

function busy(target) {
  const job = jobs.get(`${target.owner}/${target.name}`)
  return job?.state === 'queued' || job?.state === 'running'
}

function schedule(command, target) {
  const key = `${target.owner}/${target.name}`
  jobs.set(key, { state: 'queued', command, at: new Date().toISOString(), output: '' })
  enqueue(() => runSync(command, target))
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`)

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(readFileSync(PAGE))
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/repos') {
    return send(res, 200, { repos: repos(), tunnel: tunnel() })
  }

  if (req.method === 'POST' && url.pathname === '/api/repos') {
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
      return send(res, 415, { error: 'send application/json' })
    }
    let target
    try {
      const parsed = JSON.parse((await readBody(req)) || '{}')
      if (typeof parsed.owner !== 'string' || typeof parsed.name !== 'string') {
        throw new Error('send {"owner":"...","name":"..."}')
      }
      target = parseSlug(`${parsed.owner}/${parsed.name}`)
    } catch (error) {
      return send(res, error.message === 'body too large' ? 413 : 400, { error: error.message })
    }
    if (busy(target)) return send(res, 409, { error: 'already syncing' })
    schedule('add', target)
    return send(res, 202, { queued: `${target.owner}/${target.name}` })
  }

  const removal = url.pathname.match(/^\/api\/repos\/([^/]+)\/([^/]+)$/)
  if (req.method === 'DELETE' && removal) {
    let target
    try {
      target = parseSlug(`${decodeURIComponent(removal[1])}/${decodeURIComponent(removal[2])}`)
    } catch (error) {
      return send(res, 400, { error: error.message })
    }
    if (busy(target)) return send(res, 409, { error: 'already syncing' })

    // Nothing to tear down for a repository the registry never got. Drop the row the
    // failed job left behind instead of queueing a sync that can only fail.
    const key = `${target.owner}/${target.name}`
    if (!find(target)) {
      jobs.delete(key)
      return send(res, 200, { forgotten: key })
    }
    schedule('remove', target)
    return send(res, 202, { queued: key })
  }

  send(res, 404, { error: 'no such route' })
}

const server = createServer((req, res) => {
  if (!allowed(req)) return send(res, 403, { error: 'local requests only' })
  handle(req, res).catch((error) => {
    console.error(error.message)
    if (!res.headersSent) send(res, 500, { error: error.message })
  })
})

server.listen(PORT, HOST, () => {
  console.log(`hermes-pr-review console on http://${HOST}:${PORT} (loopback only)`)
  if (!process.env.GITHUB_TOKEN) console.error('warning: GITHUB_TOKEN is not set, every sync will fail')
  if (!process.env.WEBHOOK_MULTI_SECRET) console.error('warning: WEBHOOK_MULTI_SECRET is not set, every sync will fail')
  if (tunnel().state !== 'up' && !process.env.WEBHOOK_PUBLIC_URL) {
    console.error('warning: no tunnel is up, start one with src/provisioning-webhook/tunnel-lifecycle.mjs start')
  }
})
