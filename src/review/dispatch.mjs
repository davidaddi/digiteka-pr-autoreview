#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const HERMES = process.env.HERMES_BIN ?? 'hermes'
const TIMEOUT_MS = Number(process.env.HERMES_TIMEOUT ?? 2400) * 1000
const PROVIDER = process.env.HERMES_PROVIDER
const MODEL = process.env.HERMES_MODEL

export function prompt({ repo, pr, action, argument, root, provider = 'github' }) {
  // One file per forge, same three subcommands: which one publishes is the only difference
  // between reviewing a GitHub pull request and a GitLab merge request from here.
  const cli = `src/review/${provider}.mjs`
  const request = provider === 'gitlab' ? 'merge request' : 'pull request'
  const step2 =
    action === 'review'
      ? `2. node ${cli} post ${pr}, which publishes the findings on the ${request}. Run it even if step 1 found nothing.`
      : `2. node ${cli} say ${pr} "<outcome>", replacing <outcome> with what step 1 actually printed. Quote its file paths and numbers exactly as they appeared and write nothing the output does not contain, no reconstructed paths and no guessed file names. Never report success for a non-zero exit code.`

  return [
    `You orchestrate the "${action}" action on ${repo} ${request} #${pr}${argument ? `, targeting "${argument}"` : ''}.`,
    'You dispatch and you publish. You never read or judge code yourself.',
    `From ${root}, run exactly these two commands, in order, and nothing else.`,
    `1. bash src/review/review.sh ${pr} ${action} ${argument || ''}`.trim() + '.',
    'It blocks for up to forty minutes while a Claude Code session and its subagents do the',
    'work. Wait for it to return. Do not poll it, do not tail its logs, do not check on it:',
    'every extra command costs you a tool call you will need later.',
    step2,
    'Then report both exit codes in one line.',
  ].join(' ')
}

// hermes's bash tool does not forward the parent process's env vars through to the shell
// it runs commands in -- it strips anything whose name looks like a secret (TOKEN, KEY, ...)
// before the child shell ever starts, so GITHUB_TOKEN/GH_TOKEN set here never reach
// review.sh, no matter how they are passed to spawn(). REPO survives because its name does
// not look like a secret; the credentials do not.
//
// The workaround, already proven by workflow/review.yml for the single-repo GitHub Actions
// path: write the token to a file instead of the environment, and have review.sh source it
// from inside the same bash-tool shell that ends up running it -- a plain file read, which
// hermes has no reason to filter. The filename is keyed by repo+pr, the same key
// receiver.mjs's enqueue() already serializes on, so two concurrent reviews (different repos
// or different PRs) never share a file.
//
// A GitLab project can be nested in subgroups, so every slash goes: group/sub/proj would
// otherwise name a file in a directory that does not exist and the write would fail.
function runtimeEnvFile(root, repo, pr) {
  return join(root, `.runtime.${repo.replaceAll('/', '-')}-${pr}.env`)
}

export function runHermes({ repo, pr, action, argument, root, provider = 'github', host = 'github.com' }) {
  const session = `pr-${repo.replaceAll('/', '-')}-${pr}`
  const args = ['-z', prompt({ repo, pr, action, argument, root, provider }), '--yolo', '-c', session]

  if (PROVIDER && MODEL) args.push('--provider', PROVIDER, '--model', MODEL)
  else if (PROVIDER || MODEL) throw new Error('HERMES_PROVIDER and HERMES_MODEL go together')

  // gh reads GH_TOKEN, git and gitlab.mjs read GITLAB_TOKEN: one credential each, and never
  // the other forge's, so a review of one repository cannot carry a token for another.
  const credentials =
    provider === 'gitlab'
      ? `GITLAB_TOKEN="${process.env.GITLAB_TOKEN}"\n`
      : `GITHUB_TOKEN="${process.env.GITHUB_TOKEN}"\nGH_TOKEN="${process.env.GITHUB_TOKEN}"\n`

  const runtimeEnv = runtimeEnvFile(root, repo, pr)
  writeFileSync(
    runtimeEnv,
    `REPO="${repo}"\nREPO_PROVIDER="${provider}"\nREPO_HOST="${host}"\n${credentials}PATH="${process.env.PATH}"\n`,
    { mode: 0o600 },
  )

  const env = {
    ...process.env,
    RUNTIME_ENV_FILE: runtimeEnv,
    TERMINAL_TIMEOUT: String(TIMEOUT_MS / 1000),
    TERMINAL_LIFETIME_SECONDS: String(TIMEOUT_MS / 1000 + 300),
  }

  return new Promise((resolve, reject) => {
    const child = spawn(HERMES, args, { cwd: root, env, stdio: ['ignore', 'inherit', 'inherit'] })
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS)
    const cleanup = () => rmSync(runtimeEnv, { force: true })

    child.on('error', (error) => {
      clearTimeout(timer)
      cleanup()
      reject(error)
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      cleanup()
      if (code === 0) return resolve()
      reject(new Error(signal === 'SIGKILL' ? `no answer after ${TIMEOUT_MS / 60000} minutes` : `exit ${code}`))
    })
  })
}

if (process.argv[1]?.endsWith('dispatch.mjs')) {
  const [pr, action = 'review', ...rest] = process.argv.slice(2)
  const repo = process.env.REPO
  if (!pr || !repo) {
    console.error('usage: REPO=owner/name dispatch.mjs <pr> [review|fix|revert] [target]')
    process.exit(1)
  }
  runHermes({
    repo,
    pr,
    action,
    argument: rest.join(' '),
    root: process.env.SANDBOX_ROOT ?? process.cwd(),
    provider: process.env.REPO_PROVIDER ?? 'github',
    host: process.env.REPO_HOST ?? 'github.com',
  }).catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
