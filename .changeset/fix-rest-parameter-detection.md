---
"@clerk/break-check": patch
---

Detect rest-parameter changes. API Extractor's `.api.json` does not emit an
`isRest` flag, so the callable diff never saw rest-ness: turning `x: T[]` into
`...x: T[]` (a breaking change) went unreported, and adding a `...rest`
parameter was misclassified as a new required parameter. `isRest` is now
recovered from the parameter excerpt, so rest-ness flips are flagged breaking
and adding a rest parameter reads as a non-breaking optional add.
