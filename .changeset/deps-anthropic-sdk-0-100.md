---
"@clerk/break-check": patch
---

Bump `@anthropic-ai/sdk` from 0.97.1 to 0.100.1. The intervening releases add `claude-opus-4-8`, mid-conversation system blocks, `usage.output_tokens_details`, and a few streaming fixes. break-check only touches the `Anthropic` constructor and `messages.create`, whose signatures are unchanged, so the AI reviewer's behavior is unaffected.
