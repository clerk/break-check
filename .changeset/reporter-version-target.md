---
"@clerk/break-check": patch
---

Markdown report no longer renders `Version: X → X` when the PR hasn't bumped the version yet. Instead it shows `Current version: X` and projects the target on the recommended-bump line, e.g. `Recommended bump: MINOR → 4.14.0`. When the PR does bump, the existing `Version: X → Y` form is preserved.
