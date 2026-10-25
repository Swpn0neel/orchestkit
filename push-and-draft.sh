#!/usr/bin/env bash
# push-and-draft.sh: push the ork-triage-sweep fix branches and open one DRAFT
# PR per branch against main. Written by the ork-triage-sweep lane, which
# cannot push (the yonatan-hq-ops app is read-only on orchestkit). Run it in
# the operator's own shell.
#
# Idempotent: a branch already on origin at the same sha is not pushed again,
# and a branch that already has an open PR gets no second PR. It prints the
# plan and asks y/n once. It never merges, never marks ready, never closes.
# PR bodies: ~/.claude/hq/ork-triage-sweep/prs/<branch with / as -->.md
set -euo pipefail

REPO="yonatangross/orchestkit"
BODIES="$HOME/.claude/hq/ork-triage-sweep/prs"
cd "$(dirname "${BASH_SOURCE[0]}")"

BRANCHES=(
  "fix/4297-jev-route-labels"
  "fix/4496-docs-workflow-inputs"
  "fix/4520-expect-browser-session"
  "fix/4539-router-context-guard"
)
SHAS=(dd8397a16 421eda771 9baab4cec 349e3fa7c)
TITLES=(
  "fix(jev): check route labels by row kind, require real outcomes"
  "fix(ci): run the docs build for all its inputs, honour cancels"
  "fix(expect): drive a named browser session, never close all"
  "test(skills): fail when a front-door router skill forks"
)

body_file() { printf '%s/%s.md' "$BODIES" "${1//\//--}"; }

echo "Plan (repo $REPO, base main, all PRs DRAFT):"
for i in "${!BRANCHES[@]}"; do
  branch="${BRANCHES[$i]}"; sha="${SHAS[$i]}"
  local_sha=$(git rev-parse --verify --quiet --short=9 "refs/heads/$branch" || echo MISSING)
  printf '  %-34s local %s (expect %s)  %s\n' "$branch" "$local_sha" "$sha" "${TITLES[$i]}"
  if [[ "$local_sha" != "$sha"* ]]; then
    echo "ABORT: $branch is at $local_sha, not $sha. The lane's commit moved; ask the lane." >&2
    exit 1
  fi
  if [[ ! -s "$(body_file "$branch")" ]]; then
    echo "ABORT: PR body missing: $(body_file "$branch")" >&2
    exit 1
  fi
done

read -r -p "Push these branches and open the draft PRs? [y/N] " answer
if [[ "$answer" != "y" && "$answer" != "Y" ]]; then
  echo "Nothing done."
  exit 0
fi

for i in "${!BRANCHES[@]}"; do
  branch="${BRANCHES[$i]}"; sha="${SHAS[$i]}"
  remote_sha=$(git ls-remote origin "refs/heads/$branch" | cut -c1-9)
  if [[ -n "$remote_sha" && "$remote_sha" == "$sha"* ]]; then
    echo "= $branch already on origin at $remote_sha"
  else
    git push origin "refs/heads/$branch:refs/heads/$branch"
  fi
  existing=$(gh pr list -R "$REPO" --head "$branch" --state open --json url --jq '.[0].url // ""')
  if [[ -n "$existing" ]]; then
    echo "= PR exists: $existing"
  else
    gh pr create -R "$REPO" --draft --base main --head "$branch" \
      --title "${TITLES[$i]}" --body-file "$(body_file "$branch")"
  fi
done
echo "Done. Draft PRs only: nothing merged, marked ready or closed."
