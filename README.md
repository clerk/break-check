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

```yaml
name: API Breaking Changes

on:
  pull_request:
    paths:
      - "packages/**"

permissions:
  contents: read
  pull-requests: write

jobs:
  check-api:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: pnpm/action-setup@v4
        with:
          version: 10

      - uses: actions/setup-node@v4
        with:
          node-version: "24"
          cache: "pnpm"

      - run: pnpm install --frozen-lockfile

      - name: Generate baseline
        run: |
          git switch --detach origin/main
          pnpm install --frozen-lockfile
          pnpm build
          pnpm snapi snapshot --output .api-snapshots-baseline

      - name: Restore PR checkout
        run: |
          git switch --detach "$GITHUB_SHA"
          pnpm install --frozen-lockfile
          pnpm build

      - name: Detect API changes
        id: detect
        run: pnpm snapi detect --baseline .api-snapshots-baseline --output report.md --fail-on-breaking
        continue-on-error: true

      - name: Comment on PR
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            if (!fs.existsSync('report.md')) return;
            const report = fs.readFileSync('report.md', 'utf8');

            const { data: comments } = await github.rest.issues.listComments({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: context.issue.number,
            });

            const botComment = comments.find(c =>
              c.body.includes('API Changes Report')
            );

            if (botComment) {
              await github.rest.issues.updateComment({
                owner: context.repo.owner,
                repo: context.repo.repo,
                comment_id: botComment.id,
                body: report,
              });
            } else {
              await github.rest.issues.createComment({
                owner: context.repo.owner,
                repo: context.repo.repo,
                issue_number: context.issue.number,
                body: report,
              });
            }

      - name: Fail on breaking changes
        if: steps.detect.outcome == 'failure'
        run: exit 1
```

For larger monorepos, generate baseline snapshots on `main` and upload them as
artifacts. PR checks can then download the latest baseline artifact instead of
checking out and rebuilding `main`.

## Change Detection

snapi currently detects:

| Type         | Severity | Examples                                                     |
| ------------ | -------- | ------------------------------------------------------------ |
| Breaking     | Major    | Removed exports, removed required members, signature changes |
| Non-breaking | Minor    | Required members becoming optional                           |
| Addition     | Minor    | New exports, new members                                     |

The analyzer is conservative for signature modifications. It is useful as a CI
guardrail, but type-level widening and narrowing should be expanded before this
is treated as a complete semver oracle.

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
