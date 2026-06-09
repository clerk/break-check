# @clerk/break-check

## 0.1.2

### Patch Changes

- [#86](https://github.com/clerk/break-check/pull/86) [`b38f1fc`](https://github.com/clerk/break-check/commit/b38f1fc14c4c89f4746e3e4a5a49c26eff864c03) Thanks [@jacekradko](https://github.com/jacekradko)! - Stop reporting pure union/intersection member reorders as breaking changes
  ([#85](https://github.com/clerk/break-check/issues/85)). TS emits inferred union members in an unstable order, so an unrelated
  edit could rotate them and trip a phantom `Return type changed`; the differ now
  sorts members before comparing. Compare-time only, so committed baselines need
  no regeneration.

## 0.1.1

### Patch Changes

- [#81](https://github.com/clerk/break-check/pull/81) [`a4b6ff9`](https://github.com/clerk/break-check/commit/a4b6ff9f7a800eac386e81299b47b7f1d7715b07) Thanks [@jacekradko](https://github.com/jacekradko)! - The GitHub Action gains an `anthropic-api-key` input to enable the AI reviewer, and `detect` gains `--json-output` so the Action runs detect once instead of twice. Oversized PR comments are truncated with the full report attached as the `break-check-report` artifact. Requires `break-check-version` >= 0.1.1.

## 0.1.0

First published release. Break Check is a CLI that snapshots a TypeScript package's public `.d.ts` surface with [Microsoft API Extractor](https://api-extractor.com/), diffs a branch against a baseline, and classifies every change as breaking, non-breaking, or an addition. It is built for PR gates: fail CI when a breaking API change is not matched by an adequate version bump.

```bash
npm install -D @clerk/break-check
npx break-check init        # write break-check.config.json
npx break-check snapshot    # record a baseline
npx break-check detect --fail-on-breaking
```

### Core workflow

`init`, `snapshot`, and `detect` commands driven by a zod-validated `break-check.config.json`, with optional version-bump enforcement (`checkVersionBump`). Reports render as Markdown or JSON; in JSON mode stdout stays clean (every log goes to stderr) so it pipes. `detect` exits non-zero on a breaking change under `--fail-on-breaking`, and exits `3` when it refuses an incompatible baseline so CI can tell the two cases apart. (#3, #5, #8)

### Structural API diff

The differ compares parsed declaration structure, not joined token strings, so parameter renames and whitespace no longer read as breaking. It classifies optional/required parameter flips, added optional parameters, rest-parameter changes, return-type changes, and property-type changes individually, and normalizes equivalent import spellings (`import("pkg").Foo` vs a namespace alias) so build-strategy differences don't surface as phantom breaks. Type variance is intentionally pessimistic: any type change is flagged breaking unless something downgrades it. (#5, #45, #70)

### Full export-map coverage

Break Check walks a package's entire `exports` map, producing one snapshot per subpath (`./react`, `./errors`, ...), and expands single-segment wildcard exports (`"./*"`) into concrete subpaths instead of skipping them. Content-hashed bundler chunks pulled in by a wildcard (`index-Dq-_K2VH`) are filtered out (`ignoreHashedChunks`, on by default) so their per-build hash churn doesn't masquerade as removed/added subpaths. `ignoreSubpaths` is glob-aware as the manual escape hatch. (#19, #26/#37, #49/#50)

### Optional AI reviewer

When `BREAK_CHECK_ANTHROPIC_API_KEY` is set, Break Check sends each change a focused context (only the type definitions its signature references, plus usage sites) to Claude, which can confirm, escalate, or downgrade the rule-based verdict and scan for breaks the rules missed. It is fail-soft: any AI failure falls back to the rule-based result, so the exit code never depends on AI availability, and an incomplete review is flagged `(partial)` in the report rather than silently trusted. Two independent opt-ins, both off by default: `--ai-scan` runs the deeper missed-breaks audit, and `--ai-apply-downgrades` lets a `breaking → non-breaking` verdict actually clear a break (otherwise it is recorded only as a suggestion). Model resolution: `--ai-model` > `BREAK_CHECK_AI_MODEL` > `ai.model` > `claude-sonnet-4-6`. (#18, #22, #51, #57, #59)

### GitHub Action

`uses: clerk/break-check@v1` drops the snapshot → detect → comment flow into a PR. It builds both sides in isolated git worktrees pinned to the PR's `base.sha` and `head.sha` (so a moving base branch can't fabricate or invert changes) and posts a single, self-updating PR comment. Inputs cover config path, base/head ref, setup command, version, comment toggle, and `fail-on-breaking`; `baseline-artifact-name` plus `baseline-max-age` let large monorepos reuse a baseline uploaded from a push-to-main workflow; `policy-mode` enforces the base ref's config so a PR can't suppress its own break. Outputs expose `has-breaking-changes` and the report path. (#9, #25, #30, #43, #64)

### Safety and correctness gates

- **Version-stamped baselines.** Snapshots record `breakCheckVersion`, `apiExtractorVersion`, and `discoveryVersion` (schema v4); `detect` refuses a baseline whose API Extractor major or discovery semantics differ from the running build rather than producing nonsense diffs. (#27, #41)
- **Unresolvable-reference guard.** A signature that newly references an export-blocked dependency subpath (e.g. `@clerk/shared/_chunks/...` under `"./_chunks/*": null`) is pinned breaking, since it errors or degrades to `any` for consumers, and the AI may not relax it. (#60, #61)
- **Phantom-addition and report-size limits.** A newly-baselined subpath collapses to one "new subpath" entry instead of one per member, and the Markdown report enforces a size budget so it stays under GitHub's 65 KB comment limit. (#30, #41)
- **Resilient extraction.** A subpath API Extractor can't process (ambient globals, `@clerk/astro/env`, Cypress/Playwright patterns) is skipped with a warning instead of crashing the run; `--fail-on-skipped` turns skips back into a hard failure for baseline production. (#36)
- **Path-traversal guard.** Entry discovery refuses a `types`/`exports` path that resolves outside the package root (a `package.json` is attacker-controlled when the Action builds a PR). (#64)

### Configuration

Beyond the basics, `break-check.config.json` accepts `acknowledgedChanges` (downgrade a named breaking change unconditionally; a maintainer override that always wins), `resolvableSpecifiers` (exempt a specifier from the unresolvable-reference guard), `ignoreSubpaths` / `ignoreHashedChunks`, and an `ai` block (`enabled`, `model`, `applyDowngrades`, `scanForMissed`). (#57, #61)
