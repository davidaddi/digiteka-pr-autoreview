# shellcheck shell=bash
#
# Shared helpers for the scripts in ops/. Sourced, never executed on its own.
#
# Everything is derived from PR_REVIEW_ROOT, the repository checkout. It defaults to the
# parent of this file's directory, so the checkout can live anywhere: /home/ubuntu/hermes-pr-review
# on EC2, ~/projects/... on a laptop. Nothing below hardcodes a user or a path.

PR_REVIEW_ROOT="${PR_REVIEW_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
export PR_REVIEW_ROOT

ENV_FILE="${PR_REVIEW_ENV_FILE:-$PR_REVIEW_ROOT/.env}"
TUNNEL_LOG_FILE="${TUNNEL_LOG_FILE:-$PR_REVIEW_ROOT/.tunnel.log}"
TUNNEL_STATE_FILE="${TUNNEL_STATE_FILE:-$PR_REVIEW_ROOT/.tunnel.json}"

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

note() {
  printf '%s\n' "$*"
}

# Reads one key out of .env with exactly the rules loadEnv() uses in
# src/provisioning/github-provision.mjs, so the shell side and the node side can never
# disagree about which value is in effect:
#   - the first '=' splits key from value, later ones belong to the value
#   - a line whose first non-blank character is '#' is a comment
#   - the value is trimmed, and one pair of surrounding double quotes is stripped
#   - the first matching line wins (loadEnv uses ??=, so a later duplicate is ignored)
#   - a variable already present in the environment beats the file, again like ??=
#
# Deliberately not `source`: this file holds a GitHub token and an HMAC secret, and a
# stray backtick or $(...) in it must never become a command.
env_value() {
  local key="$1" line value
  if [ -n "${!key+set}" ]; then
    printf '%s' "${!key}"
    return 0
  fi
  [ -f "$ENV_FILE" ] || return 1
  line=$(grep -m 1 -E "^[[:space:]]*${key}=" "$ENV_FILE" 2>/dev/null) || return 1
  value="${line#*=}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  if [ ${#value} -ge 2 ] && [ "${value:0:1}" = '"' ] && [ "${value: -1}" = '"' ]; then
    value="${value:1:${#value}-2}"
  fi
  printf '%s' "$value"
}

# Same, but empty is treated as missing and the caller is told what to fix.
env_required() {
  local key="$1" value
  value=$(env_value "$key" || true)
  [ -n "$value" ] || die "$key is empty or missing in $ENV_FILE"
  printf '%s' "$value"
}
