# @clerk/break-check

## 0.5.0

### Minor Changes

- [#105](https://github.com/clerk/break-check/pull/105) [`3f376e1`](https://github.com/clerk/break-check/commit/3f376e1cb87d2cdd4276d57251d11f58be9f4c14) Thanks [@jacekradko](https://github.com/jacekradko)! - Support package-scoped `ignoreSubpaths` entries. A bare entry still applies to every configured package; an entry prefixed with a package name and `#` (the same separator `acknowledgedChanges` uses) ignores the subpath only in matching packages, e.g. `"@clerk/astro#./env"`. Globs are accepted on both sides (`"@clerk/*#./internal"`), which goes beyond `acknowledgedChanges`, whose package part is matched exactly. Skip-reason warnings for unsnapshotable subpaths now name the exact scoped entry to copy. Entries starting with `.` keep their historical meaning byte-for-byte; the only reinterpreted shape is a non-dot entry containing `#` (e.g. `**#./env`), which previously matched a literal `#` inside an exports key and is now read as a scoped entry.

## 0.4.0

### Minor Changes

- [#101](https://github.com/clerk/break-check/pull/101) [`1860598`](https://github.com/clerk/break-check/commit/18605980a7d67bc4c086518801e3a9b3f7369c78) Thanks [@jacekradko](https://github.com/jacekradko)! - Skip reasons for subpaths API Extractor cannot snapshot are now classified
  into actionable messages instead of echoing AE's raw InternalError text. An
  ambient entry `.d.ts` (no top-level import or export) is reported as a surface
  AE can never analyze, and an unresolvable type name in the shipped
  declarations is reported as likely-broken published types; both point at
  `ignoreSubpaths` as the acknowledgment path and keep the original AE first
  line for traceability. Unrecognized messages pass through with only the
  "software defect" boilerplate stripped.

- [#99](https://github.com/clerk/break-check/pull/99) [`4c81537`](https://github.com/clerk/break-check/commit/4c81537a77f8bd447e5209b859961b8a02a96eb4) Thanks [@jacekradko](https://github.com/jacekradko)! - A reference _repair_ is now reported non-breaking (issue [#98](https://github.com/clerk/break-check/issues/98)). When a breaking
  modification's only diff is swapping module specifiers consumers could not
  resolve (export-blocked, e.g. `@clerk/shared/_chunks/index-Cr_OtBLq` under
  `"./_chunks/*": null`, or chunk-shaped with the dependency unlocatable) for
  specifiers that provably resolve against the dependency's `exports`, the change
  is deterministically downgraded and tagged as a repaired reference in the
  report. The old reference errored (TS2307) or degraded to `any` downstream, so
  fixing it cannot break anyone. The check is fail-closed: any difference beyond
  the specifier/alias swap, or an introduced specifier that does not provably
  resolve, keeps the change breaking. Opt out with
  `downgradeRepairedReferences: false`.

  The AI reviewer now also receives deterministic exports-map verdicts
  (`referenceResolutions`) for every specifier a signature drops or introduces,
  instead of guessing resolvability from path shapes, and cannot escalate a
  deterministically repaired change back to breaking (recorded as
  `ai-suggested-escalation`, mirroring the downgrade refusal for unresolvable
  references).

## 0.3.0

### Minor Changes

- [#93](https://github.com/clerk/break-check/pull/93) [`d3297f3`](https://github.com/clerk/break-check/commit/d3297f330ba4947cef51510ae8dfb312f3ebb600) Thanks [@jacekradko](https://github.com/jacekradko)! - Version-bump validation now follows semver range semantics instead of raw
  labels. A breaking change in a `0.x` package is satisfied by a minor bump
  (`^0.2.3` ranges stop at the next minor, so that IS the breaking boundary);
  previously every 0.x breaking change was flagged "insufficient" unless it went
  to 1.0.0. An advance within one prerelease train (`1.0.0-beta.1 ->
1.0.0-beta.2`, or finalizing to `1.0.0`) is no longer reported as "version was
  not bumped". `VersionAnalyzer.compareVersions` now honors prerelease
  precedence per the semver spec (`1.0.0-beta.1` ranks below `1.0.0`), and a new
  `VersionAnalyzer.isPrereleaseAdvance` is exported.

  BREAKING (programmatic API only): `VersionAnalyzer.isPreRelease` and
  `isValidPreReleaseBump` are renamed to `isZeroMajor` and
  `isValidZeroMajorBump`. The old names conflated the 0.x convention with semver
  prerelease tags, which this release starts handling as a distinct concept.
  Per the 0.x rule above (which break-check now applies to itself), this rename
  ships in a minor.

- [#94](https://github.com/clerk/break-check/pull/94) [`a6c4eb9`](https://github.com/clerk/break-check/commit/a6c4eb93c20d69c3a19ffb47725f5a12ba71e069) Thanks [@jacekradko](https://github.com/jacekradko)! - The report's projected bump target now follows the same conventions bump
  validation applies. A 0.x package with breaking changes projects the next
  minor (`0.2.0 -> 0.3.0`) instead of suggesting a jump to `1.0.0`, with a note
  explaining the 0.x convention (shown after the bump lands too, so
  "Recommended: MAJOR / Actual: MINOR ✅" doesn't read as a contradiction). A
  package on a prerelease tag projects the next tag in its train
  (`1.0.0-beta.1 -> 1.0.0-beta.2`) instead of a whole-major jump. Adds
  `VersionAnalyzer.nextPrereleaseVersion` to the programmatic API. The JSON
  output is unchanged: `recommendedVersionBump` remains the severity label.

### Patch Changes

- [#96](https://github.com/clerk/break-check/pull/96) [`fd0f124`](https://github.com/clerk/break-check/commit/fd0f124f89938c8977e0297682836649b9b5f485) Thanks [@jacekradko](https://github.com/jacekradko)! - `findConfigFile` no longer hangs when called with a relative start directory.
  The walk-up loop compared against `path.parse(startDir).root`, which is empty
  for a relative path while `path.dirname` bottoms out at `"."`, so the loop
  never terminated. The start directory is now resolved against cwd before
  walking. The CLI always passed absolute paths, so this only affected
  programmatic callers of the exported function.

## 0.2.0

### Minor Changes

- [#89](https://github.com/clerk/break-check/pull/89) [`7c59947`](https://github.com/clerk/break-check/commit/7c599479f04a2ebfce09ae6fa3fda5de6e50ad72) Thanks [@jacekradko](https://github.com/jacekradko)! - Stop under-reporting surface break-check never actually checked. (Minor, per
  break-check's own verdict on this diff: `PackageInfo` gains an optional
  `unresolvedSubpaths` field in the programmatic API.) Entry-point
  discovery now resolves types declared under nested export conditions
  (`{ "node": { "import": { "types": ... } } }`) and `.d.cts` files, both
  previously skipped without a trace. A subpath that declares types break-check
  still cannot resolve (a missing file, a target escaping the package, an
  unsupported wildcard pattern) is now recorded as a skipped entry, so it shows
  up in the report and `--fail-on-skipped` catches it; JS-only and asset subpaths
  stay silent. And `detect` now refuses a `--baseline` that resolves to the
  configured `snapshotDir`, which previously overwrote the baseline with the
  current snapshots and reported "no changes" for any break.

### Patch Changes

- [#88](https://github.com/clerk/break-check/pull/88) [`123300f`](https://github.com/clerk/break-check/commit/123300f964983403c9df4a325e91db80d980364f) Thanks [@jacekradko](https://github.com/jacekradko)! - Fix a family of false negatives in the rule-based differ. Overload signatures
  now carry their `overloadIndex` in the comparison key, so removing or editing a
  function or method overload (or one of several call/construct/index signatures)
  is reported instead of silently collapsing onto the last overload. An
  optionality flip no longer short-circuits the member compare, so a change like
  `a: string` -> `a?: number` reports the breaking type change instead of a
  non-breaking "became optional"; property and variable types are now compared
  via their kind-specific token ranges (`propertyTypeTokenRange`,
  `variableTypeTokenRange`) instead of the full declaration text. And
  `static`/`protected`/`abstract` modifier flips are compared explicitly, which
  also catches them on methods and classes where the signature compare never saw
  them. All fixes are compare-time only; committed baselines need no
  regeneration.

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
