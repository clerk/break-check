---
"@clerk/break-check": patch
---

Stop reporting pure union/intersection member reorders as breaking changes
(#85). TypeScript emits inferred union members in an order keyed off an unstable
internal type-id table, so an unrelated edit could rotate the order and make the
differ report a phantom `Return type changed` on a symbol nobody touched. The
differ now canonicalizes member order before comparing types. This is a
compare-time-only change applied symmetrically to the baseline and current
reads, so committed baselines do not need to be regenerated. A genuine
add/remove of a member still reports correctly.
