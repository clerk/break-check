---
"@clerk/break-check": patch
---

Close fail-open and secret-exposure gaps in the Action and CI workflows.

The Action's `has-breaking-changes` output is now derived from a JSON detect pass that fails closed: a swallowed non-zero exit or an unparseable report no longer defaults the flag to false and lets `fail-on-breaking` pass on a real break. The baseline-artifact lookup is bound to the PR's exact base SHA (`workflow_run.head_sha`) instead of the base branch name, so it cannot diff against a newer snapshot than the PR was opened against. And the nightly AI smoke workflow only exposes the Anthropic key on `main`, so a write-capable actor cannot dispatch a modified branch to read it.
