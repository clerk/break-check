---
"@clerk/break-check": minor
---

Rework the AI reviewer around the downgrade decision and split the old `strict` flag into two orthogonal opt-ins.

The verdict call now sends a focused context instead of the whole API surface: for each change, only the definitions of the types its signature references (resolved transitively through API Extractor's canonical references), with a referenced type's baseline definition included where it changed so equivalence can be judged old-vs-new. On a large package that is a handful of types instead of hundreds of signatures. The change list is compact JSON and rationales are capped at one sentence.

Downgrades are no longer applied by default. A `breaking -> non-breaking` verdict is the only operation that can clear a flagged break, so by default it is recorded as a suggestion (the change stays breaking) and applied only with `--ai-apply-downgrades` / `BREAK_CHECK_AI_APPLY_DOWNGRADES` / `ai.applyDowngrades`. The default path therefore cannot turn a flagged break into a non-break, and if a referenced type can't be resolved the model is told to keep "breaking", so a thin context costs a missed downgrade (noise), never a shipped break.

The old `strict` flag is removed. Its missed-breaks audit (which sends both the baseline and current surfaces so the model can diff old vs new, and reviews additions-only diffs) is now its own opt-in: `--ai-scan` / `BREAK_CHECK_AI_SCAN` / `ai.scanForMissed`. Applying downgrades and running the audit are independent; combine them for the most thorough run.

Migration: `--ai-strict` and `ai.strict` no longer exist. The flag errors as an unknown option, and a config that still sets `ai.strict` now fails validation with an "unrecognized key" error (the `ai` block rejects unknown keys) instead of silently doing nothing. Replace it with `ai.scanForMissed: true` (the audit) and/or `ai.applyDowngrades: true` (relax verdicts).
