---
"@clerk/break-check": minor
---

Make the report breaking-first and stop silently trusting incomplete AI reviews.

A single AI review call that fails (the classic trigger: one huge type whose
before/after snippet dominated the request) used to leave every change in that
subpath with its pessimistic rule-based verdict and no annotation, while the
report still claimed full AI coverage. The analyzer now caps oversized
before/after snippets and bounds the focused-surface block by size so the call
fits, splits-and-retries a failed batch into smaller ones, and records any
review it still can't complete. Those gaps surface in the report: the "reviewed
by" stamp is marked `(partial)` and a callout lists the affected subpaths.

The report also leads with breaking changes: a breaking-changes index up front
(survives the size-budget truncation), packages and subpaths ordered
breaking-first, breaking sections never collapsed, and non-breaking sections
collapsed behind `<details>` in large reports.
