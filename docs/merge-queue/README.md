# Merge queue on `main`

Everything needed to turn on a GitHub merge queue for `main`, plus the reason it
is not on yet. Nothing here has been applied: no repository setting, ruleset or
branch protection was touched by the change that added this directory.

Background and the incident history that motivates it: issue #3189.

## Read this first: the repo cannot host a merge queue today

Merge queues are an organization-repository feature. `yonatangross/orchestkit` is
**user-owned** (`gh api repos/yonatangross/orchestkit -q .owner.type` returns
`User`), and on 2026-08-03 the API rejected the rule directly, probed with an
inert disabled ruleset that was deleted immediately after:

```
POST /repos/yonatangross/orchestkit/rulesets
  rules: [ { type: merge_queue, ... } ]

422 Validation Failed
errors: ["Invalid rule 'merge_queue': "]
```

That probe is recorded in #3189. It was not re-run for this change, because
re-running it means creating a ruleset, which is a repository-settings change.

So `ruleset.json` here is the definition to apply **if and when** the repo lives
in an organization. Until then the apply step below returns 422 and changes
nothing. The alternatives, both from #3189, are to transfer the repo to an
organization, or to drop `strict` from branch protection and lean on the
`CI Summary` aggregator.

The rest of this document is still worth having: the workflow changes that
shipped alongside it are the ones that make a queue survivable, and two of them
fixed checks that would have failed **every** queued entry.

## What changed in the workflows

`main` requires 18 status contexts (classic branch protection, not a ruleset:
`gh api repos/yonatangross/orchestkit/rules/branches/main` returns `[]`, while
`gh api repos/yonatangross/orchestkit/branches/main/protection` lists them). A
merge queue only merges an entry when every required context reports success on
the `merge_group` ref. A context that never reports stalls the queue forever; a
context that fails removes the entry.

All five workflows that own those 18 contexts already had a `merge_group`
trigger. They are now explicit about the event type, and two contexts that would
have failed on every queued entry are fixed:

| workflow | change | why |
| --- | --- | --- |
| `ci.yml` | `merge_group: types: [checks_requested]` | owns 13 of the 18 contexts |
| `ci.yml` | `secret-scanning` skips on `merge_group` | `gitleaks-action` v3.0.0 accepts only `push`, `pull_request`, `workflow_dispatch`, `schedule`, and calls `process.exit(1)` on anything else. `Secret Scanning` is required, so every queued entry would have gone red. The queued commit is PR content already scanned on `pull_request`, and the push to `main` the queue produces is scanned again |
| `version-check.yml` | job skips on `merge_group`, trigger made explicit | the gate keys on `github.head_ref` (empty on `merge_group`, so a Dependabot or release-please entry is judged as a feature branch and told to bump the version) and its failure path comments on `context.issue.number`, which does not exist for a queued entry |
| `build.yml`, `plugin-validation.yml`, `demos-validate.yml` | trigger made explicit | own `Build`, `Validation Summary`, `CC Plugin Validate`, `Validate Renderer` |

A job skipped by its own `if:` reports **success** to a required check, which is
what makes the two skips above safe, and what already made `PR Playground`
(gated `if: github.event_name == 'pull_request'`) safe.

Workflows deliberately left without `merge_group`: `pr-body-lint.yml`,
`visual-style-lint.yml`, `release-please-guard.yml`, `skill-autobuild.yml`,
`ultrareview.yml`, `plugin-eval.yml`, `docs.yml`. None is required on `main`,
and each reads PR-only data (body, title, labels, head ref). CodeRabbit posts a
commit status, not an Actions check, and does not report on `merge_group`, so it
must never become required.

## The queue-required set, and what it leaves out

`ruleset.json` requires three contexts:

| context | why it is in |
| --- | --- |
| `CI Summary` | `ci.yml` fan-in over 15 jobs, `if: always()`, fails on any `failure` or `cancelled`. One context covers build, lint, audits, unit, TypeScript shards, security, integration, performance, compliance, agents, manifests, static analysis, system and coverage |
| `Validation Summary` | `plugin-validation.yml` fan-in over 10 jobs, `if: always()`, fails unless each is `success` |
| `Validate Renderer` | reports on every PR (cheap early-exit when `orchestkit-demos` is untouched, 12s on #4100) and is aggregated by neither summary. It is the gate that stops a Dependabot bump from breaking the release renderer, the #3086 class |

Deliberately **not** required for the queue:

- `Docs Site Build`, because `docs.yml` filters `pull_request` by path. A
  path-filtered check never reports on a PR that misses the paths, so requiring
  it would leave most PRs waiting on a context that never arrives. `merge_group`
  does not support path filters either, so adding the trigger would run the full
  docs build on every entry and still not fix the PR side.
- `Build`, because three different jobs publish that name (`build.yml`,
  `ci.yml`, `plugin-validation.yml`), so the context is ambiguous. `CI Summary`
  and `Validation Summary` already fail when their own build job fails.
- `PR Playground`, `Check Version Bump & Changelog`, `Visual-Style PR Lint` and
  CodeRabbit, all PR-scoped by construction.
- Any single job that another job `needs`. A job skipped because its dependency
  failed reports `skipped`, which counts as success, so only `if: always()`
  fan-ins and standalone jobs are safe to require.

Reviews are not required: `main` today requires 0 approving reviews, and the
ruleset adds no `pull_request` rule, so a solo maintainer is not locked out.

## Applying it

Pre-flight, in order:

1. The workflow changes must be on `main` first. A `merge_group` run uses the
   workflow files in the queued commit, which contains `main`, so enabling the
   queue before this lands puts the `Secret Scanning` failure back.
2. Re-run the availability probe, since it is the known blocker:
   `gh api repos/yonatangross/orchestkit -q .owner.type` must not be `User`.
3. Confirm nothing else already defines rules on `main`:
   `gh api repos/yonatangross/orchestkit/rules/branches/main`.

```bash
gh api -X POST repos/yonatangross/orchestkit/rulesets --input docs/merge-queue/ruleset.json
```

Verify:

```bash
gh api repos/yonatangross/orchestkit/rules/branches/main --jq '.[].type'
gh api repos/yonatangross/orchestkit/rulesets --jq '.[] | [.id, .name, .enforcement] | @tsv'
```

Then watch the first queued PR end to end before queueing a second, and confirm
each of the three required contexts appears on the `gh-readonly-queue/main/pr-N`
ref rather than only on the PR.

## Rolling back

Classic branch protection is untouched by this ruleset, so deleting it restores
exactly today's behaviour.

```bash
ID=$(gh api repos/yonatangross/orchestkit/rulesets --jq '.[] | select(.name=="main: merge queue") | .id')
gh api -X DELETE "repos/yonatangross/orchestkit/rulesets/$ID"
```

To keep the definition but stop it acting, `PATCH` the same id with
`{"enforcement":"disabled"}`. Either way, drain or dequeue anything sitting in
the queue first: a PR removed with the queue still holding it stays unmerged.

## Bots

**Dependabot.** `dependabot-automerge.yml` runs `gh pr merge --auto --squash` on
non-major bumps. With a queue on the base branch, `gh` enables auto-merge and the
PR joins the queue when its checks pass; the strategy flag is ignored, since the
queue owns the merge method (`gh pr merge --help`: "When targeting a branch that
requires a merge queue, no merge strategy is required"). Majors stay held by
label, unchanged.

One thing to verify on the very first Dependabot PR: that workflow enqueues with
`GITHUB_TOKEN`, and events caused by `GITHUB_TOKEN` do not always start new
workflow runs. If the `merge_group` checks never appear for a bot-enqueued entry,
swap that step to an App token, the pattern `release-please.yml` already uses via
`steps.app-token.outputs.token`. Do not diagnose it as a queue misconfiguration
before checking that.

**release-please.** The release PR is a PR like any other and goes through the
queue. The queue's merge is a push to `main`, which still triggers
`release-please.yml`, so tagging and the release are unaffected. Two pieces of
scaffolding become dead weight rather than breaking: the "Keep open release PR up
to date" step (#3062), which exists because `strict` strands a `BEHIND` release
PR, and the comment on `release.yml`'s `gh pr merge "$BRANCH" --squash --auto`
warning about manual `update-branch`. The queue is what removes that class. Leave
them until the first release lands through the queue, then delete them in their
own PR.

`claude-release-watch.yml` also arms `--auto --squash --delete-branch`; the
branch deletion still happens via the repo's `delete_branch_on_merge`.

## What changes for agents

- Arm, do not merge: `gh pr merge <n> --auto`. No `--squash`; the queue decides.
- Never `gh pr update-branch`, and stop treating `BEHIND` as something to fix.
  Testing against the current tip is the queue's job, and a manual branch update
  is what produced the 2026-06-20 zero-CI-runs incident in #3189.
- `--admin` does not bypass a ruleset. `bypass_actors` is empty on purpose, and
  branch protection has `enforce_admins` on. If something truly must skip the
  queue, that is an operator decision on the ruleset, not a flag.
- A queued PR is not dequeued by `--disable-auto` once it is in the queue: use
  the "Remove from queue" control, or the `dequeuePullRequest` GraphQL mutation.
  `--disable-auto` only disarms a PR that has not entered yet.
- Read state with `gh pr view <n> --json state,mergeStateStatus`, and expect a
  merge commit authored by `github-merge-queue[bot]`.
- The `headless-defer` hook still defers `gh pr merge` for human approval in
  headless sessions. That is unchanged and still correct.
