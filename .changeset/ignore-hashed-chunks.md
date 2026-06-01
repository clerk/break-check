---
"@clerk/break-check": minor
---

Stop reporting content-hashed bundler chunks under `"./*"` as breaking add/remove subpaths.

When a wildcard export globs into a bundler output dir, the shared chunks emitted by rolldown/tsdown/esbuild/rollup (`index-Dq-_K2VH.mjs`, `url-CcPzUbGM.mjs`, ...) were each turned into a public subpath by the #26 wildcard expansion. Those chunks are not public API and their content hash flips every build, so any real change renamed them and surfaced as a removed subpath (breaking) plus an added one, recommending a phantom major.

Wildcard expansion now drops matches whose basename ends in a high-entropy `-<8 base64url chars>` suffix, controlled by a new `ignoreHashedChunks` config field (on by default). The filter runs on both the current discovery and the baseline read, so an older baseline that recorded chunk subpaths reconciles without a forced regeneration (no `DISCOVERY_VERSION` bump). `ignoreSubpaths` now also accepts globs (`./internal-*`, `./chunk-*`) as the explicit escape hatch for anything the heuristic misses.

Fixes #49.
