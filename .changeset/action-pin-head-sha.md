---
"@clerk/break-check": patch
---

Action: pin the "current" side of the diff to the PR head SHA, not the `refs/pull/N/merge` ref.

The composite Action (and the dogfood workflow) built whatever the caller checked out as the "current" side. On `pull_request` events `actions/checkout` resolves `refs/pull/N/merge` by default: the PR head merged into the _moving_ tip of the base branch. Once the base branch advanced, that merged tree absorbed unrelated changes and break-check reported them as the PR's own, e.g. a phantom `configureSSOMobileNavbar` addition on a CI-only PR (#32). Anchoring the baseline on `base.sha` was necessary but not sufficient; the current side floated too.

The Action now takes a `head-ref` input (default `${{ github.event.pull_request.head.sha }}`), builds it in an isolated worktree symmetric with the baseline, and runs detect there. Non-PR events fall back to building the workspace. `.github/workflows/api-check.yml` gets the same treatment.

Completes the fix for #32.
