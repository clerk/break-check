---
"@clerk/break-check": patch
---

Harden the markdown report and the AI audit against untrusted input.

Package names, symbol names, descriptions, and AI rationales are now escaped before they enter the report (the Action posts it verbatim as a PR comment), so a crafted public API name can no longer forge a heading, table row, or link. A single very long declaration line is capped so it can't push the comment past GitHub's size limit, and the missed-breaks audit caps the API surface it sends rather than serializing an unbounded prompt. When that audit fails on an additions-only diff, or runs against a surface trimmed to fit the cap, the report now flags the partial coverage instead of claiming a complete review.
