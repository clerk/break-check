# Contributing to Break Check

Thanks for your interest in contributing to `@clerk/break-check`. This guide
covers how to get set up, the conventions we follow, and how to get a change
merged.

By participating in this project you agree to abide by our
[Code of Conduct](./CODE_OF_CONDUCT.md).

## Before you start

For anything beyond a small fix, please open an issue first (a bug report or a
feature request) so we can align on scope before you write code. The
[roadmap in the README](../README.md#roadmap) lists work we already have in mind
and is a good place to find something to pick up.

## Prerequisites

- Node.js 22.13 or newer. The repo pins a version in [`.nvmrc`](../.nvmrc); run
  `nvm use` to match it.
- [pnpm](https://pnpm.io). The version is pinned via `packageManager` in
  `package.json`, so Corepack will select it automatically.

## Local setup

```bash
pnpm install
pnpm build      # compile src/ to dist/
pnpm test       # builds, then runs the test suite against dist/
```

Useful scripts:

| Command          | What it does                                                                  |
| ---------------- | ----------------------------------------------------------------------------- |
| `pnpm build`     | Type-check and emit `dist/`.                                                  |
| `pnpm dev`       | `tsc --watch` for tight iteration.                                            |
| `pnpm test`      | Build, then run `node --test` over `test/*.test.mjs`.                         |
| `pnpm typecheck` | `tsc --noEmit`.                                                               |
| `pnpm format`    | Format with Prettier.                                                         |
| `pnpm check`     | Format check, typecheck, test, and `pnpm pack --dry-run`. Run before pushing. |

The test suite imports the built `dist/`, so `pnpm test` always builds first. If
you are iterating, run `pnpm dev` in one shell and
`node --test test/<file>.test.mjs` in another.

For a deeper tour of the codebase (module layout, how the differ classifies
changes, the AI reviewer, the GitHub Action), read [AGENTS.md](../AGENTS.md). It
is the source of truth for how the internals fit together.

## Opening a pull request

1. Branch off `main`.
2. Make your change and add or update tests. If you change how a diff is
   classified, update the "Change Detection" table in the README too; it is the
   contract.
3. Run `pnpm check` and make sure it passes.
4. Add a changeset (see below).
5. Open the PR, fill out the template, and link the related issue.

Keep PRs focused on a single concern, and keep the description short and pointed
at the parts of the diff that need the most scrutiny.

### Changesets

Every PR that touches the published package needs a changeset:

```bash
pnpm changeset
```

Pick the bump level (patch, minor, or major) and write a short, user-facing
summary. For changes that do not affect the published package (CI, the GitHub
Action, docs, repo tooling), commit an empty changeset instead, a file under
`.changeset/` containing only empty front matter:

```
---
---
```

### Commit messages

We follow [Conventional Commits](https://www.conventionalcommits.org/): `feat:`,
`fix:`, `chore:`, `docs:`, `ci:`, `refactor:`, and so on. Use `feat!:` (or a
`BREAKING CHANGE:` footer) for breaking changes.

## Reporting security issues

Please do not report security vulnerabilities through public GitHub issues. See
our [Security Policy](./SECURITY.md) for how to report them privately.

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](../LICENSE).
