---
---

Fix the Release workflow so it can actually open a Version Packages PR. The
changesets action invoked `pnpm version`, which runs pnpm's built-in version
command (requires a semver argument) instead of the `version` package.json
script. It now uses `pnpm run version` / `pnpm run release`. Tooling-only; no
published-package impact.
