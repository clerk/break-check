---
---

Fix the Break Check baseline workflow: upload-artifact@v4 skipped the
dot-prefixed `.api-baseline-main` directory as hidden, so the baseline
artifact was never produced. Add `include-hidden-files: true` (workflow and
README example). CI/docs only; no published package change.
