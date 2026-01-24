# @clerk/snapi

CLI tool to detect API breaking changes in TypeScript packages.

## Installation

```bash
# npm
npm install -D @clerk/snapi

# pnpm
pnpm add -D @clerk/snapi

# yarn
yarn add -D @clerk/snapi
```

## Quick Start

1. Initialize configuration:
   ```bash
   npx snapi init
   ```

2. Edit `snapi.config.json` to add your packages:
   ```json
   {
     "packages": ["packages/my-lib", "packages/my-other-lib"],
     "snapshotDir": ".api-snapshots",
     "mainBranch": "main"
   }
   ```

3. Generate baseline snapshot (from main branch):
   ```bash
   npx snapi snapshot
   ```

4. Make changes, then detect breaking changes:
   ```bash
   npx snapi detect --baseline .api-snapshots-baseline
   ```

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

### `snapi detect`

Detect breaking changes between baseline and current snapshots.

```bash
snapi detect [options]

Options:
  -c, --config <path>     Config file path (default: "snapi.config.json")
  -b, --baseline <path>   Baseline snapshots directory (required)
  -o, --output <path>     Output report path
  --format <format>       Output format: markdown|json (default: "markdown")
  --fail-on-breaking      Exit with code 1 if breaking changes found
  -v, --verbose           Show verbose output
```

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `packages` | string[] | required | Package paths to analyze |
| `snapshotDir` | string | `.api-snapshots` | Snapshot output directory |
| `mainBranch` | string | `main` | Base branch for comparison |
| `checkVersionBump` | boolean | `true` | Validate version bumps match changes |
| `outputFormat` | string | `markdown` | Report format |

## GitHub Actions Integration

```yaml
name: API Breaking Changes

on:
  pull_request:
    paths:
      - 'packages/**'

jobs:
  check-api:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: pnpm/action-setup@v2
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'pnpm'

      - run: pnpm install

      # Build packages (required for .d.ts files)
      - run: pnpm build

      # Generate baseline from main branch
      - name: Generate baseline
        run: |
          git stash --include-untracked
          git checkout origin/main
          pnpm install --frozen-lockfile
          pnpm build
          pnpm snapi snapshot --output .baseline
          git checkout -
          git stash pop || true

      # Generate current and compare
      - name: Detect changes
        run: pnpm snapi detect --baseline .baseline --output report.md --fail-on-breaking
        continue-on-error: true

      # Post PR comment
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

            const body = report;

            if (botComment) {
              await github.rest.issues.updateComment({
                owner: context.repo.owner,
                repo: context.repo.repo,
                comment_id: botComment.id,
                body,
              });
            } else {
              await github.rest.issues.createComment({
                owner: context.repo.owner,
                repo: context.repo.repo,
                issue_number: context.issue.number,
                body,
              });
            }
```

## Change Detection

snapi detects the following types of changes:

| Type | Severity | Examples |
|------|----------|----------|
| **Breaking** | Major | Removed exports, removed required parameters, narrowed types |
| **Non-breaking** | Minor | Added optional parameters, widened types |
| **Addition** | Minor | New exports, new optional members |

## License

MIT
