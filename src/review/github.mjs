#!/usr/bin/env node
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { BADGE, bullets, diffLines, readFindings, runStats, summary, textAt, unquoted } from './format.mjs'

const RUNTIME_ENV_FILE = process.env.RUNTIME_ENV_FILE ?? '.runtime.env'
if (existsSync(RUNTIME_ENV_FILE)) {
  for (const line of readFileSync(RUNTIME_ENV_FILE, 'utf8').split('\n')) {
    const at = line.indexOf('=')
    if (at < 1) continue
    const value = line.slice(at + 1).replace(/^"(.*)"$/s, '$1')
    process.env[line.slice(0, at)] ??= value
  }
}

const TOKEN = required('GITHUB_TOKEN')
const REPO = required('REPO')
const API = 'https://api.github.com'
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
  const response = await fetch(`${API}/repos/${REPO}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status} ${await response.text()}`)
  }
  return response.json()
}

function commentBody(finding) {
  const badge = BADGE[finding.severity] ?? '🟠 concern'
  const head = [badge, finding.dimension].filter(Boolean).join(' · ')
  const lines = [
    `**${head}** (${finding.id})`,
    '',
    finding.claim,
    '',
    `**Impact.** ${finding.impact}`,
  ]

  if (finding.suggestion) lines.push('', '```suggestion', finding.suggestion, '```')

  if (finding.why) {
    lines.push(
      '',
      '<details><summary>Why</summary>',
      '',
      `\`${finding.file}:${finding.line}\``,
      '```',
      finding.quote,
      '```',
      '',
      finding.why,
      '',
      '</details>',
    )
  }

  if (!finding.suggestion) lines.push('', '_Reply `/fix` and the agent will code and test this._')
  return lines.join('\n')
}

function anchor(finding) {
  const comment = { path: finding.file, line: finding.line, side: 'RIGHT', body: commentBody(finding) }
  if (Number.isInteger(finding.start_line) && finding.start_line < finding.line) {
    comment.start_line = finding.start_line
    comment.start_side = 'RIGHT'
  }
  return comment
}

async function post(pr) {
  const findings = readFindings(process.env.FINDINGS_FILE ?? 'runs/.findings.json')
  const pull = await api('GET', `/pulls/${pr}`)

  if (findings.length === 0) {
    await api('POST', `/issues/${pr}/comments`, { body: '## 🔎 Review\n\n✅ No findings. Nothing to flag on this diff.' })
    await conclude(pull.head.sha, 'success', 'No findings')
    console.log('no findings, comment posted')
    return
  }

  const diff = diffLines(process.env.DIFF_FILE ?? 'runs/.pr.diff')
  const invented = unquoted(findings, diff)
  for (const f of invented) console.error(`quote does not match ${f.file}:${f.line}, dropped`)

  const kept = findings.filter((f) => !invented.includes(f))
  const blocking = kept.filter((f) => f.blocking)

  if (kept.length === 0) {
    const why = `No findings. ${invented.length} dropped, quoted line not in the diff.`
    await api('POST', `/issues/${pr}/comments`, { body: `## 🔎 Review\n\n✅ ${why}` })
    await conclude(pull.head.sha, 'success', why)
    console.log(why)
    return
  }

  kept.forEach((f, i) => (f.id = `F${i + 1}`))

  const anchored = kept.filter((f) => textAt(diff, f) !== undefined)
  const orphans = kept.filter((f) => textAt(diff, f) === undefined)
  const comments = anchored.map(anchor)

  const { counts, body } = summary({ kept, invented, orphans, stats: runStats() })

  const review = { commit_id: pull.head.sha, body, comments }
  const events = blocking.length ? ['REQUEST_CHANGES', 'COMMENT'] : ['COMMENT']
  let posted = false

  for (const event of events) {
    try {
      await api('POST', `/pulls/${pr}/reviews`, { ...review, event })
      posted = true
      break
    } catch (error) {
      console.error(`review as ${event} failed: ${error.message}`)
    }
  }

  if (!posted) {
    await api('POST', `/issues/${pr}/comments`, { body: [body, '', ...bullets(kept)].join('\n') })
  }

  await conclude(pull.head.sha, blocking.length ? 'failure' : 'success', counts)
  console.log(`posted ${kept.length} findings on #${pr}, ${anchored.length} anchored`)
}

async function conclude(sha, state, description) {
  await api('POST', `/statuses/${sha}`, {
    state,
    context: CHECK_NAME,
    description: description.slice(0, 140),
  })
}

async function fail(pr, reason) {
  const pull = await api('GET', `/pulls/${pr}`)
  await api('POST', `/issues/${pr}/comments`, {
    body: `The review did not finish: ${reason}. Comment again to retry.`,
  })
  await conclude(pull.head.sha, 'error', `Review did not finish: ${reason}`)
}

async function say(pr, message) {
  await api('POST', `/issues/${pr}/comments`, { body: message })
  console.log(`commented on #${pr}`)
}

// hermes's own exit code does not reflect whether this actually ran (see dispatch.mjs), so
// dispatch.mjs looks for this file instead to decide whether anything reached the pull
// request. Only touched on the success path, right before this process's own exit 0.
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
} else {
  console.error('usage: github.mjs post <pr> | fail <pr> <reason> | say <pr> <message>')
  process.exit(1)
}

function exit(error) {
  console.error(error.message)
  process.exit(1)
}
