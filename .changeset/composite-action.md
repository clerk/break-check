---
"@clerk/snapi": minor
---

Ship a reusable GitHub Action. Consumers can replace a hand-rolled snapshot/detect/comment workflow with `uses: clerk/snapi@v1` after their checkout/node/pnpm setup. The Action uses a git worktree for the baseline (so the PR checkout is never disturbed), runs `snapi` via `pnpm dlx`, and posts (or updates) a single PR comment with the report. Inputs cover the config path, base ref, setup command, snapi version, comment toggle, and `fail-on-breaking`; outputs expose `has-breaking-changes` and the report path.
