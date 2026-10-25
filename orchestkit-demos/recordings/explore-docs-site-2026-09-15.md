# Explore: docs/site (2026-09-15, branch show/ep1-claude-explore)

Lean single-thread exploration. The forked /ork:explore agent dropped its
argument, and the 5-hour quota was at 94%, so no agent fan-out ran.

## What it is

Next.js 16 (App Router, `--webpack`) + Fumadocs 16 docs and marketing site for
orchestkit.yonyon.ai. React 19, Tailwind 4, Vitest 5 (happy-dom), Playwright.
Deployed on Vercel (`vercel.json`, `scripts/vercel-install.sh`).

## Layout

| Dir | Files | Role |
|---|---|---|
| `app/(home)/` | ~25 pages | marketing: landing, compare, pricing, changelog, factory-ride, yonyon |
| `app/api/` | ~18 routes | agent-facing surface: mcp, ask, md/[slug], llms.txt, openapi, og, indexnow, jobs |
| `app/agent/identity` | 1 | bearer identity endpoint (auth-chain work, memory 09-14) |
| `middleware.ts` | 300 lines | content negotiation (md twins, JSON 404s), agent identity, metered surfaces |
| `content/docs/` | ~260 mdx | hand-written guides + GENERATED reference/{skills,agents,hooks} |
| `lib/` | 46 + 14 generated | search (orama), agent surface, analytics, rate-limit, host installs |
| `lib/generated/` | 14 | plugins-data, lab-data, changelog-data, skills-data, cc-adoption-data (103 KB), search index |
| `components/` | 47 + world/ lab/ analytics/ lazy/ ui/ | skill-browser, agent-selector (29 KB), demo-gallery, search-dialog, setup-wizard |
| `components/world/` | 9 | factory-ride, skill-atlas, george, station-glyphs (the "world" narrative UI) |
| `lab-manifest/` | 180 json | one fragment per Lab entry; source for public/lab/*.html + lab-data.ts |
| `public/lab/` | 179 html | committed published canon of the Lab pages |
| `__tests__/` | 65 | unit + component tests; heavy on agent surface, middleware, search, analytics |
| `e2e/` | landing.spec.ts | Playwright |

## Generation pipeline (three generators, all invoked by root `npm run build`)

1. `scripts/build-docs.sh` -> `scripts/_build-docs-generate.py`: SKILL.md /
   agents / hooks.json -> `content/docs/reference/**`. Split-to-folder for
   5 opted-in skills over 90 KB.
2. `scripts/generate-docs-data.js` (56 KB): all counts and metadata ->
   `lib/generated/*-data.ts` + `lib/playground-data.ts`. Also `predev`.
3. `docs/site/scripts/generate-lab-data.mjs` -> `lab-manifest.mjs`:
   fragments -> lab-data.ts + public/lab html; plus cc-adoption-data.ts.
   Output must be a pure function of tracked inputs (SOURCE_DIGEST).

CI (`.github/workflows/ci.yml`) diffs `lib/generated/`, `public/lab/`,
`plugins/`, README after rebuilding, and runs `lab-manifest.mjs --check`.
Running any single generator alone creates drift; use `npm run build`.

## Hotspots (git churn since 2026-07-01, this dir)

```
plugins-data.ts     ▓▓▓▓▓▓▓▓▓▓ 212
lab-data.ts         ▓▓▓▓▓▓▓▓░░ 171
changelog-data.ts   ▓▓▓▓▓▓▓▓░░ 167
lab-manifest.json   ▓▓▓▓▓▓░░░░ 132   (legacy monolith, now per-fragment dir)
skills-data.ts      ▓▓▓▓▓░░░░░ 116
doctor.mdx          ▓▓▓░░░░░░░  71   (the 480-row CC matrix page)
```

Every top-churn file is generated. Hand-written code churns far less. That is
the expected shape for a site whose content is derived from `src/`.

## Health observations

- Generated files are committed and gate CI. Good for reproducibility, bad for
  merge conflicts: any two PRs that touch `src/` conflict on lab-data.ts /
  plugins-data.ts (memory: take either side, rerun `npm run build`).
- `lib/generated/cc-adoption-data.ts` is 103 KB and imported by the adoption
  board; check it stays out of the shared first-load bundle.
- `agent-selector.tsx` (29 KB) and `skill-browser.tsx` (19 KB) are the largest
  hand-written components; candidates for splitting if they churn.
- Test roster is strong on the agent surface (identity, 404 recovery, mcp,
  rate-limit, replay-gate) and analytics. Thin on `components/world/`.
- `AGENTS.md` is Next-generated boilerplate re-added by `next dev`; commit it
  once rather than fighting it.
- Sidebar hides skill/agent/hook leaves via meta.json `pages` trimming
  emitted by the Python generator; browsing lives in the Skill Atlas.

## Not verified

No build, tests, or dev server were run. Bundle-size and test-coverage claims
above are inferred from file sizes and rosters, not measured.
