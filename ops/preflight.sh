#!/usr/bin/env bash
#
# Everything that has to be true before the receiver may accept a single delivery.
#
# The failure this exists to prevent is the quiet one. A revoked token, a hermes that was
# never configured, a claude that was never logged in: none of them stop the receiver from
# starting and listening. They stop the *first review*, at three in the morning, as a
# comment that never gets an answer. This runs first, refuses to let the rest of the chain
# start, and says exactly which thing is wrong.
#
# Runs standalone too:  ops/preflight.sh
# Exit 0 means the whole mode is ready to serve. Any other exit means it is not.

set -uo pipefail

# shellcheck source=ops/lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

# Only the GitHub call is retried. Every other check is about local state that will not
# fix itself, so failing fast on those keeps the message honest. At boot the network may
# still be coming up, and that one *does* fix itself.
API_RETRIES="${PREFLIGHT_API_RETRIES:-6}"
API_RETRY_DELAY="${PREFLIGHT_API_RETRY_DELAY:-10}"

# github-provision.mjs and github-webhook.mjs call the global fetch(), which arrived in 18.
# Everything here is ESM on top of that.
NODE_MIN_MAJOR="${NODE_MIN_MAJOR:-18}"

failures=0

fail() {
  printf 'FAIL  %s\n' "$1" >&2
  shift
  for line in "$@"; do printf '      %s\n' "$line" >&2; done
  failures=$((failures + 1))
}

pass() {
  printf 'ok    %s\n' "$*"
}

printf 'preflight for %s\n' "$PR_REVIEW_ROOT"

# ---------------------------------------------------------------------------- binaries
#
# systemd does not read .bashrc, .profile or nvm's shell hook, so a binary that works in
# an interactive shell can be absent here. That is the single most common way this mode
# dies on a fresh machine, which is why it is checked first and why ops/install-systemd.sh
# bakes the resolved directories into PATH= in the unit files.
#
# node, cloudflared, hermes and claude are the four the mode cannot run without.
# git and gh are in the list because src/review/review.sh drives both: without them a
# review starts, does its work and then fails at the point where it would have posted.
for bin in node cloudflared hermes claude git gh; do
  if resolved=$(command -v "$bin" 2>/dev/null); then
    pass "$bin -> $resolved"
  else
    fail "$bin is not on PATH" \
      "PATH=$PATH" \
      "Under systemd this is the PATH= line in the unit file. Re-run ops/install-systemd.sh" \
      "from a shell where '$bin' works, it copies the directory it resolves to."
  fi
done

# ------------------------------------------------------------------------ node version
#
# "node is on PATH" is not the check that matters. A distro node is very often on PATH and
# very often ancient -- Ubuntu 22.04 ships v12 in /usr/bin, Amazon Linux 2 ships v10 -- and
# because /usr/bin comes before ~/.nvm in most PATHs, *that* is the node a service gets even
# on a machine where `node -v` in your shell says 22.
#
# Without this check the symptom is a SyntaxError from deep inside an unrelated check, or
# `fetch is not defined` at the first GitHub call in the middle of a review. Checked here,
# once, in one sentence.
node_ok=0
if command -v node >/dev/null 2>&1; then
  node_version=$(node -v 2>/dev/null | tr -d '\r')
  node_major="${node_version#v}"
  node_major="${node_major%%.*}"
  case "$node_major" in
    '' | *[!0-9]*)
      fail "could not read a version out of 'node -v' (got '${node_version:-<nothing>}')"
      ;;
    *)
      if [ "$node_major" -lt "$NODE_MIN_MAJOR" ]; then
        fail "node is $node_version, this needs $NODE_MIN_MAJOR or newer" \
          "$(command -v node) is the one that will be used, and it is too old: global fetch()" \
          "landed in 18 and every module here is ESM." \
          "If a newer node is installed (nvm, fnm, a tarball), its directory has to come" \
          "BEFORE $(dirname "$(command -v node)") in the unit's PATH=. Re-run" \
          "ops/install-systemd.sh from a shell where 'node -v' already says $NODE_MIN_MAJOR+."
      else
        node_ok=1
        pass "node $node_version"
      fi
      ;;
  esac
fi

# --------------------------------------------------------- HERMES_HOME is not ours to set
#
# A trap worth a check of its own. HERMES_HOME is the hermes CLI's *own* config directory
# (~/.hermes by default). Anything that exports it -- a well-meaning unit file naming the
# checkout, a line in a profile -- silently repoints hermes at a directory with no config in
# it. `hermes config get model.provider` then answers "Config key not set", every review
# starts with no provider and no model, and nothing anywhere says why.
#
# This is why the unit files export PR_REVIEW_ROOT and never HERMES_HOME.
if [ -n "${HERMES_HOME:-}" ] && [ "$HERMES_HOME" != "$HOME/.hermes" ]; then
  fail "HERMES_HOME is set to '$HERMES_HOME'" \
    "That variable belongs to the hermes CLI: it is where hermes keeps its own config," \
    "normally $HOME/.hermes. Pointed anywhere else, hermes starts with no provider and no" \
    "model and every review fails at the first call. Unset it, or set it to a real hermes" \
    "config directory. It is not the path to this checkout -- that one is PR_REVIEW_ROOT."
fi

# ------------------------------------------------------------------------ hermes config
#
# Both the exit code and the value are inspected. `hermes config get` exits non-zero and
# writes "Config key not set" to *stderr* when the key is missing, so a check on stdout
# alone would read as an empty string and a check on the exit code alone would miss a
# configured-but-blank value. An unconfigured provider means dispatch.mjs launches hermes
# and hermes has nothing to talk to.
if command -v hermes >/dev/null 2>&1; then
  hermes_err=$(mktemp)
  if provider=$(hermes config get model.provider 2>"$hermes_err"); then
    provider=$(printf '%s' "$provider" | tr -d '\r' | head -n 1)
    provider="${provider#"${provider%%[![:space:]]*}"}"
    provider="${provider%"${provider##*[![:space:]]}"}"
  else
    provider=''
  fi
  hermes_reason=$(head -n 2 "$hermes_err" | tr '\n' ' ')
  rm -f "$hermes_err"

  case "$provider" in
    '' | null | undefined | None)
      fail "hermes has no usable model.provider${hermes_reason:+ ($hermes_reason)}" \
        "Configure it once, by hand, as the user this service runs as:" \
        "  hermes config set model.provider <provider>" \
        "  hermes config set model.name <model>" \
        "This cannot be automated: it depends on which account you are paying for." \
        "If it *is* configured for you interactively but fails here, the service is running" \
        "as another user, or HOME/HERMES_HOME differ from your shell's."
      ;;
    *)
      pass "hermes model.provider = $provider"
      ;;
  esac
fi

# ------------------------------------------------------------------- claude credentials
#
# claude reads this file at startup; there is no headless login. If it is missing the very
# first review opens a browser prompt on a machine with no browser and hangs until the
# forty minute timeout in dispatch.mjs kills it.
claude_creds="${CLAUDE_CREDENTIALS_FILE:-$HOME/.claude/.credentials.json}"
if [ -s "$claude_creds" ]; then
  pass "claude credentials at $claude_creds"
elif [ -e "$claude_creds" ]; then
  fail "$claude_creds exists but is empty" "Run 'claude' once as this user and log in again."
else
  fail "$claude_creds is missing (claude is not logged in)" \
    "Run 'claude' once, interactively, as the user this service runs as, and log in." \
    "There is no way to do this from a unit file: it is an interactive login."
fi

# -------------------------------------------------------------------------------- .env
if [ -f "$ENV_FILE" ]; then
  pass ".env at $ENV_FILE"
  for key in GITHUB_TOKEN WEBHOOK_MULTI_SECRET WEBHOOK_PORT; do
    value=$(env_value "$key" 2>/dev/null || true)
    if [ -n "$value" ]; then
      pass "$key is set"
    else
      fail "$key is empty or missing in $ENV_FILE" \
        "The receiver exits immediately without it, and sync-repos.mjs cannot sign a hook."
    fi
  done

  port=$(env_value WEBHOOK_PORT 2>/dev/null || true)
  case "$port" in
    '' ) ;; # already reported above
    *[!0-9]* | 0)
      fail "WEBHOOK_PORT is not a port number (got '$port')"
      ;;
    *)
      [ "$port" -le 65535 ] || fail "WEBHOOK_PORT is out of range (got '$port')"
      ;;
  esac
else
  fail "$ENV_FILE does not exist" \
    "It holds GITHUB_TOKEN, WEBHOOK_MULTI_SECRET and WEBHOOK_PORT." \
    "It is gitignored on purpose: create it on the instance, mode 600, and never commit it."
fi

# --------------------------------------------------------------------------- .runtime.env
#
# review.sh sources this file with `set -a`, so the REPO it pins wins over the one the
# receiver hands each child. In the single-repo demo that is the whole point. Here it would
# send every review of every repository to one repository, silently, on every delivery.
# setup.sh writes it and deletes it on exit; one that survived is a crashed setup.sh.
# The receiver refuses to start on it too. This is the same refusal, one step earlier.
runtime_env="$PR_REVIEW_ROOT/.runtime.env"
if [ -e "$runtime_env" ]; then
  fail "$runtime_env exists and would pin REPO for every review" \
    "It belongs to setup.sh (the single-repo demo), which deletes it when it exits." \
    "A leftover one means setup.sh was killed. Check nothing else needs it, then:" \
    "  rm $runtime_env"
else
  pass "no stale .runtime.env"
fi

# ------------------------------------------------------------------------------ repos.yml
#
# Parsed by the registry module rather than by grep, so an entry this accepts is exactly an
# entry the receiver will accept. A receiver with zero active repositories starts, listens,
# answers 'ignored' to everything and looks perfectly healthy.
repos_file="${REPOS_FILE:-$PR_REVIEW_ROOT/repos.yml}"
if [ -f "$repos_file" ] && [ "$node_ok" = 1 ]; then
  # REGISTRY_MODULE is passed through the environment, not argv: registry.mjs has a CLI
  # guard on process.argv[1] and would print its own dump on top of ours.
  active=$(
    REGISTRY_MODULE="$PR_REVIEW_ROOT/src/provisioning/registry.mjs" \
      node --input-type=module -e '
        const { read } = await import(process.env.REGISTRY_MODULE)
        const active = read().filter((entry) => entry.status === "active")
        console.log(active.map((entry) => `${entry.owner}/${entry.name}`).join(" "))
      ' 2>&1
  )
  status=$?
  if [ $status -ne 0 ]; then
    fail "$repos_file could not be parsed" "$active"
  elif [ -z "$active" ]; then
    fail "$repos_file has no repository with status 'active'" \
      "The receiver would start and ignore every delivery it gets. Register one with:" \
      "  node src/provisioning-webhook/sync-repos.mjs add <owner>/<name>"
  else
    pass "repos.yml active: $active"
  fi
elif [ ! -f "$repos_file" ]; then
  fail "$repos_file does not exist" \
    "Create it by registering a repository:" \
    "  node src/provisioning-webhook/sync-repos.mjs add <owner>/<name>"
fi

# ------------------------------------------------------------------------- GitHub token
#
# GET /user is the cheapest call that distinguishes the three states that matter: valid,
# revoked/expired (401), and the network is not up yet (no response at all). Only the last
# one is worth retrying, and at boot it is the likely one.
#
# The token is read here and handed to node through the environment. It is never echoed,
# never put on a command line where ps would show it, and never written to the journal.
if [ "$node_ok" = 1 ] && [ -f "$ENV_FILE" ]; then
  token=$(env_value GITHUB_TOKEN 2>/dev/null || true)
  if [ -n "$token" ]; then
    attempt=1
    result=''
    while :; do
      result=$(
        GITHUB_TOKEN="$token" node --input-type=module -e '
          const api = process.env.GITHUB_API ?? "https://api.github.com"
          try {
            const response = await fetch(`${api}/user`, {
              headers: {
                authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
                accept: "application/vnd.github+json",
                "x-github-api-version": "2022-11-28",
              },
            })
            if (response.status === 401 || response.status === 403) {
              console.log(`DEAD ${response.status}`)
              process.exit(0)
            }
            if (!response.ok) {
              console.log(`UNREACHABLE http ${response.status}`)
              process.exit(0)
            }
            const user = await response.json()
            console.log(`LIVE ${user.login ?? "?"} scopes=${response.headers.get("x-oauth-scopes") ?? "fine-grained"}`)
          } catch (error) {
            console.log(`UNREACHABLE ${error.message}`)
          }
        ' 2>&1 | tr '\n' ' '
      )
      case "$result" in
        LIVE*)
          pass "GitHub token ${result#LIVE }"
          case "$result" in
            *fine-grained*) ;;
            *repo*) ;;
            *)
              printf 'warn  the token has no "repo" scope; creating webhooks will fail\n' >&2
              ;;
          esac
          break
          ;;
        DEAD*)
          fail "the GITHUB_TOKEN in $ENV_FILE is refused by GitHub (${result#DEAD })" \
            "It is expired, revoked, or was never granted access. Mint a new PAT with the" \
            "'repo' scope (or a fine-grained token with Administration + Webhooks read/write" \
            "on the registered repositories) and replace GITHUB_TOKEN in $ENV_FILE."
          break
          ;;
        *)
          if [ "$attempt" -ge "$API_RETRIES" ]; then
            fail "could not reach the GitHub API after $attempt attempts (${result#UNREACHABLE })" \
              "The token may well be fine; the network is not. Nothing downstream can work" \
              "without api.github.com, so the chain stops here."
            break
          fi
          printf 'wait  GitHub API unreachable (%s), retry %s/%s in %ss\n' \
            "${result#UNREACHABLE }" "$attempt" "$API_RETRIES" "$API_RETRY_DELAY" >&2
          sleep "$API_RETRY_DELAY"
          attempt=$((attempt + 1))
          ;;
      esac
    done
  fi
fi

# --------------------------------------------------------------------------------- verdict
if [ "$failures" -gt 0 ]; then
  printf '\npreflight failed: %s check(s) did not pass. Nothing else will be started.\n' "$failures" >&2
  exit 1
fi

printf '\npreflight passed\n'
