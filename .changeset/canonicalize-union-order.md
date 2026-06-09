---
"@clerk/break-check": patch
---

Stop reporting pure union/intersection member reorders as breaking changes
(#85). TS emits inferred union members in an unstable order, so an unrelated
edit could rotate them and trip a phantom `Return type changed`; the differ now
sorts members before comparing. Compare-time only, so committed baselines need
no regeneration.
