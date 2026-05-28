---
"@clerk/snapi": minor
---

Expand wildcard subpath exports (e.g. `"./*": "./dist/runtime/*.d.mts"`) instead of silently skipping them.

Packages like `@clerk/shared` expose most of their public surface through a single wildcard subpath. snapi was dropping every wildcard key in `findEntryPoints` and only logging it at verbose level, so breaking changes under `@clerk/shared/file`, `@clerk/shared/url`, etc. never showed up in reports.

The discovery layer now globs the wildcard's value against the package directory, derives the captured portion of each match, and substitutes it back into the key pattern to synthesize one concrete `PackageEntry` per file (single-segment `*` only; multi-segment nested wildcards remain unhandled and skip silently). Concrete keys still win over wildcard-expanded ones if both produce the same subpath. Both the wildcard key itself and individual expanded subpaths can still be excluded via `ignoreSubpaths`.

Fixes #26.
