## Summary

Makes `main` ready for a GitHub merge queue, and documents the one thing that
still blocks turning it on. No repository setting, ruleset or branch protection
was changed by this PR.

`main` requires 18 status contexts. A merge queue only merges an entry when each
one reports success on the `merge_group` ref: a context that never reports stalls
the queue forever, and one that fails removes the entry. The 2026-08-03 audit in
 #3189 concluded all 18 were ready because their workflows carry a `merge_group`
trigger. That was necessary but not sufficient. Two of them would have failed
every queued entry.

```
  18 required contexts on main
  ├── 15  run on merge_group unchanged
  ├──  1  skipped by its own if:  (PR Playground, already correct)
  └──  2  FAILED every queued entry   <- fixed here
```

| context | what happens on `merge_group` | fix |
| --- | --- | --- |
| `Secret Scanning` | `gitleaks-action` v3.0.0 accepts only `push`, `pull_request`, `workflow_dispatch`, `schedule`, then calls `process.exit(1)` | skip on `merge_group`; the same commit was scanned on the PR, and the queue's push to `main` scans it again |
| `Check Version Bump & Changelog` | keyed on `github.head_ref`, empty for a queued entry, so a Dependabot or release-please PR is judged a feature branch and told to bump the version; the failure path also comments on `context.issue.number`, which does not exist | skip on `merge_group`; the PR run already decided this for identical content |

A job skipped by its own `if:` reports success to a required check, which is what
makes both skips safe.

## The blocker, stated up front

Merge queues are an organization-repository feature and this repo is user-owned.
On 2026-08-03 the API rejected the rule with `422 Validation Failed`,
`Invalid rule 'merge_queue'` (recorded in #3189). That probe was not repeated
here, because creating a ruleset is a settings change. `docs/merge-queue/`
therefore ships the definition to apply if the repo moves to an organization,
and says so in its first section rather than burying it.

## Changes

- `ci.yml`, `version-check.yml`, `build.yml`, `plugin-validation.yml`,
  `demos-validate.yml`: `merge_group: types: [checks_requested]` made explicit,
  plus the two guards above.
- `docs/merge-queue/ruleset.json`: squash, `ALLGREEN`, groups of 1 to 5, build
  concurrency 5, 60 minute check timeout, three required contexts
  (`CI Summary`, `Validation Summary`, `Validate Renderer`), no required reviews.
- `docs/merge-queue/README.md`: apply, verify, roll back, bot interactions, and
  what changes for agents (`gh pr merge --auto`, never `gh pr update-branch`,
  `--admin` does not bypass a ruleset).

Why those three contexts: two are `if: always()` fan-ins covering 25 jobs between
them, and `Validate Renderer` is the only required check neither aggregates.
`Docs Site Build` is excluded because it is path-filtered, so requiring it would
leave most PRs waiting on a context that never reports. Any job another job
`needs` is excluded too, since a dependency-skipped job reports `skipped`, which
counts as success.

## Verification

- `actionlint -shellcheck= .github/workflows/*.yml`: clean, exit 0.
- `zizmor --offline --config .github/zizmor.yml --min-severity medium`: 0
  findings before and after, 0 `dangerous-triggers`.
- `scripts/check-workflow-gates.sh`: all workflow gate labels exist.
- `node docs/site/scripts/lab-manifest.mjs --check`: set check OK, 152 entries.
- Local `actionlint` is 1.7.12 and `zizmor` is 1.26.1, while CI pins 1.7.7 and
  1.25.2, so CI is the authority on the exact versions.
- Not run: `npm test`, which needs an install this worktree does not have. The
  diff is workflow triggers, two `if:` guards, and docs.

## Interactive Playground

`docs/ci--merge-queue-ready/index.html`, published to the Lab:
https://orchestkit.yonyon.ai/lab/merge-queue-ready.html

Pick an event to see what each of the 18 required contexts does on
`pull_request`, on `merge_group` before this change, and after it.

Refs #3189

🤖 Generated with [Claude Code](https://claude.com/claude-code)
