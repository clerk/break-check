---
"@clerk/break-check": patch
---

Three hardening fixes from the pre-open-source sweep.

- Entry-point discovery now refuses a `types`/`exports` path that resolves outside the package root, instead of pulling an out-of-package `.d.ts` into the snapshot, report, and AI payload. A package.json is attacker-controlled when the Action builds a PR, so this closes a path-traversal read (issue #7).
- The composite Action gains a `policy-mode` input. With it on, the Action enforces `break-check.config.json` from the base ref, so a PR can no longer suppress its own breaking change by editing its config (dropping the package, self-acknowledging, widening the ignore lists). Recommended when the Action is a required merge gate (issue #1).
- `break-check --version` now reports the installed version instead of a hardcoded `0.0.1`.
