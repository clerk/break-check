---
---

Action-only: add a `report-artifact-name` input so the Action can run more
than once per workflow run (matrix / per-package jobs) without the report
uploads colliding on the fixed artifact name; a custom name also gives each
invocation its own PR comment. Also corrected the README claim that
`ai.applyDowngrades` is reviewed on the base branch; that requires
`policy-mode: true`, since detect reads the PR head's config by default.
