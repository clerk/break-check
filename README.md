```
┌─ break-check ───────────────────────────────────────────────────┐
│  - export function auth(o: Opts): Session                       │
│  + export function auth(o: Opts, ctx: Ctx): Session             │
│                                  ^^^^^^^^ required param added  │
│                                                                 │
│  verdict        BREAKING, major version bump required           │
│  your bump      1.4.2 -> 1.5.0   (insufficient)                 │
└─────────────────────────────────────────────────────────────────┘
```

# @clerk/break-check

[![npm](https://img.shields.io/npm/v/@clerk/break-check?style=flat-square&logo=npm&logoColor=white&label=npm&color=cb3837)](https://www.npmjs.com/package/@clerk/break-check)
[![CI](https://img.shields.io/github/actions/workflow/status/clerk/break-check/ci.yml?branch=main&style=flat-square&logo=githubactions&logoColor=white&label=CI)](https://github.com/clerk/break-check/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/@clerk/break-check?style=flat-square&logo=nodedotjs&logoColor=white&label=node&color=5fa04e)](https://github.com/clerk/break-check/blob/main/package.json)
[![license](https://img.shields.io/npm/l/@clerk/break-check?style=flat-square&label=license&color=64748b)](https://github.com/clerk/break-check/blob/main/LICENSE)

**Catch breaking TypeScript API changes before they ship.**

Break Check uses Microsoft API Extractor to snapshot public `.d.ts` surfaces,
then compares the current snapshot against a baseline. It is built for PR
checks: a package fails CI when a breaking API change is not matched by the
expected version bump.

## What it looks like

`break-check detect` writes a Markdown report, and the bundled Action posts it
straight into the pull request. A run that catches a break reads like this:

**🔴 API Changes Report** · reviewed by `claude-sonnet-4-6`

| Metric                  | Count |
| ----------------------- | ----- |
| Packages analyzed       | 1     |
| Packages with changes   | 1     |
| 🔴 Breaking changes     | 1     |
| 🟡 Non-breaking changes | 1     |
| 🟢 Additions            | 3     |

> **Warning:** 1 breaking change detected, major version bump required.

**`@acme/auth`** · current `1.4.2` · recommended **MAJOR → 2.0.0** · actual **MINOR ❌ (insufficient)**

```diff
- export function auth(o: Opts): Session
+ export function auth(o: Opts, ctx: Ctx): Session
```

> Added required parameter `ctx`; existing callers no longer compile.
> 🤖 **Confirmed breaking** (98%): the new required parameter forces every call site to change.

Non-breaking changes and additions are classified too (here, an optional param
on `configure` and three new exports); they collapse by default so the breaks
stay front and center.

## Requirements

- Node.js 22.13 or newer
- Packages must be built before snapshotting so their declaration files exist
- Each configured package must expose a declaration entrypoint through
  `types`, `typings`, root `exports["."].types`, `main` plus matching `.d.ts`,
  `dist/index.d.ts`, or root `index.d.ts`

## Installation

```bash
npm install -D @clerk/break-check
pnpm add -D @clerk/break-check
yarn add -D @clerk/break-check
```

## Quick Start

Create a config:

```bash
npx break-check init
```

Edit `break-check.config.json`:

```json
{
  "packages": ["packages/my-lib", "packages/my-other-lib"],
  "snapshotDir": ".api-snapshots",
  "mainBranch": "main",
  "checkVersionBump": true,
  "outputFormat": "markdown"
}
```

Generate a baseline from your main branch:

```bash
git switch main
pnpm build
npx break-check snapshot --output .api-snapshots-baseline
```

Compare the current branch against that baseline:

```bash
git switch -
pnpm build
npx break-check detect --baseline .api-snapshots-baseline --fail-on-breaking
```

Relative package, snapshot, and baseline paths are resolved from the directory
that contains `break-check.config.json`.

## CLI Commands

### `break-check init`

Create a default `break-check.config.json` configuration file.

```bash
break-check init [options]

Options:
  -o, --output <path>  Output path (default: "break-check.config.json")
  -f, --force          Overwrite existing config file
```

### `break-check snapshot`

Generate API snapshots for all configured packages.

```bash
break-check snapshot [options]

Options:
  -c, --config <path>  Config file path (default: "break-check.config.json")
  -o, --output <path>  Output directory (overrides config)
  -v, --verbose        Show verbose output
```

`snapshot` exits non-zero when a configured package cannot be analyzed.

### `break-check detect`

Detect API changes between baseline and current snapshots.

```bash
break-check detect [options]

Options:
  -c, --config <path>     Config file path (default: "break-check.config.json")
  -b, --baseline <path>   Baseline snapshots directory (required)
  -o, --output <path>     Output report path
  --format <format>       Output format: markdown|json
  --json-output <path>    Also write the JSON report here, alongside --output
  --fail-on-breaking      Exit with code 1 if breaking changes found
  --fail-on-skipped       Exit with code 1 if any subpath could not be snapshotted
  --no-ai                 Disable the AI reviewer even if BREAK_CHECK_ANTHROPIC_API_KEY is set
  --ai-model <model>      Override the AI model (e.g. claude-opus-4-7)
  --ai-apply-downgrades   Apply the AI's breaking->non-breaking downgrades (default: record as suggestions)
  --ai-scan               Run the missed-breaks audit (both surfaces; reviews additions-only diffs)
  -v, --verbose           Show verbose output
```

By default a subpath that API Extractor can't process (ambient-global
augmentations, a `.d.ts` outside `dist/`, etc.) is skipped with a warning and
the run continues; the report lists what was omitted. The same applies to a
subpath whose `exports` entry declares types break-check cannot resolve: a
missing declaration file, a target outside the package directory, or an
unsupported wildcard pattern. (Subpaths that declare no types at all, such as
JS-only or asset exports, have no type surface to check and are not flagged.)
Pass `--fail-on-skipped` (available on both `snapshot` and `detect`) to turn
those skips into a non-zero exit, which is the safer default when producing a
committed baseline.

Type declarations are discovered from each `exports` entry's conditions,
including nested condition objects (`{ "node": { "import": { "types": ... } } }`)
and `.d.ts`/`.d.mts`/`.d.cts` files. `detect` also refuses to run when
`--baseline` points at the configured `snapshotDir`, since regenerating the
current snapshots would overwrite the baseline and silently diff the build
against itself.

When `--format json` writes to stdout, progress and summary logs are written to
stderr so stdout remains parseable JSON.

`--json-output <path>` writes the JSON result to a file in addition to whatever
`--output`/`--format` produce, so a single run can emit both a human report and
a machine-readable verdict without running detection (and the AI reviewer) twice.

## Configuration

| Option                        | Type     | Default          | Description                                                                      |
| ----------------------------- | -------- | ---------------- | -------------------------------------------------------------------------------- |
| `packages`                    | string[] | required         | Package paths to analyze                                                         |
| `snapshotDir`                 | string   | `.api-snapshots` | Snapshot output directory                                                        |
| `mainBranch`                  | string   | `main`           | Base branch name for repo-specific workflows                                     |
| `checkVersionBump`            | boolean  | `true`           | Mark insufficient version bumps in reports                                       |
| `outputFormat`                | string   | `markdown`       | Default report format                                                            |
| `ignoreSubpaths`              | string[] | `[]`             | Subpath exports to skip (exact, or glob with `*`/`**`)                           |
| `ignoreHashedChunks`          | boolean  | `true`           | Drop content-hashed bundler chunks matched by `./*`                              |
| `acknowledgedChanges`         | string[] | `[]`             | Breaking changes you've verified safe (downgraded + tagged)                      |
| `resolvableSpecifiers`        | string[] | `[]`             | Module-specifier globs to exempt from the unresolvable-reference guard           |
| `downgradeRepairedReferences` | boolean  | `true`           | Report a blocked-to-exported specifier swap (a reference repair) as non-breaking |
| `ai`                          | object   | unset            | AI reviewer options (see below)                                                  |

Version-bump validation (`checkVersionBump`) compares the bump between the
baseline and current versions against the severity of the detected changes,
following semver range semantics rather than the raw labels:

- For a stable package (`>= 1.0.0`), a breaking change requires a major bump,
  and additions or non-breaking changes require at least a minor.
- For a `0.x` package, a breaking change is satisfied by a minor bump:
  `^0.2.3` ranges stop at the next minor, so `0.2.x -> 0.3.0` is the breaking
  boundary consumers actually experience. The convention is keyed off the
  baseline version.
- Moving forward within one prerelease train (`1.0.0-beta.1 -> 1.0.0-beta.2`,
  or finalizing to `1.0.0`) is never flagged as insufficient; shipping
  breaking changes between prereleases of the same version is what
  prereleases are for.

A `"./*"` export that points into a bundler output dir will glob in the shared
chunks emitted by rolldown/tsdown/esbuild/rollup (`index-Dq-_K2VH.mjs`,
`url-CcPzUbGM.mjs`, ...). Those chunks are not public API, and their content
hash changes every build, so left alone they show up as a removed subpath plus
an added subpath on every meaningful change. `ignoreHashedChunks` (on by
default) drops wildcard matches whose basename ends in a `-<8-char hash>`
suffix. For anything the heuristic misses, `ignoreSubpaths` accepts globs
(`./internal-*`, `./chunk-*`). Set `ignoreHashedChunks: false` to treat every
wildcard match as a real subpath.

`acknowledgedChanges` is the escape hatch for a change the differ flags as
breaking that you have verified is safe. Each entry is the change's qualified
name (`OAuthConsentInfo`, `User.email`), optionally prefixed with the package
(`@clerk/shared#OAuthConsentInfo`), and the name may use `*` globs
(`Clerk.__internal_*`). A matched breaking change is downgraded to non-breaking,
tagged `acknowledged` in the report, and dropped from the recommended version
bump. Unlike an AI downgrade this is unconditional: it always applies and does
not need `--ai-apply-downgrades`. Use it sparingly, and for one symbol at a time.

When a public signature starts referencing a dependency subpath consumers
cannot resolve, the change is breaking no matter how the underlying type looks.
This happens when a bundler moves a re-exported type into an internal chunk that
the dependency blocks in its `exports` (e.g. `@clerk/shared` declares
`"./_chunks/*": null`), so a `.d.ts` ends up emitting
`import("@clerk/shared/_chunks/index-DcO1-lAR").Jwt`. The specifier does not
resolve downstream: under `nodenext` it errors (`TS2307`), and with the common
`skipLibCheck: true` it silently degrades to `any`. break-check detects this by
extracting the inline `import("...")` specifiers a new signature introduces and
resolving each against the dependency's `package.json` `exports` (falling back
to a `/_chunks/` and content-hash heuristic when the dependency can't be located
on disk). A flagged change is kept breaking and the AI **cannot** relax it, even
under `--ai-apply-downgrades`. If a referenced subpath is in fact a legitimate
public entry point the heuristic mis-flags, exempt it with `resolvableSpecifiers`
(specifier globs, e.g. `@scope/pkg/internal/*`); an explicit `acknowledgedChanges`
entry also clears it. The guard applies to changed and removed exports, including
escalating an otherwise non-breaking modification (say a new optional parameter)
when its type is provably export-blocked. A brand-new export is still reported as
an addition, not a breaking change, even when its type is unresolvable.

The guard's inverse is a _repair_: the PR that fixes such a regression swaps the
blocked specifier back to a public subpath
(`import("@clerk/shared/_chunks/index-Cr_OtBLq").Xm` becomes
`import("@clerk/shared/types/utils").Without`). The raw text differs, so the
differ would flag it breaking, but the old reference was never consumable
downstream; nobody can be broken by fixing it. When every specifier a signature
drops is export-blocked (or chunk-shaped with the dependency unlocatable), every
specifier it introduces provably resolves against the dependency's `exports`,
and the signature is otherwise identical once the swapped `import("...").Name`
units are masked (the imported alias may change with the specifier; bundlers
minify chunk-internal names), the change is downgraded to non-breaking and
tagged as a repaired reference in the report. The downgrade is deterministic,
runs with or without the AI reviewer, and the AI cannot escalate it back.
Anything beyond the swap, an introduced specifier that does not provably
resolve, or a dropped specifier that was actually public fails the check and
the change stays breaking. Set `downgradeRepairedReferences: false` to opt out
(for example when `skipLibCheck` consumers who saw `any` must be treated as a
compatibility surface). Both directions surface their exports-map verdicts to
the AI reviewer, so it judges resolvability from resolved facts rather than
path shapes.

### AI reviewer config

| Field               | Type    | Default             | Description                                                                               |
| ------------------- | ------- | ------------------- | ----------------------------------------------------------------------------------------- |
| `enabled`           | boolean | unset               | Force-enable or force-disable. Unset: runs iff `BREAK_CHECK_ANTHROPIC_API_KEY` set        |
| `model`             | string  | `claude-sonnet-4-6` | Anthropic model identifier                                                                |
| `maxChangesPerCall` | number  | `80`                | Maximum rule-based changes batched into a single AI call                                  |
| `applyDowngrades`   | boolean | `false`             | Apply the AI's breaking->non-breaking downgrades instead of recording them as suggestions |
| `scanForMissed`     | boolean | `false`             | Run the missed-breaks audit (both surfaces; also reviews additions-only diffs)            |

## AI Review

Break Check can optionally route the rule-based diff through Claude for a second
opinion. By default the reviewer is conservative: it confirms the rule-based
verdicts, may **escalate** a change the rule pass under-classified (non-breaking
to breaking), and adds a one-sentence migration hint per breaking change. What
it will **not** do by default is **relax** a flagged break. Relaxing a breaking
verdict to non-breaking, walking back the rule pass's deliberately pessimistic
"any type change is breaking" stance, is the AI's main value but also the only
operation that can clear a real break, so by default it is recorded as a
suggestion in the report (the change stays breaking) and applied only when you
pass `--ai-apply-downgrades`. The default path therefore cannot turn a flagged
break into a non-break.

The downgrade decision is the flow worth getting right, so the verdict call
sends a **focused context**: for each change, only the definitions of the types
its signature references (resolved transitively through API Extractor's
canonical references), with a referenced type's baseline definition included
where it changed so equivalence can be judged old-vs-new. On a large package
that is a handful of types instead of the whole surface. The previous signature
of each change itself rides along inline in its diff snippet. The context also
lists each changed type's **usage sites**, the signatures that reference it,
gathered across the package's subpath surfaces (the changed type and the
function that returns it often live in different subpath rollups), so the model
can tell a consumer-constructed input type from a read-only output type: adding
a required field to a type consumers only read (the resolved value of a
`Promise<T>` return, a hook result field) is non-breaking, while adding it to a
type they construct is not. If a referenced type can't be resolved, or a type's
usage is invisible (used only by another package, or unresolved), the model is
told to keep "breaking", so a thin context costs a missed downgrade (noise),
never a shipped break.

`--ai-scan` (or `BREAK_CHECK_AI_SCAN=1`, `ai.scanForMissed: true`) adds the
opposite, paranoid pass: it ships both the baseline and current surfaces (the
model has to diff old against new to find a break the rule pass missed entirely)
and reviews additions-only diffs too. It is independent of
`--ai-apply-downgrades`; combine them for the most thorough run.

Enable it by exporting an API key:

```bash
export BREAK_CHECK_ANTHROPIC_API_KEY=sk-ant-...
npx break-check detect --baseline .api-snapshots-baseline --fail-on-breaking
```

The reviewer is fail-soft: if the API is unreachable, the key is missing while
`ai.enabled` is unset, or the model returns a malformed response, Break Check falls
back to the rule-based result and exits the same way it would without AI. A call
that fails on a large surface is retried in smaller batches first; anything still
unreviewed is reported as partial coverage (the "reviewed by" stamp is marked
`(partial)` and a callout lists the affected subpaths) rather than being silently
trusted, so those changes keep their pessimistic rule-based verdict.

### Picking a model

- **`claude-sonnet-4-6`** (default): the right balance for CI. Reliable
  tool-use output, cheap enough to run on every PR.
- **`claude-opus-4-7`**: better at the open-ended "what did the rule-based
  pass miss?" scan on large or variance-heavy API surfaces. Worth opting into
  for high-stakes releases.

Override per-invocation with `--ai-model claude-opus-4-7`, set
`BREAK_CHECK_AI_MODEL` in the environment (handy for CI, where you might want
Opus on release workflows and Sonnet on PRs without editing config), or
set it permanently in `break-check.config.json`:

```json
{
  "ai": {
    "model": "claude-opus-4-7",
    "applyDowngrades": false,
    "scanForMissed": false
  }
}
```

Priority is `--ai-model` > `BREAK_CHECK_AI_MODEL` > `ai.model` in config >
`claude-sonnet-4-6`.

### Environment variables

| Variable                          | Effect                                                                                                |
| --------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `BREAK_CHECK_ANTHROPIC_API_KEY`   | Anthropic API key. Required to enable the reviewer (unless `ai.enabled` is `false`).                  |
| `BREAK_CHECK_AI_MODEL`            | Override the model. Equivalent to `--ai-model`; loses to the flag, wins over config.                  |
| `BREAK_CHECK_AI_APPLY_DOWNGRADES` | Set to `1` (or any truthy value) to apply the AI's downgrades. Equivalent to `--ai-apply-downgrades`. |
| `BREAK_CHECK_AI_SCAN`             | Set to `1` (or any truthy value) to run the missed-breaks audit. Equivalent to `--ai-scan`.           |

## GitHub Actions Integration

Use the bundled composite Action. It snapshots the base ref and the PR head in
separate git worktrees, diffs them with `break-check detect`, and posts (or
updates) a single PR comment. Pinning both sides to commit SHAs (rather than the
`refs/pull/N/merge` ref `actions/checkout` resolves by default) keeps the report
scoped to the PR's own changes even after the base branch advances.

```yaml
name: API Check

on:
  pull_request:

permissions:
  contents: read
  pull-requests: write

jobs:
  api-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: pnpm/action-setup@v4

      - uses: actions/setup-node@v4
        with:
          node-version: "24"
          cache: "pnpm"

      - uses: clerk/break-check@v1
        with:
          fail-on-breaking: true
```

### Action inputs

| Input                    | Default                                        | Description                                                                                                                                                                              |
| ------------------------ | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config-path`            | `break-check.config.json`                      | Path to the config file, relative to the repo root.                                                                                                                                      |
| `base-ref`               | PR base SHA                                    | Git ref or SHA to snapshot as the baseline.                                                                                                                                              |
| `head-ref`               | PR head SHA                                    | Git ref or SHA to build as the "current" side. Pins the diff to the PR head, not the merge ref.                                                                                          |
| `setup-command`          | `pnpm install --frozen-lockfile && pnpm build` | Shell command run inside both the base checkout and the current checkout to produce `.d.ts` files.                                                                                       |
| `break-check-version`    | `latest`                                       | npm version of `@clerk/break-check` to fetch with `npx`.                                                                                                                                 |
| `baseline-artifact-name` | unset                                          | Name of a snapshot artifact uploaded from a push-to-`base-ref` workflow. See [Larger monorepos](#larger-monorepos).                                                                      |
| `baseline-max-age`       | unset                                          | Maximum age (hours) for a downloaded baseline artifact before falling back to a worktree rebuild.                                                                                        |
| `comment`                | `true`                                         | Post or update a PR comment with the report.                                                                                                                                             |
| `report-artifact-name`   | `break-check-report`                           | Name for the uploaded report artifact (and its PR comment). Give each invocation a distinct name when running more than once per workflow run.                                           |
| `fail-on-breaking`       | `false`                                        | Fail the workflow when breaking changes are detected.                                                                                                                                    |
| `policy-mode`            | `false`                                        | Enforce the config from the base ref so a PR cannot suppress its own break by editing its config.                                                                                        |
| `anthropic-api-key`      | unset                                          | Anthropic API key that enables the AI reviewer. Empty runs the rule-based diff only. Pass from a secret. The downgrade policy lives in `break-check.config.json` (`ai.applyDowngrades`). |
| `github-token`           | `${{ github.token }}`                          | Token used to read/write PR comments and (when `baseline-artifact-name` is set) fetch the artifact.                                                                                      |

### Action outputs

| Output                 | Description                                                    |
| ---------------------- | -------------------------------------------------------------- |
| `has-breaking-changes` | `"true"` if Break Check detected at least one breaking change. |
| `report-path`          | Filesystem path to the generated markdown report.              |

### AI review and the report comment

To enable the AI reviewer (see [AI Review](#ai-review)), pass an Anthropic key
from a secret:

```yaml
- uses: clerk/break-check@v1
  with:
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

The key only turns the reviewer on. The downgrade policy stays in
`break-check.config.json` (`ai.applyDowngrades`) rather than being set per
workflow, so it is code-reviewed like any other file; note that by default
`detect` reads the PR head's config, so a PR can still flip it for its own run.
Set `policy-mode: true` (see
[Required-gate hardening](#required-gate-hardening)) to enforce the base ref's
config instead. The Action runs `detect` once and renders
both the comment and the `has-breaking-changes` output from that single result,
so the AI is never billed twice and the comment can't disagree with the output.
On pull requests from forks GitHub withholds secrets, so `anthropic-api-key` is
empty there and the reviewer stays off; the rule-based diff still runs.

The Action posts (or updates) one comment per invocation. A report larger than
GitHub's comment-size limit is truncated, with the full report attached as the
`report-artifact-name` artifact (default `break-check-report`) and linked from
the comment. The comment is posted even when `fail-on-breaking` fails the run,
so a blocked PR still shows why. Artifact names are immutable and global to a
workflow run, so when the Action runs more than once per run (a matrix, or
per-package jobs) give each invocation a distinct `report-artifact-name`, e.g.
`break-check-report-${{ matrix.package }}`; each then maintains its own PR
comment too.

### When the base ref doesn't yet have a config

On the first PR that introduces Break Check, the base ref won't contain a
`break-check.config.json` and the snapshot would otherwise fail. The Action copies
the PR's config into the base checkout in that case so the first run still
produces a usable baseline. Subsequent runs always use the base ref's own
config.

### Required-gate hardening

The `break-check.config.json` lives in the repo, so a pull request can edit its
own config the same way it edits any other file: drop the changed package from
`packages`, add an `acknowledgedChanges` entry, or widen `ignoreSubpaths` /
`resolvableSpecifiers`. Any of those greens the PR's own breaking change. That is
acceptable when the config is itself reviewed (for example under CODEOWNERS), but
if you rely on this Action as a required merge gate, set `policy-mode: true`:

```yaml
- uses: clerk/break-check@v1
  with:
    fail-on-breaking: true
    policy-mode: true
```

In policy mode the Action reads `break-check.config.json` from the base ref
before running the diff, so a config change takes effect only once it has landed
on the base branch and passed that branch's review. A base ref that has no config
yet (the first PR introducing Break Check) falls back to the PR's config.

### Larger monorepos

Rebuilding `main` on every PR is too slow for large monorepos. Instead, snapshot
`main` once per push and have PR checks download the artifact.

**Producer** (`.github/workflows/break-check-baseline.yml`):

```yaml
name: Break Check baseline

on:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  snapshot:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "24"
          cache: "pnpm"
      - run: pnpm install --frozen-lockfile && pnpm build
      - run: npx @clerk/break-check snapshot --output .api-baseline-main
      - uses: actions/upload-artifact@v4
        with:
          name: break-check-baseline-main
          path: .api-baseline-main
          retention-days: 30
          if-no-files-found: error
          # .api-baseline-main is dot-prefixed; upload-artifact@v4 treats it as
          # a hidden directory and skips it without this flag.
          include-hidden-files: true
```

**Consumer** (PR check): point the Action at the artifact name.

```yaml
- uses: clerk/break-check@v1
  with:
    baseline-artifact-name: break-check-baseline-main
    fail-on-breaking: true
```

The Action looks up the most recent non-expired artifact with that name on
`base-ref`, downloads it, and uses it directly. If no artifact is found, it's
expired, or it's older than `baseline-max-age` (when set), the Action falls
back to the worktree rebuild. The fallback also covers the first PR after
adding break-check, before the producer has run.

Workflow runs that download the artifact need `actions:read` on
`github-token`; the default `github.token` has it. Pin the break-check version
identically in producer and consumer if you want to guarantee snapshot
compatibility.

## Change Detection

Break Check classifies each diff as one of three types.

| Type         | Severity | What it covers                                                                                                                                                                                                                                            |
| ------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Breaking     | Major    | Removed exports or members; required parameter added; optional parameter or property made required; a parameter's rest-ness changed; parameter or property type changed; return type changed; a member's `static`/`protected`/`abstract` modifier changed |
| Non-breaking | Minor    | Optional parameter added; rest parameter added; required parameter or property made optional; a type change whose only diff is swapping an unresolvable specifier for an exported one (a reference repair, see Configuration)                             |
| Addition     | Minor    | New exports, new interface/class members                                                                                                                                                                                                                  |

The analyzer compares parameters, return types, property types, and enum values
structurally. Overloaded functions and methods are compared per overload
signature, matched by declaration order: removing or editing an overload is
breaking, and a new trailing overload is an addition. The following are
deliberately **not** flagged:

- whitespace or formatting differences in declarations
- parameter renames where the type and optionality are unchanged
- container-level diffs that are already explained by their member-level diffs
  (e.g., adding a property to an interface produces one addition, not an
  addition plus an interface modification)
- equivalent import-reference notation: a namespace-import alias (`_ns.Foo`)
  and an inline import type (`import("pkg").Foo`) resolve to the same type, so
  the difference in spelling (which depends on how a package builds its
  `.d.ts`) is normalized away before diffing

What Break Check does **not** yet do:

- type variance: any parameter, property, or return-type change is treated as
  breaking, even when the new type is strictly wider. Widening (e.g.,
  `string` → `string | number` on a return type) is technically non-breaking
  but is reported as breaking today.
- generic-parameter changes are detected as text differences only; adding,
  removing, or constraining a type parameter is not classified.
- TSDoc-only changes are ignored, which is the intended behavior.

## Roadmap

Near-term, in rough priority order:

- **Type variance awareness.** Stop classifying strictly-widening type
  changes as breaking. Return type `string` → `string | number`, parameter
  type `string` → `unknown`, and similar should be non-breaking; only
  narrowing should be.
- **Generic-parameter analysis.** Today generics are detected as text
  diffs only. Classify adding, removing, reordering, or constraining
  type parameters with the same rigor as regular parameters.
- **Structural-equivalence pass for unions and discriminated unions.**
  The rule-based diff currently flags reorderings and equivalent
  rewrites as breaking; the AI reviewer can catch these but we want
  the rule pass to handle the obvious cases on its own.
- **Richer report output.** Group changes by package and by entrypoint
  in the markdown report, and include a stable JSON schema version so
  downstream tooling can depend on the output shape.

Longer-term ideas (less committed):

- A `break-check explain <symbol>` command that prints the before/after rollup
  for a single export, for use during code review.
- Per-package severity overrides in `break-check.config.json` (e.g. treat
  internal packages as non-breaking by default).
- Pluggable analyzers so consumers can add project-specific rules
  (deprecation policies, naming conventions) without forking.

If you want to pick one up, open an issue first so we can align on
scope before you start.

## Troubleshooting

### No TypeScript declarations found

Build the package first and confirm `package.json` points to a real `.d.ts`
entrypoint.

### Baseline directory not found

Generate the baseline first, or pass an absolute path to `--baseline`.
Relative baseline paths are resolved from the config directory.

### API Extractor failed

Run with `--verbose` to see API Extractor diagnostics:

```bash
break-check snapshot --verbose
```

## License

MIT
