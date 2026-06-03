---
"@clerk/break-check": minor
---

Stop the AI reviewer from downgrading a reference to an export-blocked dependency subpath.

When a bundler moves a re-exported type into an internal chunk the dependency blocks in its `exports` (e.g. `@clerk/shared` declares `"./_chunks/*": null`), a public `.d.ts` can emit `import("@clerk/shared/_chunks/index-DcO1-lAR").Jwt`. The structural shape is unchanged, but the specifier does not resolve for consumers: under `nodenext` it errors (`TS2307`), and with `skipLibCheck: true` it silently degrades to `any`. The rule pass flagged this breaking, but the AI reviewer downgraded it as a "build artifact rename", so with `--ai-apply-downgrades` it shipped green.

break-check now extracts the inline `import("...")` specifiers a new signature introduces (present in the after snippet, absent in the before) and classifies each against the target dependency's `package.json` `exports`: a subpath that resolves to `null`, or matches no key, is non-resolvable. When the dependency can't be located on disk it falls back to a `/_chunks/` and content-hash heuristic. A change carrying such a reference is pinned breaking and the AI may not relax it, even under `--ai-apply-downgrades`; the report shows a callout naming the specifier and drops the "re-run with --ai-apply-downgrades" nudge for it. The note bypasses break-check's own canonicalization, which discards the subpath before the diff or AI ever see it, so the signal is read from the raw `.d.ts` text.

New `resolvableSpecifiers` config option: specifier globs to exempt from the guard when a referenced subpath is a legitimate public entry point the heuristic mis-flags. An explicit `acknowledgedChanges` entry also clears it.

Fixes #60.
