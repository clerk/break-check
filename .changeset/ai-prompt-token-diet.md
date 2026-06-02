---
"@clerk/break-check": minor
---

Trim the AI reviewer's prompt and tighten what the default path is allowed to do. The reviewer now ships only the current API surface (the previous shape of each change is already inline in its diff snippet), sends the change list as compact JSON, and caps rationales at one sentence. On a typical small diff that roughly halves the per-package tokens, and an additions-only diff makes zero API calls instead of one.

The default (lean) path is now conservative by construction: it confirms verdicts and may escalate a change to breaking, but it does not relax a flagged break to non-breaking. That downgrade, the AI's main value but also the only operation that can clear a real break, is applied only under `strict` / `--ai-strict`, where the model is also told to keep "breaking" for any type it cannot fully resolve. When the lean reviewer thinks a flagged break is safe, it records the suggestion in the report instead of applying it, so a human can re-run with `--ai-strict` to relax it. Strict additionally runs the missed-breaks audit and runs on additions-only diffs; both modes stay current-only.
