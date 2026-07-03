---
"@clerk/break-check": patch
---

Fix quote-blind whitespace normalization in the differ. The compare-time normalizer collapsed whitespace and stripped spacing around punctuation inside string and template literals too, so two types differing only in a literal's internal spacing (`'a | b'` vs `'a|b'`) compared equal and the change went unreported. Spacing is now normalized only outside quoted regions, in both the rule-based differ and the AI reviewer's surface lines. Compare-time only and symmetric across both reads, so committed baselines need no regeneration.
