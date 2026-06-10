---
"@clerk/break-check": minor
---

A reference _repair_ is now reported non-breaking (issue #98). When a breaking
modification's only diff is swapping module specifiers consumers could not
resolve (export-blocked, e.g. `@clerk/shared/_chunks/index-Cr_OtBLq` under
`"./_chunks/*": null`, or chunk-shaped with the dependency unlocatable) for
specifiers that provably resolve against the dependency's `exports`, the change
is deterministically downgraded and tagged as a repaired reference in the
report. The old reference errored (TS2307) or degraded to `any` downstream, so
fixing it cannot break anyone. The check is fail-closed: any difference beyond
the specifier/alias swap, or an introduced specifier that does not provably
resolve, keeps the change breaking. Opt out with
`downgradeRepairedReferences: false`.

The AI reviewer now also receives deterministic exports-map verdicts
(`referenceResolutions`) for every specifier a signature drops or introduces,
instead of guessing resolvability from path shapes, and cannot escalate a
deterministically repaired change back to breaking (recorded as
`ai-suggested-escalation`, mirroring the downgrade refusal for unresolvable
references).
