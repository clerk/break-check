---
"@clerk/snapi": minor
---

Stop reporting coverage/discovery growth as phantom API additions, and bound
the total report size.

When an already-baselined package gained subpaths (a coverage bump, a genuine
new export, or a discovery change such as wildcard subpath expansion), `detect`
diffed each new subpath against an empty baseline and emitted one addition per
exported member. On `@clerk/shared` that meant a ~440 KB report claiming
thousands of additions, none of them real API changes, which then exceeded
GitHub's 65 KB comment limit and failed to post. Three fixes:

- A current subpath with no baseline entry in an already-baselined package is
  now collapsed to a single "New subpath export" addition instead of one per
  member (symmetric with the existing subpath-removal handling). Brand-new
  packages still stay silent on first run.
- Snapshot metadata records a new `discoveryVersion` (`schemaVersion: 4`).
  `detect` refuses a baseline whose discovery version is older than the running
  snapi, and refuses a producer-stamped baseline that predates the field, with
  the same "regenerate against the base ref" error the API Extractor major gate
  uses. snapi's Action regenerates the baseline every run, so it is unaffected;
  consumers caching a baseline across a snapi upgrade must regenerate once.
- The markdown reporter now enforces a total-size budget (`maxReportChars`,
  default 60,000): whole package sections are included until the budget is
  reached, then the remainder is dropped with a notice pointing at the full
  JSON report, so an oversized diff still posts a valid comment.

Fixes #40.
