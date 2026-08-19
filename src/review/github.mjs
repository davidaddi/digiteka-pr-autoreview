#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs'

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

function readFindings(path) {
  const findings = JSON.parse(readFileSync(path, 'utf8'))
  if (!Array.isArray(findings)) throw new Error(`${path} is not a JSON array`)
  for (const finding of findings) {
    if (!finding.file || !finding.claim || !finding.impact || !finding.quote) {
      throw new Error(`finding without file, claim, impact or quote: ${JSON.stringify(finding)}`)
    }
  }
  return findings
}

const BADGE = { 'must-fix': '🔴 must-fix', concern: '🟠 concern', nit: '⚪ nit' }

function runStats() {
  try {
    const [model, seconds] = readFileSync(process.env.META_FILE ?? '.run.meta', 'utf8').trim().split('\n')
    const elapsed = Number(seconds)

    let tokens = 0
    for (const line of readFileSync(process.env.RUN_FILE ?? '.run.json', 'utf8').split('\n')) {
      if (!line.includes('"type":"result"')) continue
      try {
        const u = JSON.parse(line).usage ?? {}
        tokens +=
          (u.input_tokens ?? 0) +
          (u.output_tokens ?? 0) +
          (u.cache_creation_input_tokens ?? 0) +
          (u.cache_read_input_tokens ?? 0)
      } catch {}
    }

    return {
      model,
      time:
        elapsed >= 60
          ? `${Math.floor(elapsed / 60)}m${String(elapsed % 60).padStart(2, '0')}s`
          : `${elapsed}s`,
      tokens: tokens >= 1e6 ? `${(tokens / 1e6).toFixed(1)}M` : `${Math.round(tokens / 1000)}k`,
    }
  } catch {
    return null
  }
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

function diffLines(diffPath) {
  const byFile = new Map()
  let file = null
  let line = 0

  for (const raw of readFileSync(diffPath, 'utf8').split('\n')) {
    if (raw.startsWith('+++ ')) {
      file = raw.slice(4).replace(/^b\//, '').trim()
      if (file === '/dev/null') file = null
      if (file) byFile.set(file, new Map())
      continue
    }
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)/)
    if (hunk) {
      line = Number(hunk[1])
      continue
    }
    if (!file || !byFile.has(file)) continue
    if (raw.startsWith('+') || raw.startsWith(' ')) byFile.get(file).set(line++, raw.slice(1))
  }
  return byFile
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
  const findings = readFindings(process.env.FINDINGS_FILE ?? '.findings.json')
  const pull = await api('GET', `/pulls/${pr}`)

  if (findings.length === 0) {
    await api('POST', `/issues/${pr}/comments`, { body: '## 🔎 Review\n\n✅ No findings. Nothing to flag on this diff.' })
    await conclude(pull.head.sha, 'success', 'No findings')
    console.log('no findings, comment posted')
    return
  }

  const diff = diffLines(process.env.DIFF_FILE ?? '.pr.diff')
  const textAt = (f) => (Number.isInteger(f.line) ? diff.get(f.file)?.get(f.line) : undefined)

  const stripMarker = (quote) => (quote.startsWith('+') || quote.startsWith('-') ? quote.slice(1) : quote)

  const invented = findings.filter((f) => {
    const text = textAt(f)
    if (text === undefined) return false
    const quote = String(f.quote)
    return text.trim() !== quote.trim() && text.trim() !== stripMarker(quote).trim()
  })
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

  const anchored = kept.filter((f) => textAt(f) !== undefined)
  const orphans = kept.filter((f) => textAt(f) === undefined)
  const comments = anchored.map(anchor)

  const stats = runStats()
  const counts = [
    `${kept.length} finding${kept.length > 1 ? 's' : ''}, ${blocking.length} blocking.`,
    invented.length ? `${invented.length} dropped, quoted line not in the diff.` : '',
    stats ? `${stats.time}, ${stats.tokens} tokens.` : '',
  ]
    .filter(Boolean)
    .join(' ')

  const table = [
    '| id | sev | location | dimension |',
    '| --- | --- | --- | --- |',
    ...kept.map(
      (f) =>
        `| ${f.id} | ${BADGE[f.severity] ?? '🟠 concern'} | \`${f.file}:${f.line}\` | ${f.dimension ?? ''} |`,
    ),
  ].join('\n')

  const parts = [`## 🔎 Review${stats ? ` — model \`${stats.model}\`` : ''}`, counts, '', table]
  if (orphans.length) {
    parts.push('', `Outside the diff, so not anchorable: ${orphans.map((f) => `\`${f.file}:${f.line}\``).join(', ')}`)
  }
  parts.push('', '> 🛠️ Accept a suggestion inline, or reply `/fix` to have the agent code and test the fixes (`/revert` to undo).')
  const summary = parts.join('\n')

  const review = { commit_id: pull.head.sha, body: summary, comments }
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
    const body = [summary, '', ...kept.map((f) => `- \`${f.file}:${f.line}\` ${f.claim}`)].join('\n')
    await api('POST', `/issues/${pr}/comments`, { body })
  }

  await conclude(pull.head.sha, blocking.length ? 'failure' : 'success', counts)
  console.log(`posted ${kept.length} findings on #${pr}, ${anchored.length} anchored`)
}

async function conclude(sha, state, summary) {
  await api('POST', `/statuses/${sha}`, {
    state,
    context: CHECK_NAME,
    description: summary.slice(0, 140),
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

const [command, pr, ...rest] = process.argv.slice(2)

if (command === 'post' && pr) {
  post(pr).catch(exit)
} else if (command === 'fail' && pr) {
  fail(pr, rest.join(' ') || 'unknown reason').catch(exit)
} else if (command === 'say' && pr && rest.length) {
  say(pr, rest.join(' ')).catch(exit)
} else {
  console.error('usage: github.mjs post <pr> | fail <pr> <reason> | say <pr> <message>')
  process.exit(1)
}

function exit(error) {
  console.error(error.message)
  process.exit(1)
}
