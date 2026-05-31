---
"@clerk/break-check": minor
---

Composite Action can now consume a baseline snapshot uploaded from a separate
push-to-main workflow, instead of always rebuilding the base ref. Set the new
`baseline-artifact-name` input to the artifact name; the Action downloads the
most recent matching artifact on `base-ref` and uses it as the baseline. Falls
back to the worktree rebuild on miss, expiry, or download failure, so existing
configurations keep working unchanged. Optional `baseline-max-age` (hours)
caps how old a downloaded artifact may be before falling back. See the
"Larger monorepos" section of the README for the producer workflow.
