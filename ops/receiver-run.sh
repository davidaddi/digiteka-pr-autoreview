#!/usr/bin/env bash
#
# ExecStart of hermes-receiver.service. A wrapper for two reasons and no others:
#
#   - systemd needs an absolute path in ExecStart=, and where node lives is a per-machine
#     fact (nvm, /usr/bin, a distro package). Resolving it here through PATH= keeps that
#     fact in one place instead of baking a node path into a unit file.
#   - `exec`, so node -- not this script -- is the process systemd supervises. MAINPID,
#     Restart=always and the SIGTERM on stop all reach node directly.
#
# receiver.mjs reads .env itself through loadEnv(); nothing needs to be exported here.

set -euo pipefail

# shellcheck source=ops/lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

cd "$PR_REVIEW_ROOT"

exec node src/provisioning-webhook/receiver.mjs
