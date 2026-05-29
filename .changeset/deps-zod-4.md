---
"@clerk/break-check": minor
---

**Breaking:** `ConfigSchema` is no longer exported from the package root. It was an internal validation detail used by `loadConfig`, and re-exporting it forced consumers to upgrade zod in lockstep whenever zod's `ZodObject`/`ZodArray`/`ZodEnum` generic shapes change (which is exactly what v3 → v4 just did, and what break-check's self-dogfood flagged). Use `BreakCheckConfig` (the inferred output type) instead; that export is unchanged.

Also bumps zod from 3 to 4.
