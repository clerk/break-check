---
"@clerk/break-check": minor
---

Rename the package to `@clerk/break-check` and the CLI binary to `break-check`. The default config file is now `break-check.config.json` and per-package snapshot metadata is written as `break-check.snapshot.json`; the pre-rename `snapi.config.json` and `snapi.snapshot.json` are still read as deprecated fallbacks. Environment variables are renamed from `SNAPI_*` to `BREAK_CHECK_*`, and the GitHub Action's PR comment marker is now `break-check-action`.
