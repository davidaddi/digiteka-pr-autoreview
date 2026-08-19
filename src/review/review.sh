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
: "${GITHUB_TOKEN:?GITHUB_TOKEN is not set}"

MODEL="$(node src/review/config.mjs get model)"
AGENTS="$(node src/review/config.mjs get agents)"
BLOCKING="$(node src/review/config.mjs get paths.blocking)"
MAX_FINDINGS="$(node src/review/config.mjs get max_findings)"
SKEPTICS="$(node src/review/config.mjs get skeptics)"

SANDBOX="$PWD"
DIFF="$PWD/.pr.diff"
FINDINGS="$PWD/.findings.json"
RUN="$PWD/.run.json"

gh pr diff "$PR" --repo "$REPO" > "$DIFF"
[ -s "$DIFF" ] || { echo "empty diff for #$PR, refusing to review nothing" >&2; exit 1; }

run_claude() {
  claude -p "$1" --agent "$2" --model "$MODEL" --permission-mode bypassPermissions
}

checkout_pr() {
  BRANCH="$(gh pr view "$PR" --repo "$REPO" --json headRefName -q .headRefName)"
  WORK="$SANDBOX/.work/$(echo "$REPO" | tr / -)"

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
    run_claude "Review pull request #$PR of $REPO. The unified diff is already at $DIFF.
Fan out the finders [$AGENTS] over it, send every candidate finding to $SKEPTICS skeptic(s),
then have the judge dedup and rank what survives. Files matching '$BLOCKING' are blocking,
everything else is advisory. Keep at most $MAX_FINDINGS findings.
Write the final JSON array to $FINDINGS and nothing else to that file." orchestrator
    [ -s "$FINDINGS" ] || { echo "the review produced no findings file" >&2; exit 1; }
    printf '%s\n%s\n' "$MODEL" "$(( $(date +%s) - STARTED ))" > "$SANDBOX/.run.meta"
    ;;

  fix)
    checkout_pr
    run_claude "Apply the fix for pull request #$PR of $REPO, in this working copy.
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
