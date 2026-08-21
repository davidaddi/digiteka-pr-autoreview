#!/usr/bin/env node
import { loadEnv } from '../provisioning/github-provision.mjs'

// github-webhook.mjs for GitLab: the same six operations on a project hook, with two
// differences that run through everything. The host is an argument rather than a constant,
// because this mode serves gitlab.com and gitlab.digiteka.com side by side from one process;
// and the "secret" is not an HMAC key but a token GitLab hands back verbatim in a header on
// every delivery, so it is a different secret from GitHub's and lives under its own name.
loadEnv()

// One token per host, not one per provider: two instances are two accounts with two personal
// access tokens. Deriving the variable name from the host means adding an instance is a line
// in .env and a line in repos.yml, with nothing to change here.
export function tokenVar(host) {
  return `GITLAB_TOKEN__${host.replace(/[.-]/g, '_').toUpperCase()}`
}

export function token(host) {
  const name = tokenVar(host)
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set, put the ${host} personal access token in .env under that name`)
  return value
}

// A GitLab project is addressed by its full path, url-encoded slashes and all, because it can
// live any number of subgroups deep.
function project(repo) {
  return encodeURIComponent(repo)
}

async function request(host, method, path, body) {
  const response = await fetch(`https://${host}/api/v4${path}`, {
    method,
    headers: {
      'private-token': token(host),
      accept: 'application/json',
      'content-type': 'application/json',
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
  return { ok: response.ok, status: response.status, data }
}

// The body of a create carries the shared secret, so no request body ever reaches a log:
// only the method, the path, the status and GitLab's own message do.
async function api(host, method, path, body) {
  const { ok, status, data } = await request(host, method, path, body)
  if (!ok) throw new Error(`${method} ${host}${path} -> ${status} ${message(data)}`)
  return data
}

function message(data) {
  if (!data) return ''
  if (typeof data === 'string') return data.slice(0, 400)
  const text = data.message ?? data.error
  return (typeof text === 'string' ? text : JSON.stringify(text ?? data)).slice(0, 400)
}

// note_events only: a /review is a comment. Nothing in this mode reacts to a merge request
// being opened, pushed to or merged, so subscribing to those would be deliveries to drop.
function hook(url, secret) {
  if (!/^https:\/\//.test(String(url))) throw new Error(`the webhook url must be https, got ${url}`)
  if (!secret) throw new Error('a webhook without a shared secret would accept anything, refusing')
  return {
    url,
    token: secret,
    merge_requests_events: false,
    note_events: true,
    enable_ssl_verification: true,
  }
}

export async function listWebhooks(host, repo) {
  const { ok, status, data } = await request(host, 'GET', `/projects/${project(repo)}/hooks?per_page=100`)
  if (!ok) throw new Error(`GET ${host} ${repo} hooks -> ${status} ${message(data)}`)
  return Array.isArray(data) ? data : []
}

export async function getWebhook(host, repo, hookId) {
  const { ok, status, data } = await request(host, 'GET', `/projects/${project(repo)}/hooks/${hookId}`)
  if (status === 404) return null
  if (!ok) throw new Error(`GET ${host} ${repo} hook ${hookId} -> ${status} ${message(data)}`)
  return data
}

export async function createWebhook(host, repo, url, secret) {
  const created = await api(host, 'POST', `/projects/${project(repo)}/hooks`, hook(url, secret))
  if (!created?.id) throw new Error(`${repo}: GitLab created a webhook without an id`)
  return created.id
}

// A quick tunnel hands out a new hostname every time it starts, so pointing an existing hook
// at the new url matters as much as creating one. PUT also rewrites the token, which is what
// makes rotating WEBHOOK_MULTI_SECRET_GITLAB a sync away.
export async function updateWebhook(host, repo, hookId, url, secret) {
  await api(host, 'PUT', `/projects/${project(repo)}/hooks/${hookId}`, hook(url, secret))
  return hookId
}

export async function deleteWebhook(host, repo, hookId) {
  const { ok, status, data } = await request(host, 'DELETE', `/projects/${project(repo)}/hooks/${hookId}`)
  if (status === 404) return 'absent'
  if (!ok) throw new Error(`DELETE ${host} ${repo} hook ${hookId} -> ${status} ${message(data)}`)
  return 'deleted'
}

// GitLab's equivalent of a ping is replaying one event type against the hook. It needs a note
// to exist on the project to have something to send, and older instances do not have the
// endpoint at all, so a failure here says nothing about the hook itself.
export async function pingWebhook(host, repo, hookId) {
  const { ok, status, data } = await request(host, 'POST', `/projects/${project(repo)}/hooks/${hookId}/test/note_events`)
  return ok ? 'pinged' : `not pinged (${status} ${message(data)})`
}

if (process.argv[1]?.endsWith('gitlab-webhook.mjs')) {
  const [command, host, repo, ...rest] = process.argv.slice(2)
  const secret = () => process.env.WEBHOOK_MULTI_SECRET_GITLAB ?? ''

  const actions = {
    list: () => listWebhooks(host, repo).then((h) => h.map((x) => `${x.id} ${x.url} notes=${x.note_events}`)),
    create: () => createWebhook(host, repo, rest[0], secret()),
    update: () => updateWebhook(host, repo, rest[0], rest[1], secret()),
    delete: () => deleteWebhook(host, repo, rest[0]),
    ping: () => pingWebhook(host, repo, rest[0]),
  }

  if (!actions[command] || !host || !repo) {
    console.error(
      'usage: gitlab-webhook.mjs list <host> <group/project> | create <host> <group/project> <url> |' +
        ' update <host> <group/project> <id> <url> | delete|ping <host> <group/project> <id>',
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
