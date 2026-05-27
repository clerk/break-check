---
"@clerk/snapi": patch
---

Keep PR comments under GitHub's 65 KB limit, and reject bogus `addition`
verdicts from the AI reviewer.

- Markdown reporter truncates oversized before/after snippets to head + tail
  and wraps them in a `<details>` block (`snippetMaxLines`, default 60).
- Rule-based diff descriptions for changed type literals are summarized
  instead of repeating the full type body twice; the diff block already
  carries the detail.
- AI reviewer now coerces an `addition` verdict to `non-breaking` when the
  rule-based pass flagged an in-place modification. `addition` is reserved
  for brand-new exports.
