---
"@clerk/snapi": minor
---

Snapshot every subpath export, not just the package root. Snapi now walks the full `exports` map per package and produces one API snapshot per non-wildcard subpath (e.g. `@clerk/shared`'s `./react`, `./errors`, `./utils`, etc.). Wildcard patterns (`./*`, `./internal/foo/*`) are skipped with a warning since they're not single API surfaces. Each snapshot lives in `<safe-pkg>/<safe-pkg>__<subpath>.api.json` and a per-package `snapi.snapshot.json` (schema v2) lists every entry. Diffs report changes per subpath, including a synthesized BREAKING change when an entire subpath is removed. Old v1 baseline directories with a single root snapshot continue to read correctly during the transition. A new top-level `ignoreSubpaths: string[]` config option drops matching subpaths from discovery (exact match, e.g. `"./internal"`).
