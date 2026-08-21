#!/usr/bin/env node
import { createServer } from 'node:http'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { loadEnv } from '../provisioning/github-provision.mjs'
import {
  FILE as REGISTRY,
  ROOT as CHECKOUT,
  key as repoKey,
  label,
  read as readRegistry,
} from '../provisioning/registry.mjs'
import { token as gitlabToken } from './gitlab-webhook.mjs'
import { runHermes } from '../review/dispatch.mjs'

// src/review/receiver.mjs serves the one repository named by REPO. This one serves every
// repository marked active in repos.yml, from a single process and a single webhook secret,
// and it is the whole of the machinery in this mode: no workflow file, no runner, no job
// queue on GitHub's side. A comment arrives here and hermes starts here.
//
// One port, both forges: GitHub and GitLab deliveries arrive on the same url and are told
// apart by their authentication header, because that is the only thing about a delivery that
// is known before the body is trusted.
loadEnv()

const PORT = Number(process.env.WEBHOOK_PORT || 8789)
const SECRET = required('WEBHOOK_MULTI_SECRET')
const MAX_PARALLEL = Number(process.env.MAX_PARALLEL || 2)
const MAX_BODY = Number(process.env.MAX_BODY || 5 * 1024 * 1024)
const ROOT = (process.env.SANDBOX_ROOT || CHECKOUT).replace(/\/$/, '')
// 30 is Developer. Below it (10 Guest, 20 Reporter) a member cannot push, so they have no
// business asking this machine to review, fix or revert anything.
const DEVELOPER = 30

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
        .map((entry) => [repoKey(entry), entry]),
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

// GitLab signs nothing: it repeats the shared secret verbatim in this header on every
// delivery, so the check is a comparison rather than an HMAC — still not with ===, which
// leaks how much of the secret a guess got right. A separate secret from GitHub's, because
// this one is on the wire and GitHub's never is.
function tokenMatches(header) {
  const expected = process.env.WEBHOOK_MULTI_SECRET_GITLAB
  if (typeof header !== 'string' || !expected) return false
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

// What the two payloads have in common, once the noise is off: which repository, on which
// host, which pull or merge request, which comment, and what it asked for. Everything below
// this point works on that shape and not on a forge's payload.
function githubEvent(payload) {
  if (payload.action !== 'created' || !payload.issue?.pull_request) return null
  const command = parseCommand(payload.comment?.body)
  if (!command) return null
  return {
    provider: 'github',
    repo: String(payload.repository?.full_name ?? ''),
    host: 'github.com',
    pr: payload.issue.number,
    commentId: payload.comment.id,
    command,
  }
}

function gitlabEvent(payload) {
  if (payload.object_kind !== 'note' || payload.object_attributes?.noteable_type !== 'MergeRequest') return null
  const command = parseCommand(payload.object_attributes.note)
  if (!command) return null
  return {
    provider: 'gitlab',
    repo: String(payload.project.path_with_namespace),
    // Nothing else in the payload says which instance sent it, and this mode serves more than
    // one, so the host is read off the project url rather than assumed.
    host: new URL(payload.project.web_url).hostname,
    // iid, not id: iid is the number in the url and the one every API call takes, id is
    // unique across the whole instance and would address someone else's merge request.
    pr: payload.merge_request.iid,
    commentId: payload.object_attributes.id,
    projectId: payload.project.id,
    userId: payload.user.id,
    command,
  }
}

// GitHub states the commenter's standing on the repository in the payload. GitLab does not,
// so that side has to ask, and pays a round trip before it can decide. Both fail closed:
// anything that is not a clear yes is a no.
function githubPermits(payload) {
  return ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(payload.comment?.author_association)
}

async function gitlabPermits(event) {
  try {
    const response = await fetch(
      `https://${event.host}/api/v4/projects/${event.projectId}/members/all/${event.userId}`,
      { headers: { 'private-token': gitlabToken(event.host) } },
    )
    // 404 is the answer for someone who is not a member at all, inherited groups included.
    if (!response.ok) return false
    return Number((await response.json()).access_level) >= DEVELOPER
  } catch (error) {
    console.error(`could not check the commenter on ${event.host}: ${error.message}`)
    return false
  }
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

// One chain per pull request, keyed by repository, provider and host too: two repositories
// numbering their pull requests #7 would otherwise queue behind each other for no reason,
// and group/project can name a project on two different GitLab instances at once.
function enqueue(event, task) {
  const key = `${event.provider}@${event.host}:${event.repo}#${event.pr}`
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
      await reportFailure(event, error.message)
    })
  chains.set(key, chain)
  return chain
}

// The env every child of this process needs to know which repository, which forge and which
// instance a delivery was about. The token is resolved here, once, because the per-host
// GITLAB_TOKEN__<HOST> naming is this file's business and nothing downstream's.
function environment(event) {
  return {
    REPO: event.repo,
    REPO_PROVIDER: event.provider,
    REPO_HOST: event.host,
    [event.provider === 'gitlab' ? 'GITLAB_TOKEN' : 'GITHUB_TOKEN']: event.token,
  }
}

// runHermes copies process.env into the child inside a synchronous spawn, and nothing awaits
// between the assignment and that spawn, so these are set for exactly the length of the call.
// That is what tells review.sh, github.mjs and gitlab.mjs which repository, which forge and
// which instance this delivery was about, without a shared .runtime.env file that two
// concurrent reviews would fight over.
function dispatch(event) {
  const overrides = environment(event)
  const previous = Object.keys(overrides).map((name) => [name, process.env[name]])
  Object.assign(process.env, overrides)
  try {
    return runHermes({
      repo: event.repo,
      pr: event.pr,
      provider: event.provider,
      host: event.host,
      root: ROOT,
      ...event.command,
    })
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

async function acknowledge(event) {
  const url =
    event.provider === 'github'
      ? `https://api.github.com/repos/${event.repo}/issues/comments/${event.commentId}/reactions`
      : `https://${event.host}/api/v4/projects/${event.projectId}/merge_requests/${event.pr}/notes/${event.commentId}/award_emoji`
  const headers =
    event.provider === 'github'
      ? { authorization: `Bearer ${event.token}`, accept: 'application/vnd.github+json' }
      : { 'private-token': event.token }

  try {
    await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(event.provider === 'github' ? { content: 'eyes' } : { name: 'eyes' }),
    })
  } catch (error) {
    console.error('could not react to the comment:', error.message)
  }
}

function reportFailure(event, reason) {
  return new Promise((resolve) => {
    const child = spawn('node', [`src/review/${event.provider}.mjs`, 'fail', String(event.pr), reason], {
      cwd: ROOT,
      env: { ...process.env, ...environment(event) },
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
  req.on('end', async () => {
    if (refused) return
    const raw = Buffer.concat(chunks)

    // Which forge sent this is settled before the body is looked at, by the credential the
    // delivery carries: GitHub signs the body, GitLab repeats the shared secret in a header.
    const signature = req.headers['x-hub-signature-256']
    const provider = signature !== undefined ? 'github' : req.headers['x-gitlab-token'] !== undefined ? 'gitlab' : null
    const authentic =
      provider === 'github' ? signatureMatches(signature, raw) : tokenMatches(req.headers['x-gitlab-token'])
    if (!authentic) {
      res.writeHead(401).end(provider ? 'bad signature' : 'unsigned')
      return
    }

    let payload
    try {
      payload = JSON.parse(raw.toString('utf8'))
    } catch {
      res.writeHead(400).end('bad json')
      return
    }

    const event = provider === 'github' ? githubEvent(payload) : gitlabEvent(payload)
    if (!event) {
      res.writeHead(200).end('ignored')
      return
    }

    // GitHub names every delivery; GitLab does not, and a note can only be created once, so
    // the note itself is the identity of the delivery that carried it.
    const delivery =
      provider === 'github'
        ? req.headers['x-github-delivery']
        : `${event.provider}@${event.host}:${event.repo}#${event.commentId}`
    if (alreadyHandled(delivery)) {
      res.writeHead(200).end('duplicate')
      return
    }

    // Holding the secret only proves the delivery came from a hook this machine created. It
    // says nothing about which repository sent it, so the registry decides that separately.
    const entry = activeRepos().get(`${event.provider}@${event.host}:${event.repo}`.toLowerCase())
    if (!entry) {
      console.log(`${event.provider}@${event.host}:${event.repo}: not active in repos.yml, ignored`)
      res.writeHead(200).end('ignored')
      return
    }

    const permitted = provider === 'github' ? githubPermits(payload) : await gitlabPermits(event)
    if (!permitted) {
      res.writeHead(200).end('ignored')
      return
    }

    try {
      event.token = provider === 'github' ? process.env.GITHUB_TOKEN : gitlabToken(event.host)
    } catch (error) {
      console.error(`${label(entry)} #${event.pr}: ${error.message}`)
      res.writeHead(500).end('no token')
      return
    }

    console.log(`${label(entry)} #${event.pr}: ${event.command.action} queued`)
    res.writeHead(202).end('queued')

    acknowledge(event)
    enqueue(event, () => dispatch(event))
  })
})

refuseStaleRuntimeEnv()
required('GITHUB_TOKEN')
// review.sh drives the gh CLI, which reads GH_TOKEN. One token, one identity, both names.
process.env.GH_TOKEN ??= process.env.GITHUB_TOKEN

// A GitLab repository registered without its secret answers 401 to every real delivery, which
// on the sending side looks exactly like an attack rather than a missing line in .env.
if ([...activeRepos().values()].some((entry) => entry.provider === 'gitlab')) {
  required('WEBHOOK_MULTI_SECRET_GITLAB')
}

server.listen(PORT, '127.0.0.1', () => {
  const repos = [...activeRepos().values()].map(label)
  console.log(`multi-repo receiver on 127.0.0.1:${PORT}, ${repos.length} active: ${repos.join(', ')}`)
})
