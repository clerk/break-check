---
---

CI: enforce that every third-party GitHub Action is pinned to a full commit SHA.
Adds a `check-action-pins` script and a Lint job that fails any workflow or
action.yml change introducing a tag/branch ref. Tooling-only; no change to the
published package.
