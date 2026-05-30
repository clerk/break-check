---
"@clerk/break-check": patch
---

Reject baseline metadata entries whose `apiJsonFile`/`apiReportFile` are not
plain, contained filenames. `detect` previously `path.join`ed these recorded
names onto the package directory without validation, so a tampered or committed
`break-check.snapshot.json` could traverse out (e.g. `../../`) and have an
arbitrary file read into the diff or the AI surface payload. Such entries are
now dropped. Also declares `publishConfig` (`access: public`, `provenance: true`)
so npm publishing is explicit rather than relying on implicit defaults.
