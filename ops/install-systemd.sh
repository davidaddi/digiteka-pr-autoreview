#!/usr/bin/env bash
#
# Renders ops/systemd/*.in into ~/.config/systemd/user/ and reloads the user manager.
#
# The templates are rendered rather than symlinked because two facts cannot be known until
# install time and cannot be expressed in a unit file:
#
#   @PR_REVIEW_ROOT@  where this checkout lives. systemd does not expand variables in
#                  WorkingDirectory=, so the path has to be literal -- but it should not be
#                  literal *in git*, where it would encode one person's home directory.
#   @PR_REVIEW_PATH@  where node, hermes, claude and cloudflared actually are on this machine.
#                  systemd starts services with a bare PATH and does not read .bashrc,
#                  .profile or nvm's shell hook, so an nvm node or a ~/.local/bin claude is
#                  invisible to a service unless its directory is named explicitly.
#
# Run it from a shell where `node`, `hermes` and `claude` work. That is the whole trick:
# whatever PATH you have, this copies the parts of it that matter into the units.
#
# Nothing here is privileged. Everything lands under $HOME.

set -euo pipefail

# shellcheck source=ops/lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

TEMPLATE_DIR="$PR_REVIEW_ROOT/ops/systemd"
UNIT_DIR="${SYSTEMD_USER_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user}"

UNITS=(
  hermes-webhook.target
  hermes-preflight.service
  hermes-tunnel.service
  hermes-webhook-sync.service
  hermes-receiver.service
)

command -v systemctl >/dev/null 2>&1 || die "systemctl is not installed"
SYSTEMCTL=$(command -v systemctl)

systemctl --user show-environment >/dev/null 2>&1 ||
  die "systemd --user is not reachable (no XDG_RUNTIME_DIR / no user manager). See ops/README.md."

# ------------------------------------------------------------------------------- PATH
#
# Built from the directories the tools actually resolve to right now, then the usual system
# directories, deduplicated and order-preserving. Missing tools are reported but do not stop
# the install: ops/preflight.sh will refuse to let the chain start, with a better message,
# and being able to install before hermes is configured is useful.
path_parts=()
missing=()
add_path() {
  local dir="$1" existing
  [ -n "$dir" ] || return 0
  for existing in ${path_parts[@]+"${path_parts[@]}"}; do
    [ "$existing" = "$dir" ] && return 0
  done
  path_parts+=("$dir")
}

for bin in node cloudflared hermes claude git gh bash; do
  if resolved=$(command -v "$bin" 2>/dev/null); then
    # -m resolves the symlink chain: ~/.local/bin/claude is often a link into a versioned
    # directory, and it is the *link's* directory that has to be on PATH, so use both.
    add_path "$(dirname "$resolved")"
    if real=$(readlink -f "$resolved" 2>/dev/null); then add_path "$(dirname "$real")"; fi
    printf '  %-12s %s\n' "$bin" "$resolved"
  else
    missing+=("$bin")
    printf '  %-12s NOT FOUND\n' "$bin"
  fi
done

for dir in /usr/local/sbin /usr/local/bin /usr/sbin /usr/bin /sbin /bin "$HOME/.local/bin"; do
  [ -d "$dir" ] && add_path "$dir"
done

PR_REVIEW_PATH=$(IFS=:; printf '%s' "${path_parts[*]}")

if [ ${#missing[@]} -gt 0 ]; then
  printf '\nwarning: not on PATH right now: %s\n' "${missing[*]}" >&2
  printf 'The units will install, but ops/preflight.sh will refuse to start the chain\n' >&2
  printf 'until they are installed. Re-run this script afterwards to pick them up.\n\n' >&2
fi

# ---------------------------------------------------------------------------- rendering
mkdir -p "$UNIT_DIR"
RENDERED_AT=$(date -u +'%Y-%m-%dT%H:%M:%SZ')

printf '\ninstalling into %s\n' "$UNIT_DIR"
for unit in "${UNITS[@]}"; do
  template="$TEMPLATE_DIR/$unit.in"
  [ -f "$template" ] || die "missing template $template"
  # '|' as the sed delimiter: every value here is a path and contains '/'.
  sed \
    -e "s|@PR_REVIEW_ROOT@|$PR_REVIEW_ROOT|g" \
    -e "s|@PR_REVIEW_PATH@|$PR_REVIEW_PATH|g" \
    -e "s|@SYSTEMCTL@|$SYSTEMCTL|g" \
    -e "s|@RENDERED_AT@|$RENDERED_AT|g" \
    "$template" >"$UNIT_DIR/$unit.tmp"
  mv -f "$UNIT_DIR/$unit.tmp" "$UNIT_DIR/$unit"
  printf '  %s\n' "$unit"
done

# lib.sh is sourced, never run, and stays non-executable so nobody is tempted.
for script in "$PR_REVIEW_ROOT"/ops/*.sh; do
  [ "$(basename "$script")" = lib.sh ] || chmod +x "$script"
done

systemctl --user daemon-reload

# ------------------------------------------------------------------------------ linger
#
# The one thing that decides whether any of this survives a reboot. A --user manager is
# normally torn down when the user's last session ends and is only started at boot if the
# user lingers. On an EC2 instance nobody logs into, no linger means no services, and the
# symptom is "everything works when I ssh in and nothing works at 4am".
linger=$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || echo unknown)
printf '\nlinger for %s: %s\n' "$USER" "$linger"
if [ "$linger" != "yes" ]; then
  cat >&2 <<EOF

  These services will NOT start at boot until lingering is enabled:

      sudo loginctl enable-linger $USER

  Without it the user manager only exists while you are logged in.
EOF
fi

cat <<EOF

next:
  ops/preflight.sh                                   check the machine first
  systemctl --user enable --now hermes-webhook.target start everything, now and at boot
  systemctl --user status hermes-receiver             see where it got to
  journalctl --user -u hermes-receiver -f             watch it work

uninstall: ops/uninstall-systemd.sh
EOF
