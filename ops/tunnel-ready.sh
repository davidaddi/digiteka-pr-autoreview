#!/usr/bin/env bash
#
# ExecStartPost of hermes-tunnel.service, called as: tunnel-ready.sh $MAINPID
#
# Waits for cloudflared to publish its quick-tunnel hostname, then writes .tunnel.json in
# exactly the shape src/provisioning-webhook/tunnel-lifecycle.mjs writes it:
#
#   { "url": "...", "pid": <cloudflared pid>, "port": <n>, "startedAt": "<iso>" }
#
# That file is the contract between the tunnel and everything that needs its address:
# sync-repos.mjs publicUrl(), the web console's tunnel panel, and tunnel-lifecycle.mjs
# status()/url(). status() confirms the pid really is cloudflared by reading
# /proc/<pid>/cmdline, which is why the pid written here has to be cloudflared's own and
# not a wrapper's -- ops/tunnel-run.sh execs, so $MAINPID is cloudflared.
#
# Failing here fails the unit, which is the point: Restart=always then throws the tunnel
# away and tries again, instead of leaving a cloudflared up that nobody knows the address of.

set -euo pipefail

# shellcheck source=ops/lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

pid="${1:-${MAINPID:-}}"
[ -n "$pid" ] || die "no pid given (systemd should pass \$MAINPID)"

port=$(env_required WEBHOOK_PORT)
timeout="${TUNNEL_START_TIMEOUT:-60}"
deadline=$((SECONDS + timeout))
url=''

while [ "$SECONDS" -lt "$deadline" ]; do
  url=$( (grep -o -m 1 -E 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG_FILE" 2>/dev/null || true) | head -n 1)
  [ -n "$url" ] && break
  # If cloudflared has already died there is nothing left to wait for. Say so now rather
  # than spending the whole timeout on a process that is not there.
  kill -0 "$pid" 2>/dev/null || die "cloudflared (pid $pid) exited before publishing a url, see $TUNNEL_LOG_FILE"
  sleep 1
done

[ -n "$url" ] || die "no tunnel url after ${timeout}s, see $TUNNEL_LOG_FILE"

# Written through a temp file and renamed, like the node version: a reader that catches this
# half-written would get invalid JSON and treat the tunnel as down.
tmp="${TUNNEL_STATE_FILE}.tmp"
printf '{\n  "url": "%s",\n  "pid": %s,\n  "port": %s,\n  "startedAt": "%s"\n}\n' \
  "$url" "$pid" "$port" "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" >"$tmp"
mv -f "$tmp" "$TUNNEL_STATE_FILE"

note "tunnel up at $url (cloudflared pid $pid, forwarding to 127.0.0.1:$port)"
