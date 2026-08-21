#!/usr/bin/env bash
#
# ExecStartPost of hermes-receiver.service.
#
# Type=exec only tells systemd that node was executed, which is true even when the receiver
# is about to exit(1) two lines later because WEBHOOK_MULTI_SECRET is missing or a stale
# .runtime.env turned up. This turns "the process was started" into "the port answers", so a
# receiver that dies on startup is a failed unit and not a green one.
#
# /healthz is served by src/provisioning-webhook/receiver.mjs and reports the number of
# active repositories, which is also the answer to "did it read repos.yml".
#
# node is used for the request rather than curl: node is already a hard requirement, curl is
# not necessarily installed on a minimal EC2 image.

set -euo pipefail

# shellcheck source=ops/lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

port=$(env_required WEBHOOK_PORT)
timeout="${RECEIVER_READY_TIMEOUT:-30}"
deadline=$((SECONDS + timeout))

while [ "$SECONDS" -lt "$deadline" ]; do
  if body=$(HEALTH_URL="http://127.0.0.1:${port}/healthz" node --input-type=module -e '
      const response = await fetch(process.env.HEALTH_URL)
      if (!response.ok) process.exit(1)
      process.stdout.write((await response.text()).trim())
    ' 2>/dev/null); then
    note "receiver ready on 127.0.0.1:${port} ($body)"
    exit 0
  fi
  sleep 1
done

die "receiver did not answer on http://127.0.0.1:${port}/healthz within ${timeout}s"
