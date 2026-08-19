#!/usr/bin/env node
import { loadEnv } from '../provisioning/github-provision.mjs'

// Same shape as github-provision.mjs, minus everything Actions: this mode never commits a
// workflow, never mints a runner token, never touches repository variables. It only hangs a
// webhook on the repository and takes it off again.
loadEnv()

const API = process.env.GITHUB_API ?? 'https://api.github.com'
const EVENTS = ['issue_comment']

function token() {
  const value = process.env.GITHUB_TOKEN
  if (!value) throw new Error('GITHUB_TOKEN is not set, put it in .env')
  return value
}

async function request(method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token()}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'x-github-api-version': '2022-11-28',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  return { ok: response.ok, status: response.status, headers: response.headers, data }
}

// The body of a create carries the shared secret, so no request body ever reaches a log:
// only the method, the path, the status and GitHub's own message do.
async function api(method, path, body) {
  const { ok, status, data } = await request(method, path, body)
  if (!ok) throw new Error(`${method} ${path} -> ${status} ${message(data)}`)
  return data
}

function message(data) {
  if (!data) return ''
  if (typeof data === 'string') return data.slice(0, 400)
  return [data.message, data.errors?.map((e) => e.message ?? e.code).join(', ')].filter(Boolean).join(' — ')
}

function config(url, secret) {
  if (!/^https:\/\//.test(String(url))) throw new Error(`the webhook url must be https, got ${url}`)
  if (!secret) throw new Error('a webhook without a shared secret would accept anything, refusing')
  return { url, content_type: 'json', secret, insecure_ssl: '0' }
}

export async function listWebhooks(repo) {
  const { ok, status, data } = await request('GET', `/repos/${repo}/hooks?per_page=100`)
  if (!ok) throw new Error(`GET /repos/${repo}/hooks -> ${status} ${message(data)}`)
  return Array.isArray(data) ? data : []
}

export async function getWebhook(repo, hookId) {
  const { ok, status, data } = await request('GET', `/repos/${repo}/hooks/${hookId}`)
  if (status === 404) return null
  if (!ok) throw new Error(`GET /repos/${repo}/hooks/${hookId} -> ${status} ${message(data)}`)
  return data
}

export async function createWebhook(repo, url, secret) {
  const hook = await api('POST', `/repos/${repo}/hooks`, {
    name: 'web',
    active: true,
    events: EVENTS,
    config: config(url, secret),
  })
  if (!hook?.id) throw new Error(`${repo}: GitHub created a webhook without an id`)
  return hook.id
}

// A quick tunnel hands out a new hostname every time it starts, so pointing an existing hook
// at the new url matters as much as creating one. PATCH also rewrites the secret, which is
// what makes rotating WEBHOOK_MULTI_SECRET a sync away.
export async function updateWebhook(repo, hookId, url, secret) {
  await api('PATCH', `/repos/${repo}/hooks/${hookId}`, {
    active: true,
    events: EVENTS,
    config: config(url, secret),
  })
  return hookId
}

export async function deleteWebhook(repo, hookId) {
  const { ok, status, data } = await request('DELETE', `/repos/${repo}/hooks/${hookId}`)
  if (status === 404) return 'absent'
  if (!ok) throw new Error(`DELETE /repos/${repo}/hooks/${hookId} -> ${status} ${message(data)}`)
  return 'deleted'
}

export async function pingWebhook(repo, hookId) {
  await api('POST', `/repos/${repo}/hooks/${hookId}/pings`)
  return 'pinged'
}

export async function lastDeliveries(repo, hookId, limit = 5) {
  const data = await api('GET', `/repos/${repo}/hooks/${hookId}/deliveries?per_page=${limit}`)
  return (Array.isArray(data) ? data : []).map((d) => ({
    event: d.event,
    status: d.status_code,
    at: d.delivered_at,
  }))
}

// Reports what GitHub itself says the token carries and what this endpoint accepts, so the
// required scope is read off the API instead of guessed from the documentation.
export async function scopes(repo) {
  const { status, headers } = await request('GET', `/repos/${repo}/hooks`)
  return {
    status,
    tokenHas: headers.get('x-oauth-scopes'),
    endpointAccepts: headers.get('x-accepted-oauth-scopes'),
  }
}

if (process.argv[1]?.endsWith('github-webhook.mjs')) {
  const [command, repo, ...rest] = process.argv.slice(2)
  const secret = () => process.env.WEBHOOK_MULTI_SECRET ?? ''

  const actions = {
    list: () => listWebhooks(repo).then((h) => h.map((x) => `${x.id} ${x.config?.url} [${x.events}] active=${x.active}`)),
    create: () => createWebhook(repo, rest[0], secret()),
    update: () => updateWebhook(repo, rest[0], rest[1], secret()),
    delete: () => deleteWebhook(repo, rest[0]),
    ping: () => pingWebhook(repo, rest[0]),
    deliveries: () => lastDeliveries(repo, rest[0]),
    scopes: () => scopes(repo),
  }

  if (!actions[command] || !repo) {
    console.error(
      'usage: github-webhook.mjs list|scopes <owner/name> | create <owner/name> <url> |' +
        ' update <owner/name> <id> <url> | delete|ping|deliveries <owner/name> <id>',
    )
    process.exit(1)
  }

  actions[command]()
    .then((result) => console.log(typeof result === 'object' ? JSON.stringify(result, null, 2) : `${repo}: ${result}`))
    .catch((error) => {
      console.error(error.message)
      process.exit(1)
    })
}
