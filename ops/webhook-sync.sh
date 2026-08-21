#!/usr/bin/env bash
#
# ExecStart of hermes-webhook-sync.service.
#
# WHY THIS EXISTS AT ALL. `cloudflared tunnel --url` is a *quick* tunnel: Cloudflare hands
# out a fresh <random>.trycloudflare.com every single time the process starts. Nothing about
# it survives a crash, a restart or a reboot. So the moment the tunnel comes back it is at a
# new address, and every webhook GitHub holds is POSTing at a hostname that no longer
# resolves here. GitHub does not complain to anyone; it records a delivery failure nobody
# reads. The fleet is deaf and everything looks fine.
#
# `sync-repos.mjs refresh` PATCHes every registered hook to the current url, so this has to
# run after *every* start of the tunnel, not only the first one. That is why it is triggered
# from the tunnel unit's ExecStartPost rather than being a plain boot-time dependency:
# ExecStartPost runs on automatic restarts too, ordinary dependencies do not.
#
# None of this is needed once WEBHOOK_PUBLIC_URL points at a stable hostname (a named
# cloudflared tunnel with a DNS route). sync-repos.mjs then uses that and the refresh is a
# no-op, but harmless, so this unit stays in place either way.

set -euo pipefail

# shellcheck source=ops/lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

cd "$PR_REVIEW_ROOT"

# Two refreshes can be queued at once: one from the tunnel's ExecStartPost and one from a
# hand-run `systemctl start`. Both do read-modify-write on webhooks.json, and interleaving
# them can drop a hook id, which orphans a webhook on GitHub that nothing here can name any
# more. The lock costs nothing and removes the whole class of problem.
lock="$PR_REVIEW_ROOT/.webhook-sync.lock"
if command -v flock >/dev/null 2>&1; then
  exec 9>"$lock"
  if ! flock -w "${WEBHOOK_SYNC_LOCK_WAIT:-300}" 9; then
    die "another webhook sync has held $lock for too long"
  fi
else
  note "warning: flock is not installed, running without the webhooks.json lock"
fi

# exec, so node is the process systemd waits on and its exit code is the unit's. Fd 9 stays
# open across the exec, so the lock is held for as long as node runs and released when it
# exits, however it exits.
exec node src/provisioning-webhook/sync-repos.mjs refresh
