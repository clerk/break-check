---
"@clerk/break-check": patch
---

Normalize equivalent import-reference notation in the static differ.

API Extractor resolves a namespace-import alias (`_ns.Foo`) and an inline import type (`import("pkg").Foo`) to the same canonical reference, but emits whichever spelling the package's `.d.ts` build produced. The differ compared the raw token text, so a baseline and head built with different declaration strategies surfaced every imported type as a spurious breaking change. We now rewrite each resolved `Reference` token to a single `import("pkg").Name` spelling (dropping the redundant inline-import prefix) before diffing, so this class of false positive is caught in the static layer instead of relying on the AI reviewer.

Fixes #44.
