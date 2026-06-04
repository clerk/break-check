---
"@clerk/break-check": patch
---

Fix three cases where detection could miss a breaking change or pass a scan it never actually ran.

When every entry in the current build failed extraction, `detect` returned an empty result before recording the skips, so `--fail-on-skipped` saw nothing and the run reported "no changes" for a surface it never read. It now records the skipped entries (and fails when asked to). The rule-based diff keyed nested members by their immediate parent only, so `A.Inner.value` and `B.Inner.value` collided and one silently overwrote the other; the key now carries the full parent chain. And a reference to a dependency whose package root is export-blocked (`exports: { ".": null }` or `exports: null`) is no longer assumed resolvable.
