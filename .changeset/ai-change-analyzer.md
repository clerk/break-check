---
"@clerk/snapi": minor
---

Add opt-in AI-powered analysis of detected API changes. When `ANTHROPIC_API_KEY` is set, snapi sends each package's rule-based change list and a compact view of the baseline/current API surface to Anthropic's Claude. The model re-classifies changes (overriding the rule-based verdict in either direction, with rationale and migration guidance) and scans for breaks the rules missed. Failures fall back to rule-based output, so the CLI exit code never depends on AI availability. Configurable via a new `ai` block in `snapi.config.json` and the `--no-ai` / `--ai-model` CLI flags.
