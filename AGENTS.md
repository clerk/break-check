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
  `ignoreSubpaths` is glob-aware and optionally package-scoped
  (`makeScopedSubpathMatcher`): a bare entry (anything not shaped
  `pkg#subpath`, including glob forms like `**`) applies to every configured
  package, while `@clerk/astro#./env` pins one package using the
  `acknowledgedChanges` `#` separator. Globs work on both sides here, which
  goes beyond `acknowledgedChanges` (its package part is exact-match). It is
  the explicit escape hatch for anything the heuristic misses, applied at the
  same two symmetric sites as the chunk filter; skip-reason guidance emits the
  exact scoped entry to copy. `makeSubpathMatcher` (unscoped) remains for
  `resolvableSpecifiers`.
- **Type variance is intentionally pessimistic**: any type change is
  flagged as breaking, even when the new type is strictly wider. The
  AI reviewer is currently the only thing that can downgrade those.
  This is documented in the README; don't "fix" it silently.
- **Union/intersection member order is canonicalized at compare time.** TS
  emits inferred union members in an order keyed off an unstable internal
  type-id table, so an unrelated edit rotates the order and the raw string
  compare reads a pure reorder as a breaking `Return type changed` (issue #85).
  `canonicalizeType` (`utils/canonicalize-type.ts`) sorts top-level
  union/intersection members (recursing into brackets) before comparison. It is
  the final step of `api-diff.ts#normalizeType`, so every structural compare
  (returnType, param, property, enum initializer, opaque signature) and the
  snippet fallback inherit it; the AI missed-breaks audit applies it too
  (`ai-analyzer.ts#extractSurface`, `normalizeExcerpt`) so its own surface diff
  can't re-flag a reorder. It is **reorder + exact-dedup only**, never semantic
  normalization (preserving the pessimistic stance above), and **fail-closed**:
  a function type (`=>`), a conditional (`extends ? :`), or any malformed string
  is returned unchanged, so a bug can at worst leave a phantom break, never hide
  a real one. It is compare-time only and applied symmetrically to both reads,
  so it needs no snapshot/`schemaVersion`/`DISCOVERY_VERSION` bump and an old
  baseline that recorded the other order reconciles without regeneration.
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
- **The verdict call ships a focused context, not the whole surface.**
  `buildFocusedSurfaceBlock` resolves, per change, the type definitions its
  signature references (transitively, via API Extractor `canonicalReference`
  tokens, capped at `MAX_FOCUSED_SYMBOLS`), including a referenced type's
  baseline definition where it changed. The changed members are not re-emitted;
  their before/after signatures ride inline in the compact-JSON review list.
  Unresolvable references are dropped, and system-prompt rule 8 tells the model
  to keep "breaking" when it cannot resolve a type, so a thin context fails
  safe. `submit_review` asks for one-sentence rationales, and the surface only
  takes a prompt-cache breakpoint when more than one chunk will read it. The
  missed-breaks audit is the exception: to find a break the rule pass didn't
  flag at all it must diff old against new itself, so it sends both the baseline
  and current full surfaces (`buildAuditSurfaceBlock`), not the focused set.
  The focused context also carries a **"Usage sites"** block: for each changed
  named type, the signatures that reference it (`collectUsageSites`), so the
  model can judge input vs output direction (adding a required field to a
  read-only output type is non-breaking; system-prompt rule 11). Referrers are
  gathered across the package's OTHER subpath surfaces too, threaded in via
  `AiPackageContext.siblingCurrentApiJsonPaths` from `detector.ts` (a changed
  type and the function returning it frequently live in different subpath
  rollups, and the analyzer otherwise sees one subpath at a time). Matching is
  by `canonicalReference`, which is stable across rollups; an unresolved/diverging
  ref just yields fewer usage sites, which fails safe (rule 11 keeps "breaking"
  when no usage sites are shown). Usage sites are collected BEFORE the
  empty-forward-refs early return, since a `type R = {...}` with no references
  can still have usage sites. `walkSurface` is memoized by path+mtime
  (`walkSurfaceCached`) so the per-subpath calls don't re-parse the same sibling
  `.api.json` repeatedly. Note `walkSurface` indexes every
  member under BOTH its full-chain name and api-diff's immediate-parent name
  (`Inner.a` as well as `Outer.Inner.a`), because the rule-based differ names a
  change by its immediate parent only; without that alias a namespace-nested
  change would seed an empty closure. Keep both keys. It also keeps `allNodes`
  (a flat list) so `collectUsageSites` can scan referrers including members
  without a `canonicalReference`.
- **Two orthogonal opt-ins, both default off; the default cannot clear a
  break.** `applyDowngrades` decides whether a `breaking -> non-breaking`
  verdict (the only one that can hide a break) is acted on or recorded as an
  `ai-suggested-downgrade` (change stays breaking, report points the user at
  `--ai-apply-downgrades`). `scanForMissed` runs the audit and reviews
  additions-only diffs. Both are resolved in `detector.ts` (`resolveAiFlag`:
  option > env > config) and threaded into the analyzer. Keep them separate:
  one relaxes verdicts (lenient, risky), the other hunts for more breaks
  (paranoid, safe), so a single flag for both is wrong. Escalations
  (`-> breaking`) and confirmations always apply. An additions-only diff makes
  zero API calls unless `scanForMissed` is on.
- **`acknowledgedChanges` is a config-level override, not an AI knob.**
  `makeAcknowledgedMatcher` (`utils/acknowledged.ts`) compiles the config
  patterns (`"<name>"` or `"<packageName>#<name>"`, `*` glob in the name part,
  reusing `globToRegExpSource`). `detector.ts#analyzePackage` applies it as a
  final pass over the assembled `allChanges`, flipping any matched `breaking`
  change to `non-breaking` (recording `ruleBasedType`, setting
  `acknowledged: true`). It runs whether or not the AI is on, after the AI, so
  the maintainer's override always wins; it is unconditional (not gated behind
  `--ai-apply-downgrades`). Counts, `hasBreakingChanges`, and the recommended
  bump all key off `type`, so the flip is sufficient. The markdown reporter tags
  acknowledged changes and suppresses the "re-run with --ai-apply-downgrades"
  nudge for them.
- **The unresolvable-reference guard is a deterministic, AI-proof escalation
  in the opposite direction.** When a change's new signature references a
  dependency subpath consumers can't resolve (export-blocked or an internal
  bundler chunk, e.g. `@clerk/shared/_chunks/index-DcO1-lAR` under
  `"./_chunks/*": null`), the change is breaking regardless of structural shape:
  downstream it errors (`TS2307`) or degrades to `any` (`skipLibCheck`). This is
  the false-negative from issue #60. Note `api-diff.ts#canonicalType` strips the
  subpath from a _resolved_ reference and an _unresolvable_ one carries no
  `canonicalReference` at all, so the signal survives ONLY in the raw
  `afterSnippet` text, never the canonical comparison type. `utils/exports-resolution.ts`
  extracts the inline `import("...")` specifiers a signature newly introduces
  (present in `afterSnippet`, absent in `beforeSnippet`) and classifies each:
  `isSubpathExported` resolves it against the dependency's `package.json`
  `exports` (exact key, single-`*` wildcard longest-prefix-wins, `null` =
  blocked), located by walking up `node_modules` from `packageInfo.path`; when
  the dependency can't be located it falls back to `looksLikeInternalChunk`
  (a `/_chunks/` segment or `isHashedChunkSubpath` basename), reported as a
  non-deterministic hit. `detector.ts#flagUnresolvableReferences` runs BEFORE the
  AI over every non-addition change: a change the rule pass already flagged
  `breaking` is marked `unresolvableReference` (either a deterministic block or
  the heuristic qualifies, since marking an already-breaking change only prevents
  a relaxation, never invents a break); a `non-breaking` modification is escalated
  to breaking ONLY on a deterministic `exports` block (e.g. a newly-added optional
  param whose type lives in a blocked subpath), never on the heuristic, so a
  chunk-shaped name can't manufacture a break. The `ai-analyzer.ts` downgrade
  branch then refuses to apply a downgrade for a flagged change even when
  `applyDowngrades` is on (it records the model's opinion as a non-applied
  suggestion); system-prompt rule 12 also tells the model not to downgrade such
  refs. The reporter shows a `⛔` callout naming the specifier and suppresses the
  `--ai-apply-downgrades` nudge for it. `acknowledgedChanges` still wins (it runs
  after and can clear it); `resolvableSpecifiers` (glob-aware, via
  `makeSubpathMatcher`) is the per-specifier escape hatch. Keep `unresolvableReference`
  OUT of `generateChangeId`. SCOPE: the guard inspects emitted breaking /
  non-breaking changes, not brand-new exports (an addition referencing a blocked
  subpath is reported as an addition; a new unusable export is not a "breaking"
  change and shouldn't force a major). The reported issue #60 transition
  (resolvable subpath -> blocked chunk) is fully caught even when the exported
  symbol name is preserved: a blocked reference carries no `canonicalReference`,
  so `canonicalType` leaves its raw chunk path in the comparison string and the
  diff fires. The only case `canonicalType` collapses to nothing is a
  resolvable-chunk -> resolvable-chunk move, which is benign (a resolvable chunk
  is importable by consumers).
- **The repair downgrade is the guard's deterministic inverse (issue #98).**
  When a breaking modification's only diff is swapping unconsumable specifiers
  for exported ones, `detector.ts#applyReferenceRepairs` (running right after
  `flagUnresolvableReferences`, before the AI) flips it to non-breaking and
  records `repairedReference: { from, to }`. The gate is
  `findRepairedReference` (`utils/exports-resolution.ts`): every removed
  specifier must classify `blocked` deterministically, or `unknown` +
  chunk-shaped + `packageNotFound` (a LOCATED dependency without an `exports`
  map never qualifies: legacy resolution serves every file, so the chunk may
  genuinely have resolved), and must not match `resolvableSpecifiers`; every
  introduced specifier must be a bare specifier classified `exported`
  DETERMINISTICALLY against the dependency's actual `exports` map (the
  downgrade clears a break, so nothing else may vouch for the after side;
  note `classifyReference` calls a relative/absolute/malformed specifier
  "exported" for the guard's fail-safe direction, which is why the repair
  pass uses `classifyTransition`'s richer verdicts, not `classifyReference`);
  and the snippets must be identical after masking each swapped
  `import("spec").Name` unit (the alias name may change with the specifier,
  bundlers minify chunk-internal names; only the first member access is
  masked, deeper chains must still match). Anything else fails the masked
  compare and stays breaking, fail-closed. A change the unresolvable guard
  flagged is never downgraded; `downgradeRepairedReferences: false` is the
  config opt-out. The AI cannot escalate a repaired change: the analyzer
  records the refused verdict as `ai-suggested-escalation`, mirroring the
  downgrade refusal for `unresolvableReference`. The same pass attaches
  `referenceResolutions` (per-specifier exports-map verdicts, both sides) to
  any change whose specifier sets differ, regardless of repair outcome or the
  toggle; the per-change review JSON ships them and system-prompt rules 12/13
  tell the model to trust those verdicts over path shapes. Keep
  `repairedReference` and `referenceResolutions` OUT of `generateChangeId`.
- **The absorbing-arm downgrade clears suggestion-only union changes (issue
  #114).** A union carrying `string & {}` / `string & Record<never, never>`
  (or the `number` equivalents) accepts every value of that primitive; its
  literal/template-literal arms only drive editor autocomplete (the
  `Autocomplete`/`LiteralUnion` idiom), and the AI tends to CONFIRM the rule
  pass's breaking verdict for them, which `--ai-apply-downgrades` cannot relax.
  `detector.ts#applyAbsorbingArmDowngrades` (right after `applyReferenceRepairs`,
  before the AI) downgrades a breaking `category: "type"` modification when
  `findAbsorbingArmEquivalence` (`utils/union-absorption.ts`) proves both sides
  are unions with an IDENTICAL absorbing arm and every changed arm is a subtype
  of the primitive (literals, template literals, unions/intersections/
  conditionals thereof, or same-report alias references, depth-capped). The
  changed alias's RHS is usually an unexpanded application (`Autocomplete<X>`)
  of UNEXPORTED aliases, which the `.api.json` doc model omits entirely, so the
  resolver parses each side's `.api.md` API report (forgotten exports appear
  there verbatim); a legacy baseline without a stored report never downgrades.
  Each side resolves against its own report, so a changed `Autocomplete`
  definition diverges the expansions and fails the match. Everything is
  fail-closed: reserved-name shadowing (a surface importing or declaring
  `Record`, a type param named `Record`), substitution into arms with unquoted
  `:`/`=>`/braces, bindings with depth-0 `|`/`&` spliced into non-bare arms,
  and unchanged arms that neither prove subtype on BOTH sides nor are
  reference-free keywords all keep the change breaking (byte-identity of a
  named reference proves nothing; the name could re-bind between versions).
  `unresolvableReference` wins over it; the AI records but cannot apply an
  escalation (mirroring `repairedReference`); system-prompt rule 14 teaches
  the idiom and the marker; `acknowledgedChanges` still applies. Keep
  `absorbingArmUnion` OUT of `generateChangeId`. Opt out with
  `downgradeAbsorbingArmUnions: false`.
- **Action depends on the published package**: the composite Action's `npx`
  step fetches `@clerk/break-check` from npm at runtime, so consumers pin the
  repo's moving `v1` tag (`clerk/break-check@v1`). Keep the README's Actions
  section in sync if this changes.

## Release flow

1. Land PRs with changesets.
2. The release workflow (see `.github/workflows/`) opens a "Version
   Packages" PR. Merging it tags and publishes via
   `pnpm release` (which runs `changeset publish`).
3. After publishing, the release workflow force-moves the `v1` tag to the
   release commit so `clerk/break-check@v1` tracks the latest. `v1` names the
   Action's INTERFACE major, decoupled from the npm version; if action.yml's
   inputs/outputs ever change incompatibly, freeze the tag step at the last
   compatible commit and push `v2` instead.
