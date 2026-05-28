---
"@clerk/snapi": patch
---

Action: anchor the baseline on the PR's `base.sha`, not `base_ref`.

The composite Action defaulted `base-ref` to `${{ github.base_ref }}` (a branch name) and then ran `git worktree add ... "origin/$BASE_REF"`. That checks out the _current tip_ of the base branch at the moment the workflow runs, not the commit the PR was actually opened against. When `main` advanced between the PR being opened and the check running, snapi diffed against a tree the PR author never saw, producing inverted or fabricated change reports.

The default is now `${{ github.event.pull_request.base.sha || github.base_ref }}` and the fetch/worktree step checks out `FETCH_HEAD` so it works for both SHAs and branch names. The dogfood workflow (`.github/workflows/api-check.yml`) gets the same treatment.

Fixes #32.
