---
"@clerk/break-check": minor
---

Support package-scoped `ignoreSubpaths` entries. A bare entry still applies to every configured package; an entry prefixed with a package name and `#` (the `acknowledgedChanges` syntax, globs allowed on both sides) ignores the subpath only in matching packages, e.g. `"@clerk/astro#./env"` or `"@clerk/*#./internal"`. Skip-reason warnings for unsnapshotable subpaths now name the exact scoped entry to copy.
