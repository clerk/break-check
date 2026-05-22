# Changesets

This directory contains [changesets](https://github.com/changesets/changesets), which describe changes to be released.

## Adding a changeset

```bash
pnpm changeset
```

Pick the bump level (`patch`, `minor`, or `major`) and write a short description aimed at consumers. Commit the generated file with your PR.

## What happens on merge

When changesets land on `main`, the release workflow opens (or updates) a "Version Packages" PR that bumps `package.json` and rewrites `CHANGELOG.md`. Merging that PR publishes to npm.

## Empty changesets

For changes that do not affect published output (CI tweaks, docs, tooling), create an empty changeset so the PR check passes:

```
---
---
```
