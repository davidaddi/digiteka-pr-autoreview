#!/usr/bin/env node
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { bullets, diffLines, readFindings, runStats, summary, textAt, unquoted } from './format.mjs'

// github.mjs for GitLab, same three subcommands and two more. The two extra exist because the
// GitHub path leans on the gh CLI for the diff and the branch name of a pull request, and
// there is no such CLI here worth requiring: review.sh shells out to `diff` and `branch`
// below instead.
const RUNTIME_ENV_FILE = process.env.RUNTIME_ENV_FILE ?? '.runtime.env'
if (existsSync(RUNTIME_ENV_FILE)) {
  for (const line of readFileSync(RUNTIME_ENV_FILE, 'utf8').split('\n')) {
    const at = line.indexOf('=')
    if (at < 1) continue
    const value = line.slice(at + 1).replace(/^"(.*)"$/s, '$1')
    process.env[line.slice(0, at)] ??= value
  }
}

const TOKEN = required('GITLAB_TOKEN')
const REPO = required('REPO')
// Which instance, gitlab.com or a self-hosted one: there is no single api host to default to.
const HOST = required('REPO_HOST')
const API = `https://${HOST}/api/v4/projects/${encodeURIComponent(REPO)}`
const CHECK_NAME = 'hermes-review'

function required(name) {
  const value = process.env[name]
  if (!value) {
    console.error(`missing required env var: ${name}`)
    process.exit(1)
  }
  return value
}

async function api(method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      'private-token': TOKEN,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status} ${await response.text()}`)
  }
  return response.json()
}

function note(mr, body) {
  return api('POST', `/merge_requests/${mr}/notes`, { body })
}

// The head of the merge request as GitLab last saw it. diff_refs is what the diff was taken
// against, so a status posted on it lines up with the findings; sha is the same commit for a
// merge request that is not being rewritten under us.
function head(mr) {
  return mr.diff_refs?.head_sha ?? mr.sha
}

async function post(pr) {
  const findings = readFindings(process.env.FINDINGS_FILE ?? '.findings.json')
  const mr = await api('GET', `/merge_requests/${pr}`)

  if (findings.length === 0) {
    await note(pr, '## 🔎 Review\n\n✅ No findings. Nothing to flag on this diff.')
    await conclude(head(mr), 'success', 'No findings')
    console.log('no findings, comment posted')
    return
  }

  const diff = diffLines(process.env.DIFF_FILE ?? '.pr.diff')
  const invented = unquoted(findings, diff)
  for (const f of invented) console.error(`quote does not match ${f.file}:${f.line}, dropped`)

  const kept = findings.filter((f) => !invented.includes(f))
  const blocking = kept.filter((f) => f.blocking)

  if (kept.length === 0) {
    const why = `No findings. ${invented.length} dropped, quoted line not in the diff.`
    await note(pr, `## 🔎 Review\n\n✅ ${why}`)
    await conclude(head(mr), 'success', why)
    console.log(why)
    return
  }

  kept.forEach((f, i) => (f.id = `F${i + 1}`))

  // One note for the lot, not a discussion per line. Anchoring on GitLab needs a position
  // carrying the base, head and start shas of the diff, and a position that is subtly wrong
  // is a comment on the wrong line of the wrong file: worse than a comment that names its
  // line in text. The findings and their locations are all here, just not attached.
  const orphans = kept.filter((f) => textAt(diff, f) === undefined)
  const { counts, body } = summary({ kept, invented, orphans, stats: runStats() })
  await note(pr, [body, '', ...bullets(kept)].join('\n'))

  await conclude(head(mr), blocking.length ? 'failed' : 'success', counts)
  console.log(`posted ${kept.length} findings on !${pr}`)
}

// GitLab's commit statuses have no "error": a review that crashed and a review that found a
// blocker both end up as failed, and the description says which.
async function conclude(sha, state, description) {
  await api('POST', `/statuses/${sha}`, {
    state,
    name: CHECK_NAME,
    description: description.slice(0, 140),
  })
}

async function fail(pr, reason) {
  const mr = await api('GET', `/merge_requests/${pr}`)
  await note(pr, `The review did not finish: ${reason}. Comment again to retry.`)
  await conclude(head(mr), 'failed', `Review did not finish: ${reason}`)
}

async function say(pr, message) {
  await note(pr, message)
  console.log(`commented on !${pr}`)
}

// What `gh pr diff` gives the GitHub path. GitLab returns one unified hunk set per file
// without the headers around it, so the headers are put back: format.mjs's diffLines reads
// the file name off `+++ b/...` and the line numbers off the hunks, and needs both.
async function diff(pr) {
  const changes = await api('GET', `/merge_requests/${pr}/changes`)
  const out = []

  for (const file of changes.changes ?? []) {
    if (!file.diff) continue
    out.push(`diff --git a/${file.old_path} b/${file.new_path}`)
    out.push(file.new_file ? '--- /dev/null' : `--- a/${file.old_path}`)
    out.push(file.deleted_file ? '+++ /dev/null' : `+++ b/${file.new_path}`)
    out.push(file.diff.replace(/\n$/, ''))
  }

  if (out.length) process.stdout.write(`${out.join('\n')}\n`)
}

// What `gh pr view -q .headRefName` gives the GitHub path, and nothing else on stdout:
// review.sh captures this one with $(...).
async function branch(pr) {
  const mr = await api('GET', `/merge_requests/${pr}`)
  console.log(mr.source_branch)
}

// hermes's own exit code does not reflect whether this actually ran (see dispatch.mjs), so
// dispatch.mjs looks for this file instead to decide whether anything reached the merge
// request. Only touched on the success path, right before this process's own exit 0. diff
// and branch never touch this: they only read, dispatch.mjs does not wait on them for proof
// that something was published.
function markPublished() {
  if (process.env.PUBLISH_MARKER) writeFileSync(process.env.PUBLISH_MARKER, '')
}

const [command, pr, ...rest] = process.argv.slice(2)

if (command === 'post' && pr) {
  post(pr).then(markPublished).catch(exit)
} else if (command === 'fail' && pr) {
  fail(pr, rest.join(' ') || 'unknown reason').then(markPublished).catch(exit)
} else if (command === 'say' && pr && rest.length) {
  say(pr, rest.join(' ')).then(markPublished).catch(exit)
} else if (command === 'diff' && pr) {
  diff(pr).catch(exit)
} else if (command === 'branch' && pr) {
  branch(pr).catch(exit)
} else {
  console.error('usage: gitlab.mjs post <mr> | fail <mr> <reason> | say <mr> <message> | diff <mr> | branch <mr>')
  process.exit(1)
}

function exit(error) {
  console.error(error.message)
  process.exit(1)
}
