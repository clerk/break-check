---
"@clerk/break-check": patch
---

Bump commander from 14 to 15. v15 is ESM-only and requires Node >=22.12; break-check is already ESM and pins Node >=22.13, so neither constraint tightens for consumers. The only behavioral change that touches our CLI is v15's `--no-*` handling, and it only affects options that define both a positive and negative form. `--no-ai` is a lone negative option, so it still defaults to `true` and the `options.ai === false` check is unchanged.
