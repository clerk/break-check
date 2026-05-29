---
"@clerk/break-check": minor
---

Add `BREAK_CHECK_AI_MODEL` environment variable for selecting the AI reviewer's model from CI without editing config. Priority is `--ai-model` > `BREAK_CHECK_AI_MODEL` > `ai.model` in `break-check.config.json` > `claude-sonnet-4-6`. The README now documents the AI reviewer's env vars, the `ai` config block, and when to opt into Opus 4.7.
