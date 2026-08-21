#!/usr/bin/env bash
#
# Stops, disables and removes everything ops/install-systemd.sh put in
# ~/.config/systemd/user/. Leaves .env, repos.yml, webhooks.json and the registered GitHub
# webhooks alone -- this uninstalls the supervision, not the setup.
#
# To also remove the webhooks from GitHub:
#   node src/provisioning-webhook/sync-repos.mjs remove <owner>/<name>

set -euo pipefail

# shellcheck source=ops/lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

UNIT_DIR="${SYSTEMD_USER_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user}"

UNITS=(
  hermes-receiver.service
  hermes-webhook-sync.service
  hermes-tunnel.service
  hermes-preflight.service
  hermes-webhook.target
)

command -v systemctl >/dev/null 2>&1 || die "systemctl is not installed"

# Target first, so PartOf= takes the services down in one go and nothing is restarted by a
# dependency halfway through.
systemctl --user stop hermes-webhook.target 2>/dev/null || true
for unit in "${UNITS[@]}"; do
  systemctl --user stop "$unit" 2>/dev/null || true
  systemctl --user disable "$unit" 2>/dev/null || true
  systemctl --user reset-failed "$unit" 2>/dev/null || true
done

for unit in "${UNITS[@]}"; do
  if [ -e "$UNIT_DIR/$unit" ]; then
    rm -f "$UNIT_DIR/$unit"
    printf 'removed %s\n' "$UNIT_DIR/$unit"
  fi
done

systemctl --user daemon-reload
systemctl --user reset-failed 2>/dev/null || true

printf '\nunits removed. .env, repos.yml, webhooks.json and the GitHub webhooks are untouched.\n'

# The webhooks on GitHub now point at a tunnel that is gone. Say so, because the failure is
# otherwise silent on both ends.
if [ -s "${WEBHOOKS_FILE:-$PR_REVIEW_ROOT/webhooks.json}" ]; then
  printf 'Registered webhooks still exist and now point at a dead url. Either re-install, or:\n'
  printf '  node src/provisioning-webhook/sync-repos.mjs list\n'
fi
