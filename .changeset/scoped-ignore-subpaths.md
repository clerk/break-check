---
"@clerk/break-check": minor
---

Support package-scoped `ignoreSubpaths` entries. A bare entry still applies to every configured package; an entry prefixed with a package name and `#` (the same separator `acknowledgedChanges` uses) ignores the subpath only in matching packages, e.g. `"@clerk/astro#./env"`. Globs are accepted on both sides (`"@clerk/*#./internal"`), which goes beyond `acknowledgedChanges`, whose package part is matched exactly. Skip-reason warnings for unsnapshotable subpaths now name the exact scoped entry to copy. Entries starting with `.` keep their historical meaning byte-for-byte; the only reinterpreted shape is a non-dot entry containing `#` (e.g. `**#./env`), which previously matched a literal `#` inside an exports key and is now read as a scoped entry.
