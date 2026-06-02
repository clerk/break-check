---
"@clerk/break-check": minor
---

Trim the AI reviewer's prompt. The default review path now sends only the current API surface instead of dumping the full baseline and current surfaces on every call; the previous shape of each change is already inline in its diff snippet, which is all the model needs to confirm or downgrade the rule pass's verdict. The full baseline-vs-current surface and the open-ended "what did the rule pass miss?" scan now run only under `strict` / `--ai-strict`. The per-call change list is also sent as compact JSON, the redundant "known changes" summary is dropped from the verdict path, and rationales are capped at one sentence. On a typical small diff this roughly halves the per-package tokens, and an additions-only diff now makes zero API calls instead of one.

Safe in one direction only: the rule pass is already pessimistic (every type change is breaking) and the AI only ever downgrades, so leaner context can cost a downgrade (a noisier report) but can never turn a real break into a non-break. Use `strict` to restore the previous thorough behavior.
