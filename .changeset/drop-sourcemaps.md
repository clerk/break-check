---
"@clerk/break-check": patch
---

Stop publishing source maps. The build no longer emits `.js.map` or `.d.ts.map` files; they previously shipped in the package but pointed at `src/`, which is not included in the tarball, so they were dangling. The published package now contains only `.js` and `.d.ts`.
