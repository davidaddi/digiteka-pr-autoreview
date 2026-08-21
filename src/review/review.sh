#!/usr/bin/env bash
set -euo pipefail

PR="${1:?usage: review.sh <pr> [review|fix|revert] [target]}"
ACTION="${2:-review}"
TARGET="${3:-}"

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

RUNTIME_ENV_FILE="${RUNTIME_ENV_FILE:-.runtime.env}"
if [ -f "$RUNTIME_ENV_FILE" ]; then
  set -a
  . "$RUNTIME_ENV_FILE"
  set +a
fi
: "${REPO:?REPO is not set}"

# Unset means github: this script predates the second forge and is still called without it.
PROVIDER="${REPO_PROVIDER:-github}"
REQUEST="pull request"
if [ "$PROVIDER" = gitlab ]; then
  : "${GITLAB_TOKEN:?GITLAB_TOKEN is not set}"
  : "${REPO_HOST:?REPO_HOST is not set}"
  REQUEST="merge request"
else
  : "${GITHUB_TOKEN:?GITHUB_TOKEN is not set}"
fi

MODEL="$(node src/review/config.mjs get model)"
AGENTS="$(node src/review/config.mjs get agents)"
BLOCKING="$(node src/review/config.mjs get paths.blocking)"
MAX_FINDINGS="$(node src/review/config.mjs get max_findings)"
SKEPTICS="$(node src/review/config.mjs get skeptics)"

SANDBOX="$PWD"
mkdir -p "$SANDBOX/runs"
DIFF="$SANDBOX/runs/.pr.diff"
FINDINGS="$SANDBOX/runs/.findings.json"
RUN="$SANDBOX/runs/.run.json"

if [ "$PROVIDER" = gitlab ]; then
  node src/review/gitlab.mjs diff "$PR" > "$DIFF"
else
  gh pr diff "$PR" --repo "$REPO" > "$DIFF"
fi
[ -s "$DIFF" ] || { echo "empty diff for #$PR, refusing to review nothing" >&2; exit 1; }

run_claude() {
  claude -p "$1" --agent "$2" --model "$MODEL" --permission-mode bypassPermissions
}

checkout_github() {
  BRANCH="$(gh pr view "$PR" --repo "$REPO" --json headRefName -q .headRefName)"

  if [ ! -d "$WORK/.git" ]; then
    mkdir -p "$(dirname "$WORK")"
    gh repo clone "$REPO" "$WORK" -- --quiet
  fi
  cd "$WORK"

  git config credential.helper '!gh auth git-credential'
  git config user.name "${GIT_AUTHOR_NAME:-hermes-review}"
  git config user.email "${GIT_AUTHOR_EMAIL:-hermes-review@users.noreply.github.com}"

  git fetch origin --quiet "pull/$PR/head"
  git checkout -q -B "$BRANCH" FETCH_HEAD
}

# No credential helper and no token in the remote url: the token travels as a header on the
# commands that need the network, and never lands in .git/config where the next run, or the
# agent, or a `git remote -v` would find it.
checkout_gitlab() {
  BRANCH="$(node src/review/gitlab.mjs branch "$PR")"

  if [ ! -d "$WORK/.git" ]; then
    mkdir -p "$(dirname "$WORK")"
    git -c http.extraHeader="PRIVATE-TOKEN: $GITLAB_TOKEN" clone --quiet "https://$REPO_HOST/$REPO.git" "$WORK"
  fi
  cd "$WORK"

  git config user.name "${GIT_AUTHOR_NAME:-hermes-review}"
  git config user.email "${GIT_AUTHOR_EMAIL:-hermes-review@$REPO_HOST}"

  # refs/merge-requests/N/head is GitLab's equivalent of GitHub's pull/N/head, but it is not
  # always reachable: some self-hosted setups and some token scopes do not expose it. The
  # source branch always is, and it is the same commit unless the merge request was rebased
  # between the two calls.
  if git -c http.extraHeader="PRIVATE-TOKEN: $GITLAB_TOKEN" fetch origin --quiet "refs/merge-requests/$PR/head"; then
    git checkout -q -B "$BRANCH" FETCH_HEAD
  else
    echo "refs/merge-requests/$PR/head is not fetchable, falling back to $BRANCH" >&2
    git -c http.extraHeader="PRIVATE-TOKEN: $GITLAB_TOKEN" fetch origin --quiet "$BRANCH"
    git checkout -q -B "$BRANCH" FETCH_HEAD
  fi

  # The push at the end of /fix is run by the agent, in its own shell, so the header has to
  # reach git through the environment rather than through a flag this script controls.
  # GIT_CONFIG_COUNT applies it to every git command from here on without writing it down.
  export GIT_CONFIG_COUNT=1
  export GIT_CONFIG_KEY_0=http.extraHeader
  export GIT_CONFIG_VALUE_0="PRIVATE-TOKEN: $GITLAB_TOKEN"
}

checkout_pr() {
  WORK="$SANDBOX/.work/$(echo "$REPO" | tr / -)"

  if [ "$PROVIDER" = gitlab ]; then
    checkout_gitlab
  else
    checkout_github
  fi

  mkdir -p .claude
  cp -R "$SANDBOX/.claude/agents" .claude/
  grep -qx '.claude/' .git/info/exclude 2>/dev/null || echo '.claude/' >> .git/info/exclude
}

case "$ACTION" in
  review)
    rm -f "$FINDINGS" "$RUN"
    STARTED=$(date +%s)
    run_claude() {
      claude -p "$1" --agent "$2" --model "$MODEL" --permission-mode bypassPermissions \
        --output-format stream-json --verbose | tee "$RUN"
    }
    run_claude "Review $REQUEST #$PR of $REPO. The unified diff is already at $DIFF.
Fan out the finders [$AGENTS] over it, send every candidate finding to $SKEPTICS skeptic(s),
then have the judge dedup and rank what survives. Files matching '$BLOCKING' are blocking,
everything else is advisory. Keep at most $MAX_FINDINGS findings.
Write the final JSON array to $FINDINGS and nothing else to that file." orchestrator
    [ -s "$FINDINGS" ] || { echo "the review produced no findings file" >&2; exit 1; }
    printf '%s\n%s\n' "$MODEL" "$(( $(date +%s) - STARTED ))" > "$SANDBOX/runs/.run.meta"
    ;;

  fix)
    checkout_pr
    run_claude "Apply the fix for $REQUEST #$PR of $REPO, in this working copy.
The findings are at $FINDINGS${TARGET:+, and only finding $TARGET is in scope}.
Write the smallest correct change, run the project's tests, then commit onto $BRANCH with a
Hermes-Fix trailer and push it. Touch nothing unrelated. If the fix cannot be small, commit
nothing and say why." fixer
    ;;

  revert)
    checkout_pr
    LAST="$(git log --grep='Hermes-Fix' --format=%H -n 1)"
    [ -n "$LAST" ] || { echo "nothing to revert on #$PR"; exit 0; }
    git revert --no-edit "$LAST"
    git push --no-verify origin "HEAD:$BRANCH"
    ;;

  *)
    echo "unknown action: $ACTION" >&2
    exit 1
    ;;
esac
