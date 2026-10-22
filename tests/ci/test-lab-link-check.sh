#!/bin/bash
# The Lab link in a PR body must serve a page.
#
# Seven PR Lab links were reported as 404 on 2026-10-22. The PR Playground gate
# checked that docs/<branch-slug>/ held an .html and that the PR body contained
# the word "playground", but never that the /lab/<slug>.html URL in the body is
# a page the merge publishes; and a PR the gate exempts (test-only, inert) got
# no check at all, so #4739 merged a link to a page that was never pushed.
# scripts/ci/lab-link-check.sh closes both: every Lab link must be published by
# the tree under test, and LAB_LIVE=1 also requires a live 200.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CHECK="$PROJECT_ROOT/scripts/ci/lab-link-check.sh"
WORKFLOW="$PROJECT_ROOT/.github/workflows/ci.yml"

PASS=0; FAIL=0
log_pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
log_fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/lab-link-check.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# A fixture tree that publishes exactly one page, "live-page".
TREE="$TMP/tree"
mkdir -p "$TREE/docs/site/lab-manifest" "$TREE/docs/site/public/lab"
printf '{"slug": "live-page", "source": "docs/x--y/index.html"}\n' > "$TREE/docs/site/lab-manifest/live-page.json"
printf '<!DOCTYPE html>\n' > "$TREE/docs/site/public/lab/live-page.html"
# A fragment whose generated copy was never built: not published either.
printf '{"slug": "unbuilt", "source": "docs/x--z/index.html"}\n' > "$TREE/docs/site/lab-manifest/unbuilt.json"

# run <label> <expected-exit> <require> <body> [extra env...]
run() {
  local label="$1" want="$2" require="$3" body="$4"; shift 4
  printf '%s' "$body" > "$TMP/body.md"
  local rc=0
  if [ ! -f "$CHECK" ]; then
    log_fail "$label (missing $CHECK)"
    return
  fi
  env LAB_TREE="$TREE" LAB_REQUIRE_LINK="$require" "$@" bash "$CHECK" "$TMP/body.md" > "$TMP/out.txt" 2>&1 || rc=$?
  if [ "$rc" -eq "$want" ]; then log_pass "$label"; else log_fail "$label (exit $rc, want $want): $(tr '\n' ' ' < "$TMP/out.txt" | cut -c1-200)"; fi
}

echo "=== Lab link check ==="

run "a link the tree publishes passes" 0 true \
  "## Interactive Playground
Lab: https://orchestkit.dev/lab/live-page.html"
run "the old host still counts as a Lab link" 0 true \
  "Lab: https://orchestkit.yonyon.ai/lab/live-page.html"
run "a link to a page the tree does not publish fails" 1 true \
  "Lab: https://orchestkit.dev/lab/never-pushed.html"
run "a fragment without its generated copy is not published" 1 true \
  "Lab: https://orchestkit.dev/lab/unbuilt.html"
run "a Lab link without .html fails (that path 404s)" 1 true \
  "Lab: https://orchestkit.dev/lab/live-page"
run "an exempt PR with a dead Lab link still fails (the #4739 hole)" 1 false \
  "Lab: https://orchestkit.yonyon.ai/lab/teammate-key-boundary-4714.html"
run "an exempt PR with no Lab link passes" 0 false \
  "Test-only change, no playground."
run "a required PR with no Lab link fails" 1 true \
  "## Interactive Playground
The page is docs/x--y/index.html."
run "one dead link among good ones fails" 1 true \
  "https://orchestkit.dev/lab/live-page.html and https://orchestkit.dev/lab/gone.html"

# LAB_LIVE=1: the published page must also answer 200 now. LAB_STATUS_CMD stubs
# the HTTP probe so this test makes no network call.
run "live mode passes on 200" 0 true \
  "https://orchestkit.dev/lab/live-page.html" LAB_LIVE=1 LAB_STATUS_CMD="echo 200"
run "live mode fails on 404 even when the tree publishes the page" 1 true \
  "https://orchestkit.dev/lab/live-page.html" LAB_LIVE=1 LAB_STATUS_CMD="echo 404"
run "live mode fails when the probe cannot run (never a silent pass)" 1 true \
  "https://orchestkit.dev/lab/live-page.html" LAB_LIVE=1 LAB_STATUS_CMD="false"

echo "=== Wiring ==="
if awk '/lab-link-check\.sh/{n++} END{exit n>0?0:1}' "$WORKFLOW"; then
  log_pass "ci.yml runs scripts/ci/lab-link-check.sh"
else
  log_fail "ci.yml does not run scripts/ci/lab-link-check.sh"
fi
# The link step must not hide behind the gate decision: an exempt PR's link is checked too.
awk '/name: Check the PR body Lab links/{f=1} f{print} f&&/^      - name:/&&!/Lab links/{exit}' "$WORKFLOW" > "$TMP/step.txt"
if [ -s "$TMP/step.txt" ] && ! grep -q "steps.gate.outputs.required == 'true'" "$TMP/step.txt"; then
  log_pass "the Lab link step runs for every PR, exempt ones included"
else
  log_fail "the Lab link step is missing or only runs when a playground is required"
fi

LIVE_WF="$PROJECT_ROOT/.github/workflows/lab-links-live.yml"
if [ -f "$LIVE_WF" ] && awk '/LAB_LIVE=1/{a=1} /merged == true/{b=1} END{exit (a&&b)?0:1}' "$LIVE_WF"; then
  log_pass "a merged PR's Lab links must answer 200 after the deploy (lab-links-live.yml)"
else
  log_fail "no post-merge 200 check (.github/workflows/lab-links-live.yml with LAB_LIVE=1 on merged PRs)"
fi

echo "=== Backfill ==="
# #4739 merged a body link to a page that was never pushed; main must publish it now.
if [ -f "$PROJECT_ROOT/docs/site/lab-manifest/teammate-key-boundary-4714.json" ] && [ -f "$PROJECT_ROOT/docs/site/public/lab/teammate-key-boundary-4714.html" ]; then
  log_pass "#4739's Lab page is published"
else
  log_fail "#4739's Lab page (teammate-key-boundary-4714) is not published"
fi

echo
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
