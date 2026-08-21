// What a published review looks like, minus the forge. github.mjs anchors each finding on
// its line and gitlab.mjs posts one note for all of them, but the findings file, the mapping
// from the diff back to line numbers, the quote check and the summary are the same work in
// both, and two copies of the line matching would drift apart the first time one is fixed.
import { readFileSync } from 'node:fs'

export const BADGE = { 'must-fix': '🔴 must-fix', concern: '🟠 concern', nit: '⚪ nit' }

export function readFindings(path) {
  const findings = JSON.parse(readFileSync(path, 'utf8'))
  if (!Array.isArray(findings)) throw new Error(`${path} is not a JSON array`)
  for (const finding of findings) {
    if (!finding.file || !finding.claim || !finding.impact || !finding.quote) {
      throw new Error(`finding without file, claim, impact or quote: ${JSON.stringify(finding)}`)
    }
  }
  return findings
}

export function runStats() {
  try {
    const [model, seconds] = readFileSync(process.env.META_FILE ?? 'runs/.run.meta', 'utf8').trim().split('\n')
    const elapsed = Number(seconds)

    let tokens = 0
    for (const line of readFileSync(process.env.RUN_FILE ?? 'runs/.run.json', 'utf8').split('\n')) {
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

export function diffLines(diffPath) {
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

export function textAt(diff, finding) {
  return Number.isInteger(finding.line) ? diff.get(finding.file)?.get(finding.line) : undefined
}

// A finding that names a line of the diff but quotes something else was not read off that
// line. Dropped rather than posted: it is the one failure mode a reader cannot check.
export function unquoted(findings, diff) {
  const stripMarker = (quote) => (quote.startsWith('+') || quote.startsWith('-') ? quote.slice(1) : quote)

  return findings.filter((f) => {
    const text = textAt(diff, f)
    if (text === undefined) return false
    const quote = String(f.quote)
    return text.trim() !== quote.trim() && text.trim() !== stripMarker(quote).trim()
  })
}

// The header both forges get: what was found, what was dropped, what it cost, and a table
// that stays readable when the findings are not attached to their lines.
export function summary({ kept, invented, orphans, stats }) {
  const blocking = kept.filter((f) => f.blocking)

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

  return { counts, body: parts.join('\n') }
}

// The fallback shape: every finding as one line, for when they cannot be posted on the lines
// they are about.
export function bullets(kept) {
  return kept.map((f) => `- \`${f.file}:${f.line}\` ${f.claim}`)
}
