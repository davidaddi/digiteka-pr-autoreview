#!/usr/bin/env node
import { createServer } from 'node:http'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { spawn } from 'node:child_process'
import { runHermes } from './dispatch.mjs'

const PORT = Number(process.env.PORT ?? 8787)
const SECRET = required('WEBHOOK_SECRET')
const REPO = required('REPO')
const MAX_PARALLEL = Number(process.env.MAX_PARALLEL ?? 2)
const ROOT = process.env.SANDBOX_ROOT ?? process.cwd()

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

function enqueue(pr, task) {
  const chain = (chains.get(pr) ?? Promise.resolve())
    .then(async () => {
      await acquire()
      try {
        await task()
      } finally {
        release()
      }
    })
    .catch(async (error) => {
      console.error(`pr #${pr} failed:`, error.message)
      await reportFailure(pr, error.message)
    })
  chains.set(pr, chain)
  return chain
}

async function acknowledge(commentId) {
  const token = process.env.GITHUB_TOKEN
  if (!token || !commentId) return
  try {
    await fetch(`https://api.github.com/repos/${REPO}/issues/comments/${commentId}/reactions`, {
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

function reportFailure(pr, reason) {
  return new Promise((resolve) => {
    const child = spawn('node', ['src/review/github.mjs', 'fail', String(pr), reason], {
      cwd: ROOT,
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    child.on('error', () => resolve())
    child.on('close', () => resolve())
  })
}

const server = createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405).end()
    return
  }

  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
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

    const isPullRequestComment = payload.action === 'created' && payload.issue?.pull_request
    const canWrite = ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(payload.comment?.author_association)
    const command = isPullRequestComment ? parseCommand(payload.comment?.body) : null

    if (!command || !canWrite) {
      res.writeHead(200).end('ignored')
      return
    }

    const pr = payload.issue.number
    console.log(`pr #${pr}: ${command.action} queued`)
    res.writeHead(202).end('queued')

    acknowledge(payload.comment.id)
    enqueue(pr, () => runHermes({ repo: REPO, pr, root: ROOT, ...command }))
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`receiver listening on 127.0.0.1:${PORT} for ${REPO}`)
})
