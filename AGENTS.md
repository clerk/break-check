# AGENTS.md

Orientation for agents and new contributors working on `@clerk/break-check`. The
[README](./README.md) is the user-facing surface; this file covers what you
need to know to change the code.

## What this repo is

A CLI that snapshots TypeScript public API surfaces using Microsoft API
Extractor, diffs them between a baseline and the current build, and reports
breaking vs. non-breaking changes. It is consumed three ways:

1. As a local CLI (`break-check snapshot`, `break-check detect`).
2. As a GitHub composite Action (see `action.yml`) that runs the CLI on PRs.
3. Programmatically via `src/index.ts` exports (currently thin).

The package is published as `@clerk/break-check`. Versioning is managed by
Changesets.

## Layout

```
src/
  cli.ts              Commander entrypoint. Wires init / snapshot / detect.
  config.ts           Loads + validates break-check.config.json via zod.
  index.ts            Public programmatic exports.
  types.ts            Shared types (Snapshot, ApiChange, Severity, etc.).
  core/
    api-extractor.ts  Wraps @microsoft/api-extractor. Discovers package
                      entrypoints, including subpath exports, and produces
                      raw .d.ts rollups.
    detector.ts       Top-level orchestration for `break-check detect`. Loads
                      snapshots, runs the rule-based diff, optionally
                      invokes the AI reviewer, then renders the report.
  analyzers/
    api-diff.ts       Rule-based structural diff. Source of truth for
                      classification (breaking / non-breaking / addition).
    ai-analyzer.ts    Optional Claude-based reviewer. Confirms/overrides
                      rule-based verdicts and scans for misses. Fail-soft.
    version.ts        Inspects package.json version bumps relative to the
                      baseline; flags insufficient bumps when enabled.
  reporters/
    markdown.ts       Renders the change report. JSON output is produced
                      directly from the change objects, not via a reporter.
  utils/              Small shared helpers.
test/                 Node's built-in test runner (`node --test`). Tests
                      run against the built dist/, not src/. See `test`
                      script in package.json.
action.yml            Composite GitHub Action. Snapshots the base ref in a
                      worktree, builds the PR, runs detect, comments on PR.
.github/workflows/    CI for this repo (build/test/release/api-check).
.changeset/           Pending changesets for the next release.
```

## Build, test, verify

Package manager is **pnpm** (`pnpm-lock.yaml`). Node `>=22.13` (repo pins
24 via `.nvmrc`).

```bash
pnpm install
pnpm build         # tsc -> dist/
pnpm test          # builds then runs node --test test/*.test.mjs
pnpm typecheck     # tsc --noEmit
pnpm check         # format + typecheck + test + pnpm pack --dry-run
pnpm format        # prettier --write
```

Tests import the built `dist/` output, so `pnpm test` always builds first.
If you're iterating tightly, run `pnpm dev` (tsc --watch) in one shell and
`node --test test/<file>.test.mjs` in another.

Before declaring work done: `pnpm check` must pass, and `git diff main
--stat` should show only intended files.

## Where to make changes

- **New CLI flag**: add it in `src/cli.ts`, thread it through to whichever
  module consumes it. Most options flow into `detector.ts` or
  `api-extractor.ts`.
- **New config field**: extend the zod schema in `src/config.ts` and the
  `BreakCheckConfig` type. Document it in `README.md` and bump via a changeset.
- **Change how a diff is classified**: edit `src/analyzers/api-diff.ts`.
  The "Change Detection" table in `README.md` is the contract; if you
  shift a classification, update the README and add a test in
  `test/api-diff.test.mjs`.
- **Change AI reviewer behavior**: `src/analyzers/ai-analyzer.ts`. Keep
  it fail-soft. Any new failure mode must fall back to the rule-based
  result rather than crashing `detect`.
- **Change Action behavior**: `action.yml` is a composite Action,
  pure shell. The Action's "first PR introducing break-check" branch copies
  the PR config into the base checkout (see README for context); be
  careful not to regress that.

## Conventions

- **TypeScript**: strict, ESM (`"type": "module"`), `NodeNext` module
  resolution. Imports of local files use `.js` extensions even though
  source is `.ts`.
- **Errors**: surface diagnostics through the CLI's existing error
  paths (non-zero exit, message on stderr). Don't `process.exit` from
  deep modules; let `cli.ts` decide the exit code.
- **JSON output**: when `--format json` writes to stdout, every other
  log line must go to stderr so stdout stays parseable. `detector.ts`
  enforces this; preserve it.
- **No em-dashes** in code comments, commit messages, PR descriptions,
  or docs. Use commas, semicolons, or periods.
- **Changesets**: every PR that touches published code needs a
  changeset (`pnpm changeset`). For Action-only or tooling-only changes
  that don't affect the published package, commit an empty changeset
  (frontmatter with no packages).
- **Commits/PRs**: conventional commit prefixes (`feat:`, `fix:`,
  `chore:`, `docs:`) follow the existing log. PR descriptions stay
  short and point reviewers at the load-bearing parts of the diff.
- **Worktrees**: keep them under `.worktrees/` (gitignored).

## Subtleties worth knowing

- **Subpath exports**: `api-extractor.ts` walks every entrypoint exposed
  through `package.json#exports`, not just `.`. A package with
  `exports["./foo"]` produces a separate snapshot file. See
  `test/subpath.test.mjs` for the contract.
- **Hashed bundler chunks under `./*` are filtered.** When a wildcard export
  globs into a bundler output dir, the shared content-hashed chunks
  (`index-Dq-_K2VH`, `url-CcPzUbGM`) are not public API but their hash flips
  every build, so naive expansion reports phantom remove+add subpaths.
  `isHashedChunkSubpath` (in `utils/api-extractor.ts`) drops wildcard matches
  whose basename ends in a high-entropy `-<8 base64url chars>` suffix; it is on
  by default and toggled via the `ignoreHashedChunks` config field. The filter
  is applied symmetrically, both in `discoverEntries` (current build) and on the
  baseline read in `detector.ts#analyzePackage`, so an older baseline that
  recorded chunk subpaths reconciles without a `DISCOVERY_VERSION` bump.
  `ignoreSubpaths` is now glob-aware (`makeSubpathMatcher`) as the explicit
  escape hatch for anything the heuristic misses.
- **Type variance is intentionally pessimistic**: any type change is
  flagged as breaking, even when the new type is strictly wider. The
  AI reviewer is currently the only thing that can downgrade those.
  This is documented in the README; don't "fix" it silently.
- **API Extractor major bumps are break-check major bumps.** `@microsoft/api-extractor`
  is pinned to an exact version in `package.json` (no `^`). Each per-package
  metadata file records the producing `breakCheckVersion`, `apiExtractorVersion`,
  and `discoveryVersion` (snapshot `schemaVersion: 4`). On `break-check detect`, a
  baseline whose recorded AE major differs from the running one is refused with
  a structured error, since the hand-rolled `parseApiJson` reader is not
  guaranteed to be forward/backward compatible across AE majors. Pre-stamp
  baselines (v1/v2) load with a warning. When you bump AE, expect to issue a
  break-check major and document that committed baselines must be regenerated.
- **Discovery-version gate.** `DISCOVERY_VERSION` in `utils/api-extractor.ts`
  tracks break-check's entry-point discovery semantics; bump it whenever a change
  alters _which_ entry points are enumerated (e.g. wildcard subpath expansion
  did). `detect` refuses a baseline whose recorded `discoveryVersion` is older
  than the running one, and refuses a producer-stamped baseline (schema >= 3)
  that predates the field, because the two snapshots no longer cover the same
  surface and newly enumerated subpaths would otherwise read as phantom
  additions. As a backstop, a current subpath that has no baseline entry in an
  already-baselined package is collapsed to a single "new subpath" addition
  (`buildSubpathAdditionChange` in `core/detector.ts`) rather than one addition
  per exported member.
- **AI reviewer is opt-in**: it runs iff `BREAK_CHECK_ANTHROPIC_API_KEY` is
  set, unless `ai.enabled` is explicitly `false`. Model resolution
  priority is `--ai-model` > `BREAK_CHECK_AI_MODEL` > `ai.model` config >
  `claude-sonnet-4-6`. Preserve that priority order when editing.
- **The reviewer prompt is lean in both modes.** It ships only the _current_
  API surface; the previous shape of each change rides along in its
  `beforeSnippet`, so the baseline dump (which roughly doubled the prompt) is
  never sent, not even under `strict`. The change list is compact JSON,
  `submit_review` asks for one-sentence rationales, and the surface only takes a
  prompt-cache breakpoint when more than one chunk will read it. An
  additions-only diff makes zero API calls in the lean path.
- **Downgrades are gated behind `strict`; the lean default cannot clear a
  break.** A `breaking -> non-breaking` verdict is the only operation that can
  hide a real break, so the analyzer applies it only when `strict` is set
  (wired from the detector's `aiStrict` through the analyzer's `strict`
  option). In the lean default such a verdict is recorded as an
  `ai-suggested-downgrade`: the change stays breaking and the report tells the
  user to re-run `--ai-strict` to apply it. Escalations (`-> breaking`) and
  confirmations always apply, in both modes. Keep this gating, it is what makes
  the safety property real ("the default reviewer never turns a flagged break
  into a non-break") instead of a hope about model behavior. `strict` also
  enables the open-ended missed-breaks audit and runs the reviewer on
  additions-only diffs. Do not reintroduce the baseline surface to "strengthen"
  strict downgrades: the inline before/after snippets plus the current surface
  are sufficient, and rule 8 of the system prompt tells the model to keep
  "breaking" for any type it cannot resolve, so a missing definition fails safe.
- **Action is preview**: it ships from this repo but isn't usable
  until `@clerk/break-check` is on npm and a `v1` tag exists. The README
  has the disclaimer; keep it in sync if the status changes.

## Release flow

1. Land PRs with changesets.
2. The release workflow (see `.github/workflows/`) opens a "Version
   Packages" PR. Merging it tags and publishes via
   `pnpm release` (which runs `changeset publish`).
3. After the first published release, the GitHub Action's preview
   disclaimer in `README.md` can be removed and a `v1` tag cut.
