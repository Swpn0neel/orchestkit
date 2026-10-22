#!/usr/bin/env bash
# Check that every Lab link in a PR body serves a page.
#
# Usage: lab-link-check.sh <body-file>
#
# A Lab link is https://orchestkit.dev/lab/<slug>.html (or the old
# orchestkit.yonyon.ai host, which redirects there). The site serves
# docs/site/public/lab/<slug>.html from main, generated from the fragment
# docs/site/lab-manifest/<slug>.json, so a link is good only when the tree
# under test carries both. The PR Playground gate used to check that a page
# existed under docs/<branch-slug>/ and that the body said "playground", never
# that the URL in the body was published, and a PR it exempted got no check at
# all: #4739 merged a link to a page that was never pushed (404).
#
# Env:
#   LAB_TREE          tree to check (default: the repo root)
#   LAB_REQUIRE_LINK  true: the body must carry at least one Lab link (the gate
#                     requires a playground for this PR); anything else: a body
#                     with no Lab link passes, but every link it has is checked
#   LAB_LIVE          1: also require each link to answer 200 now (run after
#                     the merge has deployed)
#   LAB_STATUS_CMD    command that prints the HTTP status of the URL given as
#                     its last argument (default: curl). Tests stub it.
#
# Exit 0 when every link is good; 1 otherwise, one ::error:: line per bad link.

set -euo pipefail

BODY_FILE="${1:-}"
if [ -z "$BODY_FILE" ] || [ ! -f "$BODY_FILE" ]; then
  echo "::error::lab-link-check: no PR body file given"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TREE="${LAB_TREE:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
REQUIRE="${LAB_REQUIRE_LINK:-false}"
LIVE="${LAB_LIVE:-0}"
# A function, not a "${LAB_STATUS_CMD:-curl ...}" default: the } in curl's
# %{http_code} would close that expansion early.
probe_status() {
  if [ -n "${LAB_STATUS_CMD:-}" ]; then
    $LAB_STATUS_CMD "$1"
  else
    curl -s -o /dev/null -w '%{http_code}' --max-time 20 -L "$1"
  fi
}

LINKS_FILE="$(mktemp "${TMPDIR:-/tmp}/lab-links.XXXXXX")"
trap 'rm -f "$LINKS_FILE"' EXIT

# Every Lab URL in the body, one per line, into a FILE: awk reads the whole
# body (no grep -q early exit, #603) and the loop below reads a file, not a
# here-string (#3348).
awk '{
  line = $0
  while (match(line, /https?:\/\/(orchestkit\.dev|orchestkit\.yonyon\.ai)\/lab\/[A-Za-z0-9._-]+/)) {
    print substr(line, RSTART, RLENGTH)
    line = substr(line, RSTART + RLENGTH)
  }
}' "$BODY_FILE" | sort -u > "$LINKS_FILE"

if [ ! -s "$LINKS_FILE" ]; then
  if [ "$REQUIRE" = "true" ]; then
    echo "::error::This PR needs a playground, and its body links no Lab page."
    echo "::error::Link it as https://orchestkit.dev/lab/<slug>.html, the slug of its docs/site/lab-manifest/<slug>.json."
    exit 1
  fi
  echo "::notice::No Lab link in the PR body; nothing to check."
  exit 0
fi

BAD=0
while IFS= read -r url; do
  [ -n "$url" ] || continue
  page="${url##*/lab/}"
  case "$page" in
    *.html) slug="${page%.html}" ;;
    *)
      echo "::error::Lab link without .html: ${url} (that path returns 404; link ${url}.html)"
      BAD=$((BAD + 1))
      continue
      ;;
  esac
  fragment="$TREE/docs/site/lab-manifest/${slug}.json"
  copy="$TREE/docs/site/public/lab/${slug}.html"
  if [ ! -f "$fragment" ]; then
    echo "::error::${url}: no docs/site/lab-manifest/${slug}.json, so the merge does not publish it (404)."
    BAD=$((BAD + 1))
    continue
  fi
  if [ ! -f "$copy" ]; then
    echo "::error::${url}: the fragment exists but docs/site/public/lab/${slug}.html was never generated; run npm run build and commit it."
    BAD=$((BAD + 1))
    continue
  fi
  if [ "$LIVE" = "1" ]; then
    # Probe the canonical host: the old one only redirects to it.
    live_url="https://orchestkit.dev/lab/${slug}.html"
    status_rc=0
    status="$(probe_status "$live_url")" || status_rc=$?
    status="${status%%[[:space:]]*}"
    if [ "$status_rc" -ne 0 ] || [ -z "$status" ]; then
      echo "::error::${live_url}: the status probe failed (exit ${status_rc}); could not confirm 200."
      BAD=$((BAD + 1))
      continue
    fi
    if [ "$status" != "200" ]; then
      echo "::error::${live_url}: returned ${status}, not 200."
      BAD=$((BAD + 1))
      continue
    fi
    echo "::notice::${live_url}: 200"
  else
    echo "::notice::${url}: published by this tree (${slug})"
  fi
done < "$LINKS_FILE"

if [ "$BAD" -gt 0 ]; then
  echo "::error::${BAD} Lab link(s) in the PR body do not serve a page."
  exit 1
fi
exit 0
