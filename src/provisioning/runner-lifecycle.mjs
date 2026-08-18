#!/usr/bin/env node
import { spawn } from 'node:child_process'
import {
  chmodSync,
  closeSync,
  cpSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { ROOT, parseSlug } from './registry.mjs'
import { createRegistrationToken, createRemoveToken, deleteRunner, findRunner } from './github-provision.mjs'

// Pin a version with RUNNER_VERSION=2.331.0 to skip the release lookup.
// Empty means "resolve the latest release", falling back to the pin below when GitHub is unreachable.
const RUNNER_VERSION = process.env.RUNNER_VERSION ?? ''
const FALLBACK_VERSION = '2.336.0'
const LABEL = 'hermes-review'
const RUNNERS = join(ROOT, 'runners')
const BIN = join(RUNNERS, '_bin')
const CACHE = join(RUNNERS, '.cache')
const STOP_TIMEOUT_MS = 20000
const START_TIMEOUT_MS = 30000

const ARCH = { x64: 'x64', arm64: 'arm64' }[process.arch]

export function runnerDir(owner, name) {
  return join(RUNNERS, `${owner}-${name}`)
}

function runnerName(owner, name) {
  return `${owner}-${name}-runner`
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function redact(text, ...secrets) {
  return secrets.filter(Boolean).reduce((out, secret) => out.split(secret).join('***'), String(text))
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options })
    let out = ''
    child.stdout?.on('data', (chunk) => (out += chunk))
    child.stderr?.on('data', (chunk) => (out += chunk))
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${command} exited ${code}\n${out.trim().slice(-800)}`)),
    )
  })
}

// runner.log is appended to for as long as the runner lives, so never read the whole thing.
export function logTail(owner, name, lines = 20) {
  const file = join(runnerDir(owner, name), 'runner.log')
  if (!existsSync(file)) return ''

  const size = statSync(file).size
  const from = Math.max(0, size - 64 * 1024)
  const buffer = Buffer.alloc(size - from)
  const fd = openSync(file, 'r')
  try {
    readSync(fd, buffer, 0, buffer.length, from)
  } finally {
    closeSync(fd)
  }
  return buffer.toString('utf8').trim().split('\n').slice(-lines).join('\n')
}

async function resolveRelease() {
  const headers = { accept: 'application/vnd.github+json' }
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`

  if (RUNNER_VERSION) return asset(RUNNER_VERSION, null)

  try {
    const response = await fetch('https://api.github.com/repos/actions/runner/releases/latest', { headers })
    if (!response.ok) throw new Error(`releases/latest -> ${response.status}`)
    const release = await response.json()
    const version = String(release.tag_name ?? '').replace(/^v/, '')
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`unexpected tag ${release.tag_name}`)
    const found = release.assets?.find((item) => item.name === `actions-runner-linux-${ARCH}-${version}.tar.gz`)
    return asset(version, found)
  } catch (error) {
    console.error(`could not read the latest runner release (${error.message}), falling back to ${FALLBACK_VERSION}`)
    return asset(FALLBACK_VERSION, null)
  }
}

function asset(version, found) {
  const name = `actions-runner-linux-${ARCH}-${version}.tar.gz`
  return {
    version,
    name,
    url: found?.browser_download_url ?? `https://github.com/actions/runner/releases/download/v${version}/${name}`,
    digest: typeof found?.digest === 'string' && found.digest.startsWith('sha256:') ? found.digest.slice(7) : null,
  }
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(file)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
  })
}

export async function ensureRunnerBinary() {
  if (!ARCH) throw new Error(`no actions/runner build for ${process.platform}/${process.arch}`)
  if (process.platform !== 'linux') throw new Error('the runner lifecycle only handles linux hosts')

  const marker = join(BIN, '.version')
  if (existsSync(join(BIN, 'config.sh')) && existsSync(marker)) {
    const installed = readFileSync(marker, 'utf8').trim()
    if (!RUNNER_VERSION || RUNNER_VERSION === installed) return installed
  }

  const release = await resolveRelease()
  const tarball = join(CACHE, release.name)
  mkdirSync(CACHE, { recursive: true })
  mkdirSync(BIN, { recursive: true })

  if (!existsSync(tarball) || statSync(tarball).size === 0) {
    console.log(`downloading actions-runner ${release.version} for linux-${ARCH}`)
    const response = await fetch(release.url, { redirect: 'follow' })
    if (!response.ok || !response.body) throw new Error(`download -> ${response.status}`)
    const partial = `${tarball}.part`
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial))
    if (release.digest) {
      const got = await sha256(partial)
      if (got !== release.digest) {
        rmSync(partial, { force: true })
        throw new Error(`checksum mismatch on ${release.name}`)
      }
    }
    renameSync(partial, tarball)
  }

  await run('tar', ['-xzf', tarball, '-C', BIN])
  writeFileSync(marker, `${release.version}\n`)
  console.log(`actions-runner ${release.version} ready in runners/_bin`)
  return release.version
}

export function status(owner, name) {
  const dir = runnerDir(owner, name)
  const file = join(dir, 'runner.pid')
  if (!existsSync(file)) return 'down'

  let pid = 0
  try {
    pid = Number(readFileSync(file, 'utf8').trim())
  } catch {
    return 'down'
  }
  if (!Number.isInteger(pid) || pid <= 1) return 'down'
  try {
    process.kill(pid, 0)
  } catch {
    return 'down'
  }
  return owns(pid, dir) ? 'up' : 'down'
}

// A pid file outlives its process and pids get recycled, so confirm the process really is
// this runner before calling it up, and above all before signalling it in stop().
function owns(pid, dir) {
  if (!existsSync(`/proc/${pid}`)) return true
  let cmdline = ''
  try {
    cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ')
  } catch {
    return false
  }
  if (!/run\.sh|Runner\.Listener/.test(cmdline)) return false
  try {
    return realpathSync(readlinkSync(`/proc/${pid}/cwd`)) === realpathSync(dir)
  } catch {
    return true
  }
}

export async function start(owner, name) {
  parseSlug(`${owner}/${name}`)
  const repo = `${owner}/${name}`
  const dir = runnerDir(owner, name)
  if (status(owner, name) === 'up') return 'already up'

  await ensureRunnerBinary()
  if (!existsSync(join(dir, 'config.sh'))) {
    mkdirSync(RUNNERS, { recursive: true })
    cpSync(BIN, dir, { recursive: true })
  }
  chmodSync(dir, 0o700)
  setJobEnv(dir)

  // config.sh refuses to run on an already configured directory, and a configured runner
  // only has to be launched again. Its credentials survive a reboot, so a plain restart
  // costs no registration token at all.
  const configured = existsSync(join(dir, '.runner'))
  if (!configured) await configure(owner, name)

  if (await launch(owner, name)) return configured ? 'restarted' : 'started'

  // It was configured and died anyway: the runner was probably deleted on GitHub, or the
  // credentials went stale. Wipe the local configuration and register it again, once.
  if (!configured) throw new Error(`the runner for ${repo} died on start\n${logTail(owner, name)}`)
  console.error(`${repo}: stale runner configuration, registering it again`)
  for (const file of ['.runner', '.credentials', '.credentials_rsaparams']) {
    rmSync(join(dir, file), { force: true })
  }
  await configure(owner, name)
  if (await launch(owner, name)) return 'reconfigured'
  throw new Error(`the runner for ${repo} died on start\n${logTail(owner, name)}`)
}

async function configure(owner, name) {
  const repo = `${owner}/${name}`
  const token = await createRegistrationToken(repo)
  const args = [
    '--url',
    `https://github.com/${repo}`,
    '--token',
    token,
    '--labels',
    LABEL,
    '--name',
    runnerName(owner, name),
    '--work',
    '_work',
    '--unattended',
    '--replace',
  ]

  try {
    // The registration token is an argument, so it is visible in ps for the seconds this
    // runs. It is single use and expires in an hour. Nothing else here ever sees a secret.
    await run('./config.sh', args, { cwd: runnerDir(owner, name), env: runnerEnv() })
  } catch (error) {
    throw new Error(redact(error.message, token))
  }
}

async function launch(owner, name) {
  const dir = runnerDir(owner, name)
  const log = openSync(join(dir, 'runner.log'), 'a')
  const child = spawn('./run.sh', [], { cwd: dir, detached: true, stdio: ['ignore', log, log], env: runnerEnv() })
  child.unref()
  closeSync(log)
  writeFileSync(join(dir, 'runner.pid'), `${child.pid}\n`)

  // Bad credentials take a few seconds to fail, so waiting a fixed moment would call a
  // dying runner started. Wait for it to say it is listening, or for it to die.
  const deadline = Date.now() + START_TIMEOUT_MS
  while (Date.now() < deadline) {
    await delay(500)
    if (status(owner, name) !== 'up') return false
    if (/Listening for Jobs/i.test(logTail(owner, name, 5))) return true
  }
  return status(owner, name) === 'up'
}

// The runner hands its own .env to every job it runs, and workflow/review.yml cds into
// $REVIEWER_HOME. This is what points a job at this checkout instead of the default
// $HOME/pr-review-sandbox. config.sh appends to this file, so keep what is already there.
// Nothing secret goes in it: it is readable by every job the runner accepts.
function setJobEnv(dir) {
  const file = join(dir, '.env')
  const kept = existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line.trim() && !line.startsWith('REVIEWER_HOME='))
    : []
  writeFileSync(file, [...kept, `REVIEWER_HOME=${ROOT.replace(/\/$/, '')}`, ''].join('\n'))
}

function runnerEnv() {
  const env = { ...process.env }
  delete env.GITHUB_TOKEN
  delete env.GH_TOKEN
  if (process.getuid?.() === 0) env.RUNNER_ALLOW_RUNASROOT = '1'
  return env
}

export async function stop(owner, name) {
  const stopped = await terminate(owner, name)
  const unregistered = await unregister(owner, name)
  return `${stopped}, ${unregistered}`
}

async function terminate(owner, name) {
  const dir = runnerDir(owner, name)
  const file = join(dir, 'runner.pid')
  if (status(owner, name) !== 'up') {
    rmSync(file, { force: true })
    return 'already down'
  }

  const pid = Number(readFileSync(file, 'utf8').trim())
  // run.sh is a process group leader (spawned detached), so the negative pid takes
  // Runner.Listener down with it instead of orphaning it.
  signal(-pid, 'SIGTERM') || signal(pid, 'SIGTERM')

  const deadline = Date.now() + STOP_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (status(owner, name) !== 'up') break
    await delay(250)
  }
  if (status(owner, name) === 'up') {
    signal(-pid, 'SIGKILL') || signal(pid, 'SIGKILL')
    await delay(500)
  }

  const alive = status(owner, name) === 'up'
  rmSync(file, { force: true })
  return alive ? 'still running' : 'stopped'
}

function signal(pid, name) {
  try {
    process.kill(pid, name)
    return true
  } catch {
    return false
  }
}

// A runner left registered on GitHub keeps receiving jobs that nobody will ever pick up,
// so a failure here is loud rather than silent.
async function unregister(owner, name) {
  const repo = `${owner}/${name}`
  const dir = runnerDir(owner, name)
  const problems = []

  if (!existsSync(dir)) return 'never started'

  if (existsSync(join(dir, '.runner'))) {
    let token = null
    try {
      token = await createRemoveToken(repo)
      await run('./config.sh', ['remove', '--token', token], { cwd: dir, env: runnerEnv() })
      return 'unregistered'
    } catch (error) {
      problems.push(redact(error.message, token))
    }
  }

  try {
    const runner = await findRunner(repo, runnerName(owner, name))
    if (!runner) return 'not registered'
    return await deleteRunner(repo, runner.id)
  } catch (error) {
    problems.push(error.message)
  }

  throw new Error(`${repo} runner is stopped but still registered on GitHub: ${problems.join(' | ')}`)
}

if (process.argv[1]?.endsWith('runner-lifecycle.mjs')) {
  const [command, target] = process.argv.slice(2)

  const run = async () => {
    if (command === 'ensure') return ensureRunnerBinary()
    if (!target || !['start', 'stop', 'status', 'log'].includes(command)) {
      throw new Error('usage: runner-lifecycle.mjs ensure | start|stop|status|log <owner/name>')
    }
    const { owner, name } = parseSlug(target)
    if (command === 'start') return start(owner, name)
    if (command === 'stop') return stop(owner, name)
    if (command === 'status') return status(owner, name)
    return logTail(owner, name, 40)
  }

  run()
    .then((result) => console.log(result))
    .catch((error) => {
      console.error(error.message)
      process.exit(1)
    })
}
