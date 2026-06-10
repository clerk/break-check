---
"@clerk/break-check": patch
---

Fix a family of false negatives in the rule-based differ. Overload signatures
now carry their `overloadIndex` in the comparison key, so removing or editing a
function or method overload (or one of several call/construct/index signatures)
is reported instead of silently collapsing onto the last overload. An
optionality flip no longer short-circuits the member compare, so a change like
`a: string` -> `a?: number` reports the breaking type change instead of a
non-breaking "became optional"; property and variable types are now compared
via their kind-specific token ranges (`propertyTypeTokenRange`,
`variableTypeTokenRange`) instead of the full declaration text. And
`static`/`protected`/`abstract` modifier flips are compared explicitly, which
also catches them on methods and classes where the signature compare never saw
them. All fixes are compare-time only; committed baselines need no
regeneration.
