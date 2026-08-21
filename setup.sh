#!/usr/bin/env bash
#
# Bootstraps the persistent multi-repo webhook mode (src/provisioning-webhook/): a cloudflared
# tunnel and a receiver serving every repository registered in repos.yml, handed off at the
# end to systemd --user (ops/) so both survive reboots with no terminal ever open again.
#
# Every step below is idempotent: re-running ./setup.sh after a failure, a reboot, or a tunnel
# restart just picks up where things stood (the tunnel, the registry and the systemd units all
# check their own state before doing anything). That is also why there is no `trap cleanup EXIT`
# like setup-demo.sh has: tearing down the tunnel/webhook/receiver when this script ends would
# undo the one thing it exists to set up. Ending on purpose is the success case here, not a
# signal to stop everything. A failure *during* setup still exits non-zero via `die` below, but
# nothing already started is torn down: just fix what `die` printed and run ./setup.sh again.

set -euo pipefail

cd "$(dirname "$0")"

info() { printf '  %s\n' "$*"; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die()  { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

step "1. Checking what you have"

missing=()
for binary in node gh cloudflared hermes claude; do
  if command -v "$binary" >/dev/null 2>&1; then
    info "$binary ok"
  else
    info "$binary MISSING"
    missing+=("$binary")
  fi
done

if [ ${#missing[@]} -gt 0 ]; then
  printf '\n  Install the missing ones:\n\n'
  for binary in "${missing[@]}"; do
    case "$binary" in
      node|gh|cloudflared) printf '    brew install %s\n' "$binary" ;;
      hermes) printf '    curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash\n' ;;
      claude) printf '    npm install -g @anthropic-ai/claude-code\n' ;;
    esac
  done
  die "Then run ./setup.sh again."
fi

step "2. .env"

if [ ! -f .env ]; then
  ( umask 077; : > .env )
  info "created .env (mode 600)"
fi

# Reads one key exactly like loadEnv() in src/provisioning/github-provision.mjs does: first
# '=' splits key from value, comment lines start with '#', one pair of surrounding double
# quotes is stripped. Kept in sync by hand rather than sourced from ops/lib.sh's env_value(),
# so this script never touches ops/*.
env_get() {
  local key="$1" line value
  line=$(grep -m1 -E "^[[:space:]]*${key}=" .env 2>/dev/null) || return 1
  value="${line#*=}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  if [ ${#value} -ge 2 ] && [ "${value:0:1}" = '"' ] && [ "${value: -1}" = '"' ]; then
    value="${value:1:${#value}-2}"
  fi
  printf '%s' "$value"
}

# Rewrites the file through bash builtins only (read, printf), never through an external
# command that would carry the secret as one of its own arguments and show up in `ps` while
# it runs. Every value is written back double-quoted, which is what env_get()/loadEnv() expect.
env_set() {
  local key="$1" value="$2" found=0 line
  local out=()
  if [ -f .env ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      if [[ "$line" =~ ^[[:space:]]*${key}= ]]; then
        out+=("${key}=\"${value}\"")
        found=1
      else
        out+=("$line")
      fi
    done < .env
  fi
  [ "$found" -eq 1 ] || out+=("${key}=\"${value}\"")
  ( umask 077; printf '%s\n' "${out[@]}" > .env )
}

if [ -z "$(env_get GITHUB_TOKEN || true)" ]; then
  printf '\n  No GITHUB_TOKEN in .env yet. Mint a classic PAT with the "repo" and "workflow" scopes\n'
  printf '  (fine-grained equivalent: Administration + Webhooks read/write on the repositories\n'
  printf '  you will register) at https://github.com/settings/tokens\n\n'
  read -rsp '  Paste it here (hidden, saved only to .env): ' token
  printf '\n'
  [ -n "$token" ] || die "No token entered. Put GITHUB_TOKEN into .env yourself, then run ./setup.sh again."
  env_set GITHUB_TOKEN "$token"
  unset token
  info "GITHUB_TOKEN saved to .env"
else
  info "GITHUB_TOKEN already set"
fi

if [ -z "$(env_get WEBHOOK_MULTI_SECRET || true)" ]; then
  secret="$(head -c 32 /dev/urandom | base64)"
  env_set WEBHOOK_MULTI_SECRET "$secret"
  unset secret
  info "WEBHOOK_MULTI_SECRET generated"
else
  info "WEBHOOK_MULTI_SECRET already set"
fi

# GitLab does not sign anything: this travels in a header on every delivery instead of being
# proved like GitHub's, but it costs nothing to have ready before the first GitLab repo is
# registered, and the receiver refuses to start without it once one is.
if [ -z "$(env_get WEBHOOK_MULTI_SECRET_GITLAB || true)" ]; then
  secret="$(head -c 32 /dev/urandom | base64)"
  env_set WEBHOOK_MULTI_SECRET_GITLAB "$secret"
  unset secret
  info "WEBHOOK_MULTI_SECRET_GITLAB generated"
else
  info "WEBHOOK_MULTI_SECRET_GITLAB already set"
fi

WEBHOOK_PORT="$(env_get WEBHOOK_PORT || true)"
if [ -z "$WEBHOOK_PORT" ]; then
  WEBHOOK_PORT=8789
  if command -v lsof >/dev/null 2>&1; then
    busy="$(lsof -nP -iTCP:"$WEBHOOK_PORT" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
  else
    busy=""
    ss -lnt 2>/dev/null | grep -q ":$WEBHOOK_PORT " && busy="in use"
  fi
  [ -z "$busy" ] || die "Default port $WEBHOOK_PORT is already taken. Set WEBHOOK_PORT=<other> in .env and run ./setup.sh again."
  env_set WEBHOOK_PORT "$WEBHOOK_PORT"
  info "WEBHOOK_PORT defaulted to $WEBHOOK_PORT"
else
  info "WEBHOOK_PORT already set to $WEBHOOK_PORT"
fi

step "3. Checking hermes and claude are configured"

# Logins are interactive; this script guides you to them but never runs them for you.
PROVIDER="$(hermes config get model.provider 2>/dev/null | head -1 || true)"
case "$PROVIDER" in
  *"not set"*|auto|"")
    printf '\n  Hermes has no provider yet. It only dispatches, so a small model is enough,\n'
    printf '  and a whole review costs a few cents:\n\n'
    printf '    hermes auth add openrouter --type api-key    then pick moonshotai/kimi-k2.6\n'
    printf '    hermes model                                 or a subscription you already have\n\n'
    die "Pick one, then run ./setup.sh again."
    ;;
  *) info "hermes brain: $PROVIDER" ;;
esac

CLAUDE_CREDS="${CLAUDE_CREDENTIALS_FILE:-$HOME/.claude/.credentials.json}"
if [ -s "$CLAUDE_CREDS" ]; then
  info "claude logged in ($CLAUDE_CREDS)"
else
  printf '\n  Claude is not logged in (%s is missing or empty).\n' "$CLAUDE_CREDS"
  printf '  Run once, interactively:\n\n'
  printf '    claude\n\n'
  die "Log in, then run ./setup.sh again."
fi

step "4. Starting the tunnel"

PUBLIC_URL="$(node src/provisioning-webhook/tunnel-lifecycle.mjs start "$WEBHOOK_PORT")" \
  || die "The tunnel did not come up. See .tunnel.log"
info "$PUBLIC_URL"

step "5. Registering at least one repository"

ENTRY_COUNT="$(
  REGISTRY_MODULE="$PWD/src/provisioning/registry.mjs" \
    node --input-type=module -e '
      const { read } = await import(process.env.REGISTRY_MODULE)
      console.log(read().length)
    ' 2>/dev/null || echo 0
)"

if [ "${ENTRY_COUNT:-0}" -gt 0 ] 2>/dev/null; then
  info "repos.yml already has $ENTRY_COUNT registered, re-pointing every webhook at $PUBLIC_URL"
  node src/provisioning-webhook/sync-repos.mjs sync
else
  [ -n "${REPO:-}" ] || die "repos.yml is empty. Set REPO=owner/name and run ./setup.sh again to register the first one."
  info "registering $REPO"
  node src/provisioning-webhook/sync-repos.mjs add "$REPO"
fi

step "6. Handing off to systemd"

# The bootstrap tunnel above only existed to get a url for step 5's first registration.
# hermes-tunnel.service starts its own cloudflared and re-points every webhook at it through
# hermes-webhook-sync.service (see its ExecStartPost) -- running both at once would mean two
# competing tunnels, so this one stops right before the persistent one takes over.
node src/provisioning-webhook/tunnel-lifecycle.mjs stop || true

# Renders ops/systemd/*.in, enables lingering (so the user manager exists even with nobody
# logged in) and starts the hermes-webhook.target chain: preflight -> tunnel -> webhook-sync
# -> receiver. Everything from here on survives a reboot with no terminal ever open. See
# ops/README.md for the full chain and why each dependency is the way it is.
ops/preflight.sh || die "preflight failed, see above"
ops/install-systemd.sh || die "could not install the systemd units"
sudo loginctl enable-linger "$USER"
systemctl --user enable --now hermes-webhook.target

TRIGGER="$(node src/review/config.mjs get trigger 2>/dev/null || true)"
TRIGGER="${TRIGGER:-/review}"

cat <<EOF

  Ready.

  Receiver  127.0.0.1:$WEBHOOK_PORT, managed by systemd --user (hermes-webhook.target)
  Repos     node src/provisioning-webhook/sync-repos.mjs list
  Status    systemctl --user status hermes-receiver
  Logs      journalctl --user -u hermes-receiver -f

  Comment $TRIGGER on a pull request or merge request of a registered repository. This
  survives reboots on its own; there is nothing left to keep open or restart by hand.

  To register another repository later: REPO=owner/name node src/provisioning-webhook/sync-repos.mjs add \$REPO
  (GitLab: node src/provisioning-webhook/sync-repos.mjs add gitlab@host:group/project, GITLAB_TOKEN__<HOST> in .env by hand)

  To stop everything: systemctl --user disable --now hermes-webhook.target

EOF

# Idempotent: re-running ./setup.sh after these lines already landed must not duplicate them.
add_alias() {
  local name="$1" cmd="$2"
  grep -qxF "alias $name='$cmd'" ~/.bashrc 2>/dev/null || echo "alias $name='$cmd'" >> ~/.bashrc
}
add_alias lr "node $PWD/src/provisioning-webhook/sync-repos.mjs list"
add_alias herstat "systemctl --user list-units 'hermes-*' --all"
add_alias vpr "node $PWD/src/provisioning-webhook/review-status.mjs"
source ~/.bashrc
