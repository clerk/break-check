---
"@clerk/break-check": patch
---

The GitHub Action gains an `anthropic-api-key` input to enable the AI reviewer, and `detect` gains `--json-output` so the Action runs detect once instead of twice. Oversized PR comments are truncated with the full report attached as the `break-check-report` artifact. Requires `break-check-version` >= 0.1.1.
