#!/usr/bin/env bash
#
# ExecStart of hermes-tunnel.service. Execs cloudflared, so the process systemd supervises
# and restarts *is* cloudflared: its MAINPID is real, Restart=always means something, and a
# crash is visible in `systemctl status` instead of being swallowed.
#
# This is on purpose different from src/provisioning-webhook/tunnel-lifecycle.mjs, which
# double-forks cloudflared into the background and tracks it through .tunnel.json. That is
# the right shape for a shell you are going to close; it is the wrong shape under systemd,
# which would either kill the orphan when the starter exits or, with RemainAfterExit, hold
# the unit 'active' forever while cloudflared is long dead.
#
# tunnel-lifecycle.mjs is not replaced and not modified. ops/tunnel-ready.sh writes the same
# .tunnel.json it would have written, with the same fields, so `tunnel-lifecycle.mjs url`,
# `status`, the web console and sync-repos.mjs all keep working, unaware of the difference.
#
# --logfile is what makes that possible: cloudflared writes the quick-tunnel hostname to the
# file *and* still to stderr, so .tunnel.log stays parseable by the existing code while the
# journal keeps everything for `journalctl --user -u hermes-tunnel`.

set -euo pipefail

# shellcheck source=ops/lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

port=$(env_required WEBHOOK_PORT)

# Truncated, never appended, for the same reason the node version truncates it: a hostname
# left over from the previous tunnel is the first match in the file, and ops/tunnel-ready.sh
# would publish it as the new one. Every webhook would then be re-pointed at a tunnel that
# no longer exists, which looks exactly like everything working.
: > "$TUNNEL_LOG_FILE"

# --loglevel info is explicit rather than implicit: the hostname is an info-level line, and
# a ~/.cloudflared/config.yml with loglevel: warn would silently hide it.
exec cloudflared tunnel \
  --protocol http2 \
  --loglevel info \
  --logfile "$TUNNEL_LOG_FILE" \
  --url "http://127.0.0.1:${port}"
