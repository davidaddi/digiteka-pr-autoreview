#!/usr/bin/env node
import { spawn } from 'node:child_process'
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { ROOT } from '../provisioning/registry.mjs'

// setup.sh opens a quick tunnel for one run and tears it down on Ctrl-C. This mode cannot:
// every registered repository has a webhook pointing at one url, and that url has to keep
// answering between runs. So the tunnel is a small daemon with a pid file instead.
//
// THE LIMITATION, IN FULL: `cloudflared tunnel --url` is a *quick* tunnel. Cloudflare hands
// out a fresh <random>.trycloudflare.com hostname every single time the process starts.
// Nothing about it survives a restart, a crash or a reboot. When this tunnel comes back it
// is at a new address and every webhook created against the old one is pointing at a dead
// host: GitHub will keep POSTing into the void and no /review will ever arrive. The fix is
// one command, `sync-repos.mjs sync`, which PATCHes every registered hook to the new url —
// but it is a manual step, and until it runs the whole fleet is deaf. A named tunnel with a
// real hostname (cloudflared tunnel create + a DNS route) removes the problem entirely and
// is what this should use for anything but a prototype.
const BIN = process.env.CLOUDFLARED_BIN ?? 'cloudflared'
const STATE = process.env.TUNNEL_STATE_FILE ?? join(ROOT, '.tunnel.json')
const LOG = process.env.TUNNEL_LOG_FILE ?? join(ROOT, '.tunnel.log')
const URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/
const START_TIMEOUT_MS = 60000
const STOP_TIMEOUT_MS = 10000

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function state() {
  if (!existsSync(STATE)) return null
  try {
    return JSON.parse(readFileSync(STATE, 'utf8'))
  } catch {
    return null
  }
}

function save(next) {
  const temp = `${STATE}.tmp`
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o644 })
  renameSync(temp, STATE)
  return next
}

// A pid file outlives its process and pids get recycled, so confirm the process really is
// cloudflared before calling the tunnel up, and above all before signalling it.
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  if (!existsSync(`/proc/${pid}`)) return true
  try {
    return /cloudflared/.test(readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' '))
  } catch {
    return false
  }
}

export function status() {
  return alive(state()?.pid) ? 'up' : 'down'
}

export function url() {
  return status() === 'up' ? (state()?.url ?? null) : null
}

function tail(file, bytes = 64 * 1024) {
  if (!existsSync(file)) return ''
  const size = statSync(file).size
  const from = Math.max(0, size - bytes)
  const buffer = Buffer.alloc(size - from)
  const fd = openSync(file, 'r')
  try {
    readSync(fd, buffer, 0, buffer.length, from)
  } finally {
    closeSync(fd)
  }
  return buffer.toString('utf8')
}

export async function start(port = Number(process.env.WEBHOOK_PORT || 8789)) {
  const current = state()
  if (status() === 'up') {
    if (current.port !== port) throw new Error(`a tunnel is already up on port ${current.port}, stop it first`)
    return current
  }

  // Truncated, never appended: a stale hostname left in this log would be picked up as the
  // new one and every webhook would be pointed at a tunnel that no longer exists.
  writeFileSync(LOG, '')
  const log = openSync(LOG, 'a')
  const child = spawn(BIN, ['tunnel', '--protocol', 'http2', '--url', `http://127.0.0.1:${port}`], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', log, log],
  })
  child.unref()
  closeSync(log)

  let failed = null
  child.on('error', (error) => (failed = error))
  const deadline = Date.now() + START_TIMEOUT_MS

  while (Date.now() < deadline) {
    await delay(500)
    if (failed) throw new Error(`could not run ${BIN}: ${failed.message}`)

    const found = tail(LOG).match(URL_PATTERN)
    if (found) return save({ url: found[0], pid: child.pid, port, startedAt: new Date().toISOString() })
    if (!alive(child.pid)) break
  }

  stopPid(child.pid)
  throw new Error(`the tunnel never published a url, see ${LOG}`)
}

function stopPid(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, 'SIGTERM')
      return true
    } catch {}
  }
  return false
}

export async function stop() {
  const current = state()
  if (!alive(current?.pid)) {
    rmSync(STATE, { force: true })
    return 'already down'
  }

  stopPid(current.pid)
  const deadline = Date.now() + STOP_TIMEOUT_MS
  while (Date.now() < deadline && alive(current.pid)) await delay(250)
  if (alive(current.pid)) {
    try {
      process.kill(-current.pid, 'SIGKILL')
    } catch {
      try {
        process.kill(current.pid, 'SIGKILL')
      } catch {}
    }
    await delay(500)
  }

  const still = alive(current.pid)
  rmSync(STATE, { force: true })
  return still ? 'still running' : 'stopped'
}

if (process.argv[1]?.endsWith('tunnel-lifecycle.mjs')) {
  const [command = 'status', arg] = process.argv.slice(2)

  const run = async () => {
    if (command === 'start') return (await start(arg ? Number(arg) : undefined)).url
    if (command === 'stop') return stop()
    if (command === 'status') return status()
    if (command === 'url') return url() ?? ''
    throw new Error('usage: tunnel-lifecycle.mjs start [port] | stop | status | url')
  }

  run()
    .then((result) => console.log(result))
    .catch((error) => {
      console.error(error.message)
      process.exit(1)
    })
}
