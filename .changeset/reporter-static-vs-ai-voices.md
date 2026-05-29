---
"@clerk/break-check": patch
---

Markdown report now labels the rule-based description as **Static analyzer:** and re-labels the AI block by source (`AI review (reclassified as ...)`, `(confirmed)`, or `(additional finding)`) when the AI reviewer ran. Resolves the apparent contradiction when an AI verdict overrides the static analyzer (e.g. a "Breaking change in..." line rendered under a non-breaking heading).
