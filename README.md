# @clerk/snapi

CLI tool for detecting TypeScript API changes in packages that publish
declaration files.

snapi uses Microsoft API Extractor to snapshot public `.d.ts` surfaces, then
compares a current snapshot against a baseline snapshot. It is designed for PR
checks where a package should fail CI when a breaking API change is not matched
by the expected version bump.

## Requirements

- Node.js 22.13 or newer
- Packages must be built before snapshotting so their declaration files exist
- Each configured package must expose a declaration entrypoint through
  `types`, `typings`, root `exports["."].types`, `main` plus matching `.d.ts`,
  `dist/index.d.ts`, or root `index.d.ts`

## Installation

```bash
npm install -D @clerk/snapi
pnpm add -D @clerk/snapi
yarn add -D @clerk/snapi
```

## Quick Start

Create a config:

```bash
npx snapi init
```

Edit `snapi.config.json`:

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
npx snapi snapshot --output .api-snapshots-baseline
```

Compare the current branch against that baseline:

```bash
git switch -
pnpm build
npx snapi detect --baseline .api-snapshots-baseline --fail-on-breaking
```

Relative package, snapshot, and baseline paths are resolved from the directory
that contains `snapi.config.json`.

## CLI Commands

### `snapi init`

Create a default `snapi.config.json` configuration file.

```bash
snapi init [options]

Options:
  -o, --output <path>  Output path (default: "snapi.config.json")
  -f, --force          Overwrite existing config file
```

### `snapi snapshot`

Generate API snapshots for all configured packages.

```bash
snapi snapshot [options]

Options:
  -c, --config <path>  Config file path (default: "snapi.config.json")
  -o, --output <path>  Output directory (overrides config)
  -v, --verbose        Show verbose output
```

`snapshot` exits non-zero when a configured package cannot be analyzed.

### `snapi detect`

Detect API changes between baseline and current snapshots.

```bash
snapi detect [options]

Options:
  -c, --config <path>     Config file path (default: "snapi.config.json")
  -b, --baseline <path>   Baseline snapshots directory (required)
  -o, --output <path>     Output report path
  --format <format>       Output format: markdown|json
  --fail-on-breaking      Exit with code 1 if breaking changes found
  --fail-on-skipped       Exit with code 1 if any subpath could not be snapshotted
  --no-ai                 Disable the AI reviewer even if SNAPI_ANTHROPIC_API_KEY is set
  --ai-model <model>      Override the AI model (e.g. claude-opus-4-7)
  --ai-strict             Run the AI reviewer even when only additions are detected
  -v, --verbose           Show verbose output
```

By default a subpath that API Extractor can't process (ambient-global
augmentations, a `.d.ts` outside `dist/`, etc.) is skipped with a warning and
the run continues; the report lists what was omitted. Pass `--fail-on-skipped`
(available on both `snapshot` and `detect`) to turn those skips into a non-zero
exit, which is the safer default when producing a committed baseline.

When `--format json` writes to stdout, progress and summary logs are written to
stderr so stdout remains parseable JSON.

## Configuration

| Option             | Type     | Default          | Description                                  |
| ------------------ | -------- | ---------------- | -------------------------------------------- |
| `packages`         | string[] | required         | Package paths to analyze                     |
| `snapshotDir`      | string   | `.api-snapshots` | Snapshot output directory                    |
| `mainBranch`       | string   | `main`           | Base branch name for repo-specific workflows |
| `checkVersionBump` | boolean  | `true`           | Mark insufficient version bumps in reports   |
| `outputFormat`     | string   | `markdown`       | Default report format                        |
| `ignoreSubpaths`   | string[] | `[]`             | Subpath exports to skip during discovery     |
| `ai`               | object   | unset            | AI reviewer options (see below)              |

### AI reviewer config

| Field               | Type    | Default             | Description                                                                  |
| ------------------- | ------- | ------------------- | ---------------------------------------------------------------------------- |
| `enabled`           | boolean | unset               | Force-enable or force-disable. Unset: runs iff `SNAPI_ANTHROPIC_API_KEY` set |
| `model`             | string  | `claude-sonnet-4-6` | Anthropic model identifier                                                   |
| `maxChangesPerCall` | number  | `80`                | Maximum rule-based changes batched into a single AI call                     |
| `strict`            | boolean | `false`             | Run the reviewer even when only additions are detected                       |

## AI Review

snapi can optionally route the rule-based diff through Claude for a second
opinion. The reviewer confirms or overrides each rule-based classification,
adds a one-sentence migration hint per breaking change, and scans the full
API surface for breaks the rule-based pass missed (e.g., type variance,
discriminated-union changes, structural-equivalence cases the rule pass treats
as breaking but aren't).

Enable it by exporting an API key:

```bash
export SNAPI_ANTHROPIC_API_KEY=sk-ant-...
npx snapi detect --baseline .api-snapshots-baseline --fail-on-breaking
```

The reviewer is fail-soft: if the API is unreachable, the key is missing while
`ai.enabled` is unset, or the model returns a malformed response, snapi falls
back to the rule-based result and exits the same way it would without AI.

### Picking a model

- **`claude-sonnet-4-6`** (default): the right balance for CI. Reliable
  tool-use output, cheap enough to run on every PR.
- **`claude-opus-4-7`**: better at the open-ended "what did the rule-based
  pass miss?" scan on large or variance-heavy API surfaces. Worth opting into
  for high-stakes releases.

Override per-invocation with `--ai-model claude-opus-4-7`, set
`SNAPI_AI_MODEL` in the environment (handy for CI, where you might want
Opus on release workflows and Sonnet on PRs without editing config), or
set it permanently in `snapi.config.json`:

```json
{
  "ai": {
    "model": "claude-opus-4-7",
    "strict": false
  }
}
```

Priority is `--ai-model` > `SNAPI_AI_MODEL` > `ai.model` in config >
`claude-sonnet-4-6`.

### Environment variables

| Variable                  | Effect                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------ |
| `SNAPI_ANTHROPIC_API_KEY` | Anthropic API key. Required to enable the reviewer (unless `ai.enabled` is `false`). |
| `SNAPI_AI_MODEL`          | Override the model. Equivalent to `--ai-model`; loses to the flag, wins over config. |
| `SNAPI_AI_STRICT`         | Set to `1` (or any truthy value) to run the reviewer even on pure-additions diffs.   |

## GitHub Actions Integration

> **Status: preview.** The composite Action ships from this repo but is not
> usable yet. It depends on `@clerk/snapi` being available on the npm
> registry (which the `npx` step fetches at runtime) and on a `v1` tag
> existing in this repo. Neither is true today. The Action becomes usable
> with the first stable release; until then, copy the workflow from
> `.github/workflows/api-check.yml` as a starting point.

Use the bundled composite Action. It snapshots the base ref in a temporary
git worktree, builds the PR, runs `snapi detect`, and posts (or updates) a
single PR comment.

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

      - uses: clerk/snapi@v1
        with:
          fail-on-breaking: true
```

### Action inputs

| Input              | Default                                        | Description                                                                                        |
| ------------------ | ---------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `config-path`      | `snapi.config.json`                            | Path to the config file, relative to the repo root.                                                |
| `base-ref`         | `${{ github.base_ref }}`                       | Git ref to snapshot as the baseline.                                                               |
| `setup-command`    | `pnpm install --frozen-lockfile && pnpm build` | Shell command run inside both the base checkout and the current checkout to produce `.d.ts` files. |
| `snapi-version`    | `latest`                                       | npm version of `@clerk/snapi` to fetch with `npx`.                                                 |
| `comment`          | `true`                                         | Post or update a PR comment with the report.                                                       |
| `fail-on-breaking` | `false`                                        | Fail the workflow when breaking changes are detected.                                              |
| `github-token`     | `${{ github.token }}`                          | Token used to read/write PR comments.                                                              |

### Action outputs

| Output                 | Description                                              |
| ---------------------- | -------------------------------------------------------- |
| `has-breaking-changes` | `"true"` if snapi detected at least one breaking change. |
| `report-path`          | Filesystem path to the generated markdown report.        |

### When the base ref doesn't yet have a config

On the first PR that introduces snapi, the base ref won't contain a
`snapi.config.json` and the snapshot would otherwise fail. The Action copies
the PR's config into the base checkout in that case so the first run still
produces a usable baseline. Subsequent runs always use the base ref's own
config.

### Larger monorepos

For larger monorepos, generate baseline snapshots on `main` and upload them as
artifacts. PR checks can then download the latest baseline artifact instead of
checking out and rebuilding `main`. The Action does not (yet) cover this
pattern out of the box; fall back to the CLI directly when you need it.

## Change Detection

snapi classifies each diff as one of three types.

| Type         | Severity | What it covers                                                                                                                                              |
| ------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Breaking     | Major    | Removed exports or members; required parameter added; optional parameter or property made required; parameter or property type changed; return type changed |
| Non-breaking | Minor    | Optional parameter added; required parameter or property made optional                                                                                      |
| Addition     | Minor    | New exports, new interface/class members                                                                                                                    |

The analyzer compares parameters, return types, property types, and enum values
structurally. The following are deliberately **not** flagged:

- whitespace or formatting differences in declarations
- parameter renames where the type and optionality are unchanged
- container-level diffs that are already explained by their member-level diffs
  (e.g., adding a property to an interface produces one addition, not an
  addition plus an interface modification)

What snapi does **not** yet do:

- type variance: any parameter, property, or return-type change is treated as
  breaking, even when the new type is strictly wider. Widening (e.g.,
  `string` → `string | number` on a return type) is technically non-breaking
  but is reported as breaking today.
- generic-parameter changes are detected as text differences only; adding,
  removing, or constraining a type parameter is not classified.
- TSDoc-only changes are ignored, which is the intended behavior.

## Roadmap

Near-term, in rough priority order:

- **First stable release.** Publish `@clerk/snapi` to npm and cut a `v1`
  tag so the bundled GitHub Action becomes usable without copying the
  workflow by hand.
- **Type variance awareness.** Stop classifying strictly-widening type
  changes as breaking. Return type `string` → `string | number`, parameter
  type `string` → `unknown`, and similar should be non-breaking; only
  narrowing should be.
- **Generic-parameter analysis.** Today generics are detected as text
  diffs only. Classify adding, removing, reordering, or constraining
  type parameters with the same rigor as regular parameters.
- **Action support for monorepo baselines.** Add a first-class path
  in the composite Action for downloading the latest baseline artifact
  uploaded from `main`, instead of checking out and rebuilding the base
  ref on every PR.
- **Structural-equivalence pass for unions and discriminated unions.**
  The rule-based diff currently flags reorderings and equivalent
  rewrites as breaking; the AI reviewer can catch these but we want
  the rule pass to handle the obvious cases on its own.
- **Richer report output.** Group changes by package and by entrypoint
  in the markdown report, and include a stable JSON schema version so
  downstream tooling can depend on the output shape.

Longer-term ideas (less committed):

- A `snapi explain <symbol>` command that prints the before/after rollup
  for a single export, for use during code review.
- Per-package severity overrides in `snapi.config.json` (e.g. treat
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
snapi snapshot --verbose
```

## License

MIT
