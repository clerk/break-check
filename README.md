# @clerk/snapi

CLI tool for detecting TypeScript API changes in packages that publish
declaration files.

snapi uses Microsoft API Extractor to snapshot public `.d.ts` surfaces, then
compares a current snapshot against a baseline snapshot. It is designed for PR
checks where a package should fail CI when a breaking API change is not matched
by the expected version bump.

## Requirements

- Node.js 20 or newer
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
  -v, --verbose           Show verbose output
```

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
