---
"@clerk/break-check": minor
---

Add opt-in AI-powered analysis of detected API changes. When `BREAK_CHECK_ANTHROPIC_API_KEY` is set, break-check sends each package's rule-based change list and a compact view of the baseline/current API surface to Anthropic's Claude. The model re-classifies changes (overriding the rule-based verdict in either direction, with rationale and migration guidance) and scans for breaks the rules missed. Failures fall back to rule-based output, so the CLI exit code never depends on AI availability. By default the AI call is skipped for diffs that the rule-based pass classified as pure additions; set `BREAK_CHECK_AI_STRICT=1` (or `ai.strict: true` in config, or pass `--ai-strict`) to run the deeper scan in those cases too. Configurable via a new `ai` block in `break-check.config.json` and the `--no-ai` / `--ai-model` / `--ai-strict` CLI flags.
