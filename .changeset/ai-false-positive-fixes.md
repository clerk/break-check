---
"@clerk/break-check": minor
---

Stop the AI reviewer confirming two backwards-compatible changes as breaking, and add a config escape hatch for the rest.

Adding an optional property (including one widened into a `Pick`/`Omit`) was confirmed breaking because the prompt never said it was safe and never forbade a verdict left conditional on a fact already in context. New classification rules fix that. Adding a required field to a read-only output type was confirmed breaking because the model only ever saw a type's forward references, never its callers, so it couldn't tell an input type from an output one. The focused verdict context now also carries a "Usage sites" block: the signatures that reference each changed type, gathered across the package's sibling subpath surfaces (the type and the function returning it usually live in different rollups). Both fixes only ever enable a downgrade, which still stays gated behind `--ai-apply-downgrades`.

New `acknowledgedChanges` config option: list a breaking change by name (`OAuthConsentInfo`, `@clerk/shared#OAuthConsentInfo`, or a `Clerk.__internal_*` glob) to downgrade it to non-breaking and tag it `acknowledged` in the report. Unlike an AI downgrade this is unconditional.

Fixes #56.
