---
"@clerk/snapi": minor
---

Make per-entry extraction failures non-fatal.

Previously, a single subpath that API Extractor couldn't process (ambient-global augmentations like `@clerk/testing/cypress`, root-level `.d.ts` files like `@clerk/astro/env`, anything that triggered an `InternalError` from AE) tanked the entire `snapshot` or `detect` run. Common Cypress, Playwright, and Astro patterns made snapi unusable on real monorepos.

Per-entry failures now emit a `[snapi] warning: skipping <pkg> <subpath>: <reason>` line on stderr, are collected on the detector (`detector.lastSkippedEntries`), and surface in the detect report as a "could not snapshot N subpaths" callout above the diff so reviewers don't mistake an omitted surface for a clean one. The run continues with whatever extracted. Package-level fatals (missing `package.json`, zero discoverable entries) still throw, since those usually mean the config is wrong rather than one subpath is weird.

`AnalysisResult` gains an optional `skippedEntries` array (`{ packageName, subpath, reason }[]`); JSON consumers can read it directly. Both `snapshot` and `detect` accept `--fail-on-skipped`, which turns any skip back into a non-zero exit, the safer setting when producing a committed baseline where a silently-omitted surface would otherwise read as "no changes."

Fixes #34 (ambient-global crash on `@clerk/testing/cypress`).
Fixes #33 (`Unable to determine module` crash on `@clerk/astro/env`).
