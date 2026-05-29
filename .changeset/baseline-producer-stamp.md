---
"@clerk/break-check": minor
---

Snapshot metadata (`break-check.snapshot.json`) now records the producing `breakCheckVersion` and `apiExtractorVersion` under `schemaVersion: 3`. On `break-check detect`, a baseline whose recorded `@microsoft/api-extractor` major differs from the running one is refused with a structured error, since the hand-rolled `.api.json` reader is not guaranteed compatible across API Extractor majors and would otherwise produce silently nonsensical diffs. Pre-stamp baselines (schemaVersion 1 or 2) still load, with a stderr warning suggesting regeneration. `parseApiJson` also gained a shape check that throws on an unrecognized `.api.json` structure rather than returning an empty surface.
