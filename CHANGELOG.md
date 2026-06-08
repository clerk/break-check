# @clerk/break-check

## 0.1.0

### Minor Changes

- [#18](https://github.com/clerk/break-check/pull/18) [`edca94c`](https://github.com/clerk/break-check/commit/edca94c470ee0b0a6a95e6f85d156d13820f0bd2) Thanks [@jacekradko](https://github.com/jacekradko)! - Add opt-in AI-powered analysis of detected API changes. When `BREAK_CHECK_ANTHROPIC_API_KEY` is set, break-check sends each package's rule-based change list and a compact view of the baseline/current API surface to Anthropic's Claude. The model re-classifies changes (overriding the rule-based verdict in either direction, with rationale and migration guidance) and scans for breaks the rules missed. Failures fall back to rule-based output, so the CLI exit code never depends on AI availability. By default the AI call is skipped for diffs that the rule-based pass classified as pure additions; set `BREAK_CHECK_AI_STRICT=1` (or `ai.strict: true` in config, or pass `--ai-strict`) to run the deeper scan in those cases too. Configurable via a new `ai` block in `break-check.config.json` and the `--no-ai` / `--ai-model` / `--ai-strict` CLI flags.

- [#57](https://github.com/clerk/break-check/pull/57) [`e6f0b3e`](https://github.com/clerk/break-check/commit/e6f0b3e20848d6d36c48529de9c7630c535de04e) Thanks [@jacekradko](https://github.com/jacekradko)! - Stop the AI reviewer confirming two backwards-compatible changes as breaking, and add a config escape hatch for the rest.

  Adding an optional property (including one widened into a `Pick`/`Omit`) was confirmed breaking because the prompt never said it was safe and never forbade a verdict left conditional on a fact already in context. New classification rules fix that. Adding a required field to a read-only output type was confirmed breaking because the model only ever saw a type's forward references, never its callers, so it couldn't tell an input type from an output one. The focused verdict context now also carries a "Usage sites" block: the signatures that reference each changed type, gathered across the package's sibling subpath surfaces (the type and the function returning it usually live in different rollups). Both fixes only ever enable a downgrade, which still stays gated behind `--ai-apply-downgrades`.

  New `acknowledgedChanges` config option: list a breaking change by name (`OAuthConsentInfo`, `@clerk/shared#OAuthConsentInfo`, or a `Clerk.__internal_*` glob) to downgrade it to non-breaking and tag it `acknowledged` in the report. Unlike an AI downgrade this is unconditional.

  Fixes [#56](https://github.com/clerk/break-check/issues/56).

- [#51](https://github.com/clerk/break-check/pull/51) [`98cb225`](https://github.com/clerk/break-check/commit/98cb22591751a1628e4e260064ddffa5647d6de5) Thanks [@jacekradko](https://github.com/jacekradko)! - Rework the AI reviewer around the downgrade decision and split the old `strict` flag into two orthogonal opt-ins.

  The verdict call now sends a focused context instead of the whole API surface: for each change, only the definitions of the types its signature references (resolved transitively through API Extractor's canonical references), with a referenced type's baseline definition included where it changed so equivalence can be judged old-vs-new. On a large package that is a handful of types instead of hundreds of signatures. The change list is compact JSON and rationales are capped at one sentence.

  Downgrades are no longer applied by default. A `breaking -> non-breaking` verdict is the only operation that can clear a flagged break, so by default it is recorded as a suggestion (the change stays breaking) and applied only with `--ai-apply-downgrades` / `BREAK_CHECK_AI_APPLY_DOWNGRADES` / `ai.applyDowngrades`. The default path therefore cannot turn a flagged break into a non-break, and if a referenced type can't be resolved the model is told to keep "breaking", so a thin context costs a missed downgrade (noise), never a shipped break.

  The old `strict` flag is removed. Its missed-breaks audit (which sends both the baseline and current surfaces so the model can diff old vs new, and reviews additions-only diffs) is now its own opt-in: `--ai-scan` / `BREAK_CHECK_AI_SCAN` / `ai.scanForMissed`. Applying downgrades and running the audit are independent; combine them for the most thorough run.

  Migration: `--ai-strict` and `ai.strict` no longer exist. The flag errors as an unknown option, and a config that still sets `ai.strict` now fails validation with an "unrecognized key" error (the `ai` block rejects unknown keys) instead of silently doing nothing. Replace it with `ai.scanForMissed: true` (the audit) and/or `ai.applyDowngrades: true` (relax verdicts).

- [#5](https://github.com/clerk/break-check/pull/5) [`dcabe04`](https://github.com/clerk/break-check/commit/dcabe04ff57e36ff4212070e1630d9817d5a0e47) Thanks [@jacekradko](https://github.com/jacekradko)! - Rewrite the API diff analyzer to use structured comparison instead of joined-token string diffs. Parameter renames and whitespace differences no longer surface as breaking changes; optional/required parameter flips, added optional parameters, return-type changes, and property-type changes are now classified individually. Interface body edits are no longer double-counted at the container level.

- [#25](https://github.com/clerk/break-check/pull/25) [`14ec529`](https://github.com/clerk/break-check/commit/14ec52980ed06e214f6d78c0ea16488441b68b5c) Thanks [@jacekradko](https://github.com/jacekradko)! - Composite Action can now consume a baseline snapshot uploaded from a separate
  push-to-main workflow, instead of always rebuilding the base ref. Set the new
  `baseline-artifact-name` input to the artifact name; the Action downloads the
  most recent matching artifact on `base-ref` and uses it as the baseline. Falls
  back to the worktree rebuild on miss, expiry, or download failure, so existing
  configurations keep working unchanged. Optional `baseline-max-age` (hours)
  caps how old a downloaded artifact may be before falling back. See the
  "Larger monorepos" section of the README for the producer workflow.

- [#27](https://github.com/clerk/break-check/pull/27) [`11da46c`](https://github.com/clerk/break-check/commit/11da46c25498504948edb35854b5f6173172756b) Thanks [@jacekradko](https://github.com/jacekradko)! - Snapshot metadata (`break-check.snapshot.json`) now records the producing `breakCheckVersion` and `apiExtractorVersion` under `schemaVersion: 3`. On `break-check detect`, a baseline whose recorded `@microsoft/api-extractor` major differs from the running one is refused with a structured error, since the hand-rolled `.api.json` reader is not guaranteed compatible across API Extractor majors and would otherwise produce silently nonsensical diffs. Pre-stamp baselines (schemaVersion 1 or 2) still load, with a stderr warning suggesting regeneration. `parseApiJson` also gained a shape check that throws on an unrecognized `.api.json` structure rather than returning an empty surface.

- [#59](https://github.com/clerk/break-check/pull/59) [`aae2962`](https://github.com/clerk/break-check/commit/aae2962cd76869d26dfc06e438c4af825827078b) Thanks [@jacekradko](https://github.com/jacekradko)! - Make the report breaking-first and stop silently trusting incomplete AI reviews.

  A single AI review call that fails (the classic trigger: one huge type whose
  before/after snippet dominated the request) used to leave every change in that
  subpath with its pessimistic rule-based verdict and no annotation, while the
  report still claimed full AI coverage. The analyzer now caps oversized
  before/after snippets and bounds the focused-surface block by size so the call
  fits, splits-and-retries a failed batch into smaller ones, and records any
  review it still can't complete. Those gaps surface in the report: the "reviewed
  by" stamp is marked `(partial)` and a callout lists the affected subpaths.

  The report also leads with breaking changes: a breaking-changes index up front
  (survives the size-budget truncation), packages and subpaths ordered
  breaking-first, breaking sections never collapsed, and non-breaking sections
  collapsed behind `<details>` in large reports.

- [#9](https://github.com/clerk/break-check/pull/9) [`126506d`](https://github.com/clerk/break-check/commit/126506d06071242e16ad33139e04177ce790be90) Thanks [@jacekradko](https://github.com/jacekradko)! - Ship a reusable GitHub Action. Consumers can replace a hand-rolled snapshot/detect/comment workflow with `uses: clerk/break-check@v1` after their checkout/node/pnpm setup. The Action uses a git worktree for the baseline (so the PR checkout is never disturbed), runs `break-check` via `pnpm dlx`, and posts (or updates) a single PR comment with the report. Inputs cover the config path, base ref, setup command, break-check version, comment toggle, and `fail-on-breaking`; outputs expose `has-breaking-changes` and the report path.

- [#41](https://github.com/clerk/break-check/pull/41) [`d8abb51`](https://github.com/clerk/break-check/commit/d8abb511d1e28b688c8fc99aa9c1057e8f0fcb77) Thanks [@jacekradko](https://github.com/jacekradko)! - Stop reporting coverage/discovery growth as phantom API additions, and bound
  the total report size.

  When an already-baselined package gained subpaths (a coverage bump, a genuine
  new export, or a discovery change such as wildcard subpath expansion), `detect`
  diffed each new subpath against an empty baseline and emitted one addition per
  exported member. On `@clerk/shared` that meant a ~440 KB report claiming
  thousands of additions, none of them real API changes, which then exceeded
  GitHub's 65 KB comment limit and failed to post. Three fixes:
  - A current subpath with no baseline entry in an already-baselined package is
    now collapsed to a single "New subpath export" addition instead of one per
    member (symmetric with the existing subpath-removal handling). Brand-new
    packages still stay silent on first run.
  - Snapshot metadata records a new `discoveryVersion` (`schemaVersion: 4`).
    `detect` refuses a baseline whose discovery version is older than the running
    break-check, and refuses a producer-stamped baseline that predates the field, with
    the same "regenerate against the base ref" error the API Extractor major gate
    uses. break-check's Action regenerates the baseline every run, so it is unaffected;
    consumers caching a baseline across a break-check upgrade must regenerate once.
  - The markdown reporter now enforces a total-size budget (`maxReportChars`,
    default 60,000): whole package sections are included until the budget is
    reached, then the remainder is dropped with a notice pointing at the full
    JSON report, so an oversized diff still posts a valid comment.

  `break-check detect` now exits with code 3 (distinct from the generic error exit 1)
  when it refuses a baseline as incompatible, so CI can recognize the condition.
  The GitHub Action recovers automatically: on an incompatible-baseline refuse it
  rebuilds the baseline with the current break-check and retries instead of failing.

  Fixes [#40](https://github.com/clerk/break-check/issues/40).

- [#14](https://github.com/clerk/break-check/pull/14) [`e7ece09`](https://github.com/clerk/break-check/commit/e7ece094b0619ef841a45d14282c8a623c1589d2) Thanks [@jacekradko](https://github.com/jacekradko)! - **Breaking:** `ConfigSchema` is no longer exported from the package root. It was an internal validation detail used by `loadConfig`, and re-exporting it forced consumers to upgrade zod in lockstep whenever zod's `ZodObject`/`ZodArray`/`ZodEnum` generic shapes change (which is exactly what v3 → v4 just did, and what break-check's self-dogfood flagged). Use `BreakCheckConfig` (the inferred output type) instead; that export is unchanged.

  Also bumps zod from 3 to 4.

- [#36](https://github.com/clerk/break-check/pull/36) [`6b60743`](https://github.com/clerk/break-check/commit/6b60743f6bf1f4c82a2cd7b84d76fdf30251bdd1) Thanks [@jacekradko](https://github.com/jacekradko)! - Make per-entry extraction failures non-fatal.

  Previously, a single subpath that API Extractor couldn't process (ambient-global augmentations like `@clerk/testing/cypress`, root-level `.d.ts` files like `@clerk/astro/env`, anything that triggered an `InternalError` from AE) tanked the entire `snapshot` or `detect` run. Common Cypress, Playwright, and Astro patterns made break-check unusable on real monorepos.

  Per-entry failures now emit a `[break-check] warning: skipping <pkg> <subpath>: <reason>` line on stderr, are collected on the detector (`detector.lastSkippedEntries`), and surface in the detect report as a "could not snapshot N subpaths" callout above the diff so reviewers don't mistake an omitted surface for a clean one. The run continues with whatever extracted. Package-level fatals (missing `package.json`, zero discoverable entries) still throw, since those usually mean the config is wrong rather than one subpath is weird.

  `AnalysisResult` gains an optional `skippedEntries` array (`{ packageName, subpath, reason }[]`); JSON consumers can read it directly. Both `snapshot` and `detect` accept `--fail-on-skipped`, which turns any skip back into a non-zero exit, the safer setting when producing a committed baseline where a silently-omitted surface would otherwise read as "no changes."

  Fixes [#34](https://github.com/clerk/break-check/issues/34) (ambient-global crash on `@clerk/testing/cypress`).
  Fixes [#33](https://github.com/clerk/break-check/issues/33) (`Unable to determine module` crash on `@clerk/astro/env`).

- [#50](https://github.com/clerk/break-check/pull/50) [`d2f9d66`](https://github.com/clerk/break-check/commit/d2f9d6668b810bd185172a5b871a8ed2c266c2d9) Thanks [@jacekradko](https://github.com/jacekradko)! - Stop reporting content-hashed bundler chunks under `"./*"` as breaking add/remove subpaths.

  When a wildcard export globs into a bundler output dir, the shared chunks emitted by rolldown/tsdown/esbuild/rollup (`index-Dq-_K2VH.mjs`, `url-CcPzUbGM.mjs`, ...) were each turned into a public subpath by the [#26](https://github.com/clerk/break-check/issues/26) wildcard expansion. Those chunks are not public API and their content hash flips every build, so any real change renamed them and surfaced as a removed subpath (breaking) plus an added one, recommending a phantom major.

  Wildcard expansion now drops matches whose basename ends in a high-entropy `-<8 base64url chars>` suffix, controlled by a new `ignoreHashedChunks` config field (on by default). The filter runs on both the current discovery and the baseline read, so an older baseline that recorded chunk subpaths reconciles without a forced regeneration (no `DISCOVERY_VERSION` bump). `ignoreSubpaths` now also accepts globs (`./internal-*`, `./chunk-*`) as the explicit escape hatch for anything the heuristic misses.

  Fixes [#49](https://github.com/clerk/break-check/issues/49).

- [#42](https://github.com/clerk/break-check/pull/42) [`3008f95`](https://github.com/clerk/break-check/commit/3008f95ac37baac5071a1de50f2403575eee0dc8) Thanks [@jacekradko](https://github.com/jacekradko)! - Rename the package to `@clerk/break-check` and the CLI binary to `break-check`. The default config file is now `break-check.config.json` and per-package snapshot metadata is written as `break-check.snapshot.json`; the pre-rename `snapi.config.json` and `snapi.snapshot.json` are still read as deprecated fallbacks. Environment variables are renamed from `SNAPI_*` to `BREAK_CHECK_*`, and the GitHub Action's PR comment marker is now `break-check-action`.

- [#22](https://github.com/clerk/break-check/pull/22) [`48383cc`](https://github.com/clerk/break-check/commit/48383ccae7e70c6dc6f8ea7aed543cb5a96eff0a) Thanks [@jacekradko](https://github.com/jacekradko)! - Add `BREAK_CHECK_AI_MODEL` environment variable for selecting the AI reviewer's model from CI without editing config. Priority is `--ai-model` > `BREAK_CHECK_AI_MODEL` > `ai.model` in `break-check.config.json` > `claude-sonnet-4-6`. The README now documents the AI reviewer's env vars, the `ai` config block, and when to opt into Opus 4.7.

- [#19](https://github.com/clerk/break-check/pull/19) [`ce9211c`](https://github.com/clerk/break-check/commit/ce9211c8c27fea50045624f1c8a4e45b814ab9e2) Thanks [@jacekradko](https://github.com/jacekradko)! - Snapshot every subpath export, not just the package root. Break Check now walks the full `exports` map per package and produces one API snapshot per non-wildcard subpath (e.g. `@clerk/shared`'s `./react`, `./errors`, `./utils`, etc.). Wildcard patterns (`./*`, `./internal/foo/*`) are skipped with a warning since they're not single API surfaces. Each snapshot lives in `<safe-pkg>/<safe-pkg>__<subpath>.api.json` and a per-package `break-check.snapshot.json` (schema v2) lists every entry. Diffs report changes per subpath, including a synthesized BREAKING change when an entire subpath is removed. Old v1 baseline directories with a single root snapshot continue to read correctly during the transition. A new top-level `ignoreSubpaths: string[]` config option drops matching subpaths from discovery (exact match, e.g. `"./internal"`).

- [#61](https://github.com/clerk/break-check/pull/61) [`eb295f1`](https://github.com/clerk/break-check/commit/eb295f136409a7ba45908bf7591f7209e0bc371f) Thanks [@jacekradko](https://github.com/jacekradko)! - Stop the AI reviewer from downgrading a reference to an export-blocked dependency subpath.

  When a bundler moves a re-exported type into an internal chunk the dependency blocks in its `exports` (e.g. `@clerk/shared` declares `"./_chunks/*": null`), a public `.d.ts` can emit `import("@clerk/shared/_chunks/index-DcO1-lAR").Jwt`. The structural shape is unchanged, but the specifier does not resolve for consumers: under `nodenext` it errors (`TS2307`), and with `skipLibCheck: true` it silently degrades to `any`. The rule pass flagged this breaking, but the AI reviewer downgraded it as a "build artifact rename", so with `--ai-apply-downgrades` it shipped green.

  break-check now extracts the inline `import("...")` specifiers a new signature introduces (present in the after snippet, absent in the before) and classifies each against the target dependency's `package.json` `exports`: a subpath that resolves to `null`, or matches no key, is non-resolvable. When the dependency can't be located on disk it falls back to a `/_chunks/` and content-hash heuristic. A change carrying such a reference is pinned breaking and the AI may not relax it, even under `--ai-apply-downgrades`; the report shows a callout naming the specifier and drops the "re-run with --ai-apply-downgrades" nudge for it. The note bypasses break-check's own canonicalization, which discards the subpath before the diff or AI ever see it, so the signal is read from the raw `.d.ts` text.

  New `resolvableSpecifiers` config option: specifier globs to exempt from the guard when a referenced subpath is a legitimate public entry point the heuristic mis-flags. An explicit `acknowledgedChanges` entry also clears it.

  Fixes [#60](https://github.com/clerk/break-check/issues/60).

- [#37](https://github.com/clerk/break-check/pull/37) [`8558b8e`](https://github.com/clerk/break-check/commit/8558b8e66e756b390d86c51bb1f28231e211dfcf) Thanks [@jacekradko](https://github.com/jacekradko)! - Expand wildcard subpath exports (e.g. `"./*": "./dist/runtime/*.d.mts"`) instead of silently skipping them.

  Packages like `@clerk/shared` expose most of their public surface through a single wildcard subpath. break-check was dropping every wildcard key in `findEntryPoints` and only logging it at verbose level, so breaking changes under `@clerk/shared/file`, `@clerk/shared/url`, etc. never showed up in reports.

  The discovery layer now globs the wildcard's value against the package directory, derives the captured portion of each match, and substitutes it back into the key pattern to synthesize one concrete `PackageEntry` per file (single-segment `*` only; multi-segment nested wildcards remain unhandled and skip silently). Expanded entries are sorted by subpath so the resulting `break-check.snapshot.json` is byte-stable across runners (`fs.globSync` ordering is not guaranteed). Concrete keys still win over wildcard-expanded ones if both produce the same subpath. Both the wildcard key itself and individual expanded subpaths can still be excluded via `ignoreSubpaths`.

  Fixes [#26](https://github.com/clerk/break-check/issues/26).

### Patch Changes

- [#35](https://github.com/clerk/break-check/pull/35) [`01ed12d`](https://github.com/clerk/break-check/commit/01ed12d95e5d4a9e179ed6ab675afbcd13755138) Thanks [@jacekradko](https://github.com/jacekradko)! - Action: anchor the baseline on the PR's `base.sha`, not `base_ref`.

  The composite Action defaulted `base-ref` to `${{ github.base_ref }}` (a branch name) and then ran `git worktree add ... "origin/$BASE_REF"`. That checks out the _current tip_ of the base branch at the moment the workflow runs, not the commit the PR was actually opened against. When `main` advanced between the PR being opened and the check running, break-check diffed against a tree the PR author never saw, producing inverted or fabricated change reports.

  The default is now `${{ github.event.pull_request.base.sha || github.base_ref }}` and the fetch/worktree step checks out `FETCH_HEAD` so it works for both SHAs and branch names. The dogfood workflow (`.github/workflows/api-check.yml`) gets the same treatment.

  Fixes [#32](https://github.com/clerk/break-check/issues/32).

- [#43](https://github.com/clerk/break-check/pull/43) [`aa433ae`](https://github.com/clerk/break-check/commit/aa433ae78821569e741c5ea6803659164b445e30) Thanks [@jacekradko](https://github.com/jacekradko)! - Action: pin the "current" side of the diff to the PR head SHA, not the `refs/pull/N/merge` ref.

  The composite Action (and the dogfood workflow) built whatever the caller checked out as the "current" side. On `pull_request` events `actions/checkout` resolves `refs/pull/N/merge` by default: the PR head merged into the _moving_ tip of the base branch. Once the base branch advanced, that merged tree absorbed unrelated changes and break-check reported them as the PR's own, e.g. a phantom `configureSSOMobileNavbar` addition on a CI-only PR ([#32](https://github.com/clerk/break-check/issues/32)). Anchoring the baseline on `base.sha` was necessary but not sufficient; the current side floated too.

  The Action now takes a `head-ref` input (default `${{ github.event.pull_request.head.sha }}`), builds it in an isolated worktree symmetric with the baseline, and runs detect there. Non-PR events fall back to building the workspace. `.github/workflows/api-check.yml` gets the same treatment.

  Completes the fix for [#32](https://github.com/clerk/break-check/issues/32).

- [#30](https://github.com/clerk/break-check/pull/30) [`763ad1b`](https://github.com/clerk/break-check/commit/763ad1bb1da1da52fd8525a038405bb6ee1b7347) Thanks [@jacekradko](https://github.com/jacekradko)! - Keep PR comments under GitHub's 65 KB limit, and reject bogus `addition`
  verdicts from the AI reviewer.
  - Markdown reporter truncates oversized before/after snippets to head + tail
    and wraps them in a `<details>` block (`snippetMaxLines`, default 60).
  - Rule-based diff descriptions for changed type literals are summarized
    instead of repeating the full type body twice; the diff block already
    carries the detail.
  - AI reviewer now coerces an `addition` verdict to `non-breaking` when the
    rule-based pass flagged an in-place modification. `addition` is reserved
    for brand-new exports.

- [#58](https://github.com/clerk/break-check/pull/58) [`a0e406b`](https://github.com/clerk/break-check/commit/a0e406bd05231eba85bd5d0ad7974d9ba02d6ae2) Thanks [@jacekradko](https://github.com/jacekradko)! - Bump `@anthropic-ai/sdk` from 0.97.1 to 0.100.1. The intervening releases add `claude-opus-4-8`, mid-conversation system blocks, `usage.output_tokens_details`, and a few streaming fixes. break-check only touches the `Anthropic` constructor and `messages.create`, whose signatures are unchanged, so the AI reviewer's behavior is unaffected.

- [#55](https://github.com/clerk/break-check/pull/55) [`59f1c4f`](https://github.com/clerk/break-check/commit/59f1c4fcacdb99107ea164fc8770a944d48f16fb) Thanks [@jacekradko](https://github.com/jacekradko)! - Bump commander from 14 to 15. v15 is ESM-only and requires Node >=22.12; break-check is already ESM and pins Node >=22.13, so neither constraint tightens for consumers. The only behavioral change that touches our CLI is v15's `--no-*` handling, and it only affects options that define both a positive and negative form. `--no-ai` is a lone negative option, so it still defaults to `true` and the `options.ai === false` check is unchanged.

- [#54](https://github.com/clerk/break-check/pull/54) [`6d15131`](https://github.com/clerk/break-check/commit/6d15131d76542e5fffe46bc8ddab80eacedb1bf2) Thanks [@jacekradko](https://github.com/jacekradko)! - Stop publishing source maps. The build no longer emits `.js.map` or `.d.ts.map` files; they previously shipped in the package but pointed at `src/`, which is not included in the tarball, so they were dangling. The published package now contains only `.js` and `.d.ts`.

- [#70](https://github.com/clerk/break-check/pull/70) [`fe548ec`](https://github.com/clerk/break-check/commit/fe548ecd10c9495ed41d2b30ad77edb2cf2d00b2) Thanks [@jacekradko](https://github.com/jacekradko)! - Detect rest-parameter changes. API Extractor's `.api.json` does not emit an
  `isRest` flag, so the callable diff never saw rest-ness: turning `x: T[]` into
  `...x: T[]` (a breaking change) went unreported, and adding a `...rest`
  parameter was misclassified as a new required parameter. `isRest` is now
  recovered from the parameter excerpt, so rest-ness flips are flagged breaking
  and adding a rest parameter reads as a non-breaking optional add.

- [#45](https://github.com/clerk/break-check/pull/45) [`a4db93a`](https://github.com/clerk/break-check/commit/a4db93a68e43e45a71cc958cc4a722d91c5f62b2) Thanks [@jacekradko](https://github.com/jacekradko)! - Normalize equivalent import-reference notation in the static differ.

  API Extractor resolves a namespace-import alias (`_ns.Foo`) and an inline import type (`import("pkg").Foo`) to the same canonical reference, but emits whichever spelling the package's `.d.ts` build produced. The differ compared the raw token text, so a baseline and head built with different declaration strategies surfaced every imported type as a spurious breaking change. We now rewrite each resolved `Reference` token to a single `import("pkg").Name` spelling (dropping the redundant inline-import prefix) before diffing, so this class of false positive is caught in the static layer instead of relying on the AI reviewer.

  Fixes [#44](https://github.com/clerk/break-check/issues/44).

- [#5](https://github.com/clerk/break-check/pull/5) [`dcabe04`](https://github.com/clerk/break-check/commit/dcabe04ff57e36ff4212070e1630d9817d5a0e47) Thanks [@jacekradko](https://github.com/jacekradko)! - Add MIT LICENSE file and wire up the changesets release pipeline.

- [#8](https://github.com/clerk/break-check/pull/8) [`d6b71be`](https://github.com/clerk/break-check/commit/d6b71be966d68e454865ff9cc450dfe49abc2c4c) Thanks [@jacekradko](https://github.com/jacekradko)! - Stop API Extractor from writing a stray `<package>.api.md` file at the project root during `break-check snapshot`. The temp report folder now matches the configured report folder, so every generated file lives under the snapshot output directory.

- [#64](https://github.com/clerk/break-check/pull/64) [`02d5167`](https://github.com/clerk/break-check/commit/02d5167c667243a21de978e61038e9c0730a9d5c) Thanks [@jacekradko](https://github.com/jacekradko)! - Three hardening fixes from the pre-open-source sweep.
  - Entry-point discovery now refuses a `types`/`exports` path that resolves outside the package root, instead of pulling an out-of-package `.d.ts` into the snapshot, report, and AI payload. A package.json is attacker-controlled when the Action builds a PR, so this closes a path-traversal read (issue [#7](https://github.com/clerk/break-check/issues/7)).
  - The composite Action gains a `policy-mode` input. With it on, the Action enforces `break-check.config.json` from the base ref, so a PR can no longer suppress its own breaking change by editing its config (dropping the package, self-acknowledging, widening the ignore lists). Recommended when the Action is a required merge gate (issue [#1](https://github.com/clerk/break-check/issues/1)).
  - `break-check --version` now reports the installed version instead of a hardcoded `0.0.1`.

- [#3](https://github.com/clerk/break-check/pull/3) [`f86aaa9`](https://github.com/clerk/break-check/commit/f86aaa9519da57286e9608c581c60378a4a73aa3) Thanks [@jacekradko](https://github.com/jacekradko)! - Harden production usage by failing invalid snapshots, fixing config-relative baseline resolution, preserving snapshot metadata, and adding regression checks.

- [#29](https://github.com/clerk/break-check/pull/29) [`87362c1`](https://github.com/clerk/break-check/commit/87362c16e0178ca51286fd7ea775b1e28012c247) Thanks [@jacekradko](https://github.com/jacekradko)! - Markdown report now labels the rule-based description as **Static analyzer:** and re-labels the AI block by source (`AI review (reclassified as ...)`, `(confirmed)`, or `(additional finding)`) when the AI reviewer ran. Resolves the apparent contradiction when an AI verdict overrides the static analyzer (e.g. a "Breaking change in..." line rendered under a non-breaking heading).

- [#29](https://github.com/clerk/break-check/pull/29) [`87362c1`](https://github.com/clerk/break-check/commit/87362c16e0178ca51286fd7ea775b1e28012c247) Thanks [@jacekradko](https://github.com/jacekradko)! - Markdown report no longer renders `Version: X → X` when the PR hasn't bumped the version yet. Instead it shows `Current version: X` and projects the target on the recommended-bump line, e.g. `Recommended bump: MINOR → 4.14.0`. When the PR does bump, the existing `Version: X → Y` form is preserved.

- [#48](https://github.com/clerk/break-check/pull/48) [`952a4bb`](https://github.com/clerk/break-check/commit/952a4bb14533050b3a9e077e46528533eff87a6d) Thanks [@jacekradko](https://github.com/jacekradko)! - Reject baseline metadata entries whose `apiJsonFile`/`apiReportFile` are not
  plain, contained filenames. `detect` previously `path.join`ed these recorded
  names onto the package directory without validation, so a tampered or committed
  `break-check.snapshot.json` could traverse out (e.g. `../../`) and have an
  arbitrary file read into the diff or the AI surface payload. Such entries are
  now dropped. Also declares `publishConfig` (`access: public`, `provenance: true`)
  so npm publishing is explicit rather than relying on implicit defaults.

- [#62](https://github.com/clerk/break-check/pull/62) [`61b1f0d`](https://github.com/clerk/break-check/commit/61b1f0d66fdfa308ef13d1a4868552488b96f25f) Thanks [@jacekradko](https://github.com/jacekradko)! - Close fail-open and secret-exposure gaps in the Action and CI workflows.

  The Action's `has-breaking-changes` output is now derived from a JSON detect pass that fails closed: a swallowed non-zero exit or an unparseable report no longer defaults the flag to false and lets `fail-on-breaking` pass on a real break. The baseline-artifact lookup is bound to the PR's exact base SHA (`workflow_run.head_sha`) instead of the base branch name, so it cannot diff against a newer snapshot than the PR was opened against. And the nightly AI smoke workflow only exposes the Anthropic key on `main`, so a write-capable actor cannot dispatch a modified branch to read it.

- [#62](https://github.com/clerk/break-check/pull/62) [`61b1f0d`](https://github.com/clerk/break-check/commit/61b1f0d66fdfa308ef13d1a4868552488b96f25f) Thanks [@jacekradko](https://github.com/jacekradko)! - Fix three cases where detection could miss a breaking change or pass a scan it never actually ran.

  When every entry in the current build failed extraction, `detect` returned an empty result before recording the skips, so `--fail-on-skipped` saw nothing and the run reported "no changes" for a surface it never read. It now records the skipped entries (and fails when asked to). The rule-based diff keyed nested members by their immediate parent only, so `A.Inner.value` and `B.Inner.value` collided and one silently overwrote the other; the key now carries the full parent chain. And a reference to a dependency whose package root is export-blocked with `exports: { ".": null }` is no longer assumed resolvable (a top-level `exports: null` still falls back to legacy resolution, so it is left inconclusive rather than flagged).

- [#4](https://github.com/clerk/break-check/pull/4) [`92524c8`](https://github.com/clerk/break-check/commit/92524c8ea230c6bf18384a0117232a60324043aa) Thanks [@dependabot](https://github.com/apps/dependabot)! - Pin transitive ajv, lodash, and minimatch to versions that address recent advisories.

- [#62](https://github.com/clerk/break-check/pull/62) [`61b1f0d`](https://github.com/clerk/break-check/commit/61b1f0d66fdfa308ef13d1a4868552488b96f25f) Thanks [@jacekradko](https://github.com/jacekradko)! - Harden the markdown report and the AI audit against untrusted input.

  Package names, symbol names, descriptions, and AI rationales are now escaped before they enter the report (the Action posts it verbatim as a PR comment), so a crafted public API name can no longer forge a heading, table row, or link. A single very long declaration line is capped so it can't push the comment past GitHub's size limit, and the missed-breaks audit caps the API surface it sends rather than serializing an unbounded prompt. When that audit fails on an additions-only diff, or runs against a surface trimmed to fit the cap, the report now flags the partial coverage instead of claiming a complete review.

- [#31](https://github.com/clerk/break-check/pull/31) [`2479ffc`](https://github.com/clerk/break-check/commit/2479ffce1adb8ff5f1caf95509268774224c121d) Thanks [@jacekradko](https://github.com/jacekradko)! - Markdown reporter now renders before/after snippets as a unified diff anchored
  on the aligned common prefix and suffix, with a few lines of context and an
  elision marker for the unchanged bulk. Previously, large mostly-identical
  snippets were truncated head+tail on each side independently, which buried
  the actual change in the elided middle and produced ~120 lines of duplicate
  content for a 1-line edit. When the two sides share no structure, the
  reporter still falls back to per-side head+tail truncation.
