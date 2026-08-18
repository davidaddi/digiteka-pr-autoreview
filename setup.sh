#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

RECEIVER_PID=""
TUNNEL_PID=""
HOOK_ID=""
TUNNEL_LOG="$(mktemp)"
PORT="${PORT:-8787}"

info() { printf '  %s\n' "$*"; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die()  { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

cleanup() {
  printf '\n'
  [ -n "$HOOK_ID" ] && gh api -X DELETE "repos/$REPO/hooks/$HOOK_ID" --silent 2>/dev/null && info "webhook removed"
  [ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" 2>/dev/null
  [ -n "$RECEIVER_PID" ] && kill "$RECEIVER_PID" 2>/dev/null
  rm -f "$TUNNEL_LOG" .runtime.env
  info "sandbox stopped, nothing left running"
}
trap cleanup EXIT INT TERM

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

gh auth status >/dev/null 2>&1 || die "Run: gh auth login"

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

step "2. Which repository"

REPO="${REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)}"
[ -n "$REPO" ] || die "Set REPO=owner/name, or run this inside a cloned repository."
info "$REPO"

GITHUB_TOKEN="$(gh auth token)"
WEBHOOK_SECRET="$(head -c 32 /dev/urandom | base64)"
export REPO GITHUB_TOKEN WEBHOOK_SECRET PORT SANDBOX_ROOT="$PWD"
export HERMES_STREAM_READ_TIMEOUT="${HERMES_STREAM_READ_TIMEOUT:-1800}"

(
  umask 077
  cat > .runtime.env <<EOF
REPO="$REPO"
GITHUB_TOKEN="$GITHUB_TOKEN"
GH_TOKEN="$GITHUB_TOKEN"
PATH="$PATH"
EOF
)

step "3. Starting the receiver"

if command -v lsof >/dev/null 2>&1; then
  busy="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
else
  busy="$(ss -lntp 2>/dev/null | grep -oE "pid=[0-9]+" | head -1 | cut -d= -f2 || true)"
  ss -lnt 2>/dev/null | grep -q ":$PORT " || busy=""
fi
[ -z "$busy" ] || die "Port $PORT is already taken by pid $busy. Stop it, or run with PORT=<other>."

node src/review/receiver.mjs &
RECEIVER_PID=$!
sleep 1
kill -0 "$RECEIVER_PID" 2>/dev/null || die "The receiver did not start."
info "listening on 127.0.0.1:$PORT"

step "4. Opening a tunnel"

cloudflared tunnel --protocol http2 --url "http://127.0.0.1:$PORT" > "$TUNNEL_LOG" 2>&1 &
TUNNEL_PID=$!

PUBLIC_URL=""
for _ in $(seq 1 30); do
  PUBLIC_URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" | head -1 || true)"
  [ -n "$PUBLIC_URL" ] && break
  sleep 1
done
[ -n "$PUBLIC_URL" ] || die "The tunnel never came up. See $TUNNEL_LOG"
info "$PUBLIC_URL"

step "5. Pointing GitHub at it"

HOOK_ID="$(gh api "repos/$REPO/hooks" -X POST \
  -f name=web \
  -F active=true \
  -f 'events[]=issue_comment' \
  -f "config[url]=$PUBLIC_URL" \
  -f 'config[content_type]=json' \
  -f "config[secret]=$WEBHOOK_SECRET" \
  -q .id)"
info "webhook $HOOK_ID, removed automatically when you stop this script"

delivered=""
for _ in $(seq 1 40); do
  if gh api "repos/$REPO/hooks/$HOOK_ID/deliveries" -q '.[] | select(.event == "ping") | .status_code' 2>/dev/null | grep -q '^2'; then
    delivered=1
    break
  fi
  sleep 5
done

if [ -n "$delivered" ]; then
  info "GitHub reached it"
else
  info "no ping confirmation yet, starting anyway. If nothing happens when you comment,"
  info "look at the webhook deliveries on GitHub and at $TUNNEL_LOG"
fi

step "6. Demo pull request"

if [ -n "${SKIP_DEMO:-}" ]; then
  PR="$(gh pr list --repo "$REPO" --state open --json number -q '.[0].number' 2>/dev/null || true)"
  [ -n "$PR" ] || die "SKIP_DEMO is set but $REPO has no open pull request to review."
  info "skipped, will watch the open pull requests of $REPO"
elif gh pr list --repo "$REPO" --head demo/checkout --json number -q '.[0].number' | grep -q .; then
  PR="$(gh pr list --repo "$REPO" --head demo/checkout --json number -q '.[0].number')"
  info "already open: #$PR"
else
  git checkout -q -b demo/checkout
  cp demo/.seed/cart.js demo/cart.js
  git add demo/cart.js
  git commit -qm "feat(checkout): apply discount and log the order"
  git push -q -u origin demo/checkout
  gh pr create --repo "$REPO" --head demo/checkout --base main \
    --title "feat(checkout): apply discount and log the order" \
    --body "Three problems are hiding in here. Comment /review and see which ones come back." >/dev/null
  PR="$(gh pr list --repo "$REPO" --head demo/checkout --json number -q '.[0].number')"
  git checkout -q -
  [ -n "$PR" ] || die "The demo pull request was created but its number could not be read."
  info "opened #$PR"
fi

TRIGGER="$(node src/review/config.mjs get trigger)"

cat <<EOF

  Ready.

  Go to https://github.com/$REPO/pull/$PR and comment:  $TRIGGER

  Hermes takes it from there. Leave this terminal open.
  Ctrl-C removes the webhook and stops everything.

EOF

wait "$RECEIVER_PID"
