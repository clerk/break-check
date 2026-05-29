---
"@clerk/break-check": minor
---

Rewrite the API diff analyzer to use structured comparison instead of joined-token string diffs. Parameter renames and whitespace differences no longer surface as breaking changes; optional/required parameter flips, added optional parameters, return-type changes, and property-type changes are now classified individually. Interface body edits are no longer double-counted at the container level.
