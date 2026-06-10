---
"@clerk/break-check": patch
---

Stop under-reporting surface break-check never actually checked. Entry-point
discovery now resolves types declared under nested export conditions
(`{ "node": { "import": { "types": ... } } }`) and `.d.cts` files, both
previously skipped without a trace. A subpath that declares types break-check
still cannot resolve (a missing file, a target escaping the package, an
unsupported wildcard pattern) is now recorded as a skipped entry, so it shows
up in the report and `--fail-on-skipped` catches it; JS-only and asset subpaths
stay silent. And `detect` now refuses a `--baseline` that resolves to the
configured `snapshotDir`, which previously overwrote the baseline with the
current snapshots and reported "no changes" for any break.
