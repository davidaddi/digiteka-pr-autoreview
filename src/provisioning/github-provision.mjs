#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { ROOT } from './registry.mjs'

// GITHUB_TOKEN here is a personal access token able to write .github/workflows on every
// target repository. It is read from .env, never printed, never written to a log.
export function loadEnv(file = join(ROOT, '.env')) {
  if (!existsSync(file)) return
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const at = line.indexOf('=')
    if (at < 1 || line.trimStart().startsWith('#')) continue
    const value = line.slice(at + 1).trim().replace(/^"(.*)"$/s, '$1').replace(/^'(.*)'$/s, '$1')
    process.env[line.slice(0, at).trim()] ??= value
  }
}

loadEnv()

const API = process.env.GITHUB_API ?? 'https://api.github.com'
const WORKFLOW_PATH = '.github/workflows/review.yml'
const WORKFLOW_SOURCE = join(ROOT, 'workflow', 'review.yml')
const VARIABLES = ['HERMES_PROVIDER', 'HERMES_MODEL']

function token() {
  const value = process.env.GITHUB_TOKEN
  if (!value) throw new Error('GITHUB_TOKEN is not set, put it in .env (see .env.example)')
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
  return { ok: response.ok, status: response.status, data }
}

async function api(method, path, body) {
  const { ok, status, data } = await request(method, path, body)
  if (!ok) throw new Error(`${method} ${path} -> ${status} ${message(data)}`)
  return data
}

async function maybe(path) {
  const { ok, status, data } = await request('GET', path)
  if (status === 404) return null
  if (!ok) throw new Error(`GET ${path} -> ${status} ${message(data)}`)
  return data
}

function message(data) {
  if (!data) return ''
  if (typeof data === 'string') return data.slice(0, 400)
  return [data.message, data.errors?.map((e) => e.message ?? e.code).join(', ')].filter(Boolean).join(' — ')
}

function blobSha(content) {
  return createHash('sha1')
    .update(`blob ${Buffer.byteLength(content)}\0`)
    .update(content)
    .digest('hex')
}

export async function repoInfo(repo) {
  const data = await maybe(`/repos/${repo}`)
  if (!data) throw new Error(`${repo} not found, or the token cannot see it`)
  return data
}

export async function assertAdmin(repo) {
  const info = await repoInfo(repo)
  if (info.archived) throw new Error(`${repo} is archived`)
  if (!info.permissions?.admin) {
    throw new Error(`the token is not admin on ${repo}, it cannot register a runner there`)
  }
  return info
}

export async function commitWorkflow(repo, branch) {
  const content = readFileSync(WORKFLOW_SOURCE, 'utf8')
  const ref = branch ?? (await repoInfo(repo)).default_branch
  const current = await maybe(`/repos/${repo}/contents/${WORKFLOW_PATH}?ref=${encodeURIComponent(ref)}`)

  if (current && !Array.isArray(current) && current.sha === blobSha(content)) return 'unchanged'

  await api('PUT', `/repos/${repo}/contents/${WORKFLOW_PATH}`, {
    message: current ? 'chore(hermes): update review workflow' : 'chore(hermes): add review workflow',
    content: Buffer.from(content).toString('base64'),
    branch: ref,
    ...(current ? { sha: current.sha } : {}),
  })
  return current ? 'updated' : 'created'
}

export async function deleteWorkflow(repo, branch) {
  const ref = branch ?? (await repoInfo(repo)).default_branch
  const current = await maybe(`/repos/${repo}/contents/${WORKFLOW_PATH}?ref=${encodeURIComponent(ref)}`)
  if (!current || Array.isArray(current)) return 'absent'

  await api('DELETE', `/repos/${repo}/contents/${WORKFLOW_PATH}`, {
    message: 'chore(hermes): remove review workflow',
    sha: current.sha,
    branch: ref,
  })
  return 'deleted'
}

export async function setRepoVars(repo, provider, model) {
  if (!provider && !model) return 'skipped'
  if (!provider || !model) throw new Error('HERMES_PROVIDER and HERMES_MODEL go together')

  const values = { HERMES_PROVIDER: provider, HERMES_MODEL: model }
  const done = []

  for (const name of VARIABLES) {
    const value = values[name]
    const current = await maybe(`/repos/${repo}/actions/variables/${name}`)
    if (current?.value === value) continue
    if (current) await api('PATCH', `/repos/${repo}/actions/variables/${name}`, { name, value })
    else await api('POST', `/repos/${repo}/actions/variables`, { name, value })
    done.push(name)
  }
  return done.length ? `set ${done.join(', ')}` : 'unchanged'
}

// The returned value registers a runner for one hour. It is a secret: never log it,
// never write it to disk, hand it straight to config.sh.
export async function createRegistrationToken(repo) {
  const data = await api('POST', `/repos/${repo}/actions/runners/registration-token`)
  if (!data?.token) throw new Error(`no registration token returned for ${repo}`)
  return data.token
}

export async function createRemoveToken(repo) {
  const data = await api('POST', `/repos/${repo}/actions/runners/remove-token`)
  if (!data?.token) throw new Error(`no remove token returned for ${repo}`)
  return data.token
}

export async function findRunner(repo, name) {
  const data = await maybe(`/repos/${repo}/actions/runners?per_page=100`)
  return data?.runners?.find((runner) => runner.name === name) ?? null
}

export async function deleteRunner(repo, id) {
  await api('DELETE', `/repos/${repo}/actions/runners/${id}`)
  return 'unregistered'
}

if (process.argv[1]?.endsWith('github-provision.mjs')) {
  const [command, repo] = process.argv.slice(2)
  const actions = {
    info: () => repoInfo(repo).then((r) => `${r.full_name} default branch ${r.default_branch}`),
    workflow: () => commitWorkflow(repo),
    'delete-workflow': () => deleteWorkflow(repo),
    vars: () => setRepoVars(repo, process.env.HERMES_PROVIDER, process.env.HERMES_MODEL),
  }
  if (!actions[command] || !repo) {
    console.error('usage: github-provision.mjs info|workflow|delete-workflow|vars <owner/name>')
    process.exit(1)
  }
  actions[command]()
    .then((result) => console.log(`${repo}: ${result}`))
    .catch((error) => {
      console.error(error.message)
      process.exit(1)
    })
}
