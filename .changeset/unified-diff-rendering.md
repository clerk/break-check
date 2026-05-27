---
"@clerk/snapi": patch
---

Markdown reporter now renders before/after snippets as a unified diff anchored
on the aligned common prefix and suffix, with a few lines of context and an
elision marker for the unchanged bulk. Previously, large mostly-identical
snippets were truncated head+tail on each side independently, which buried
the actual change in the elided middle and produced ~120 lines of duplicate
content for a 1-line edit. When the two sides share no structure, the
reporter still falls back to per-side head+tail truncation.
