---
"@clerk/break-check": minor
---

The report's projected bump target now follows the same conventions bump
validation applies. A 0.x package with breaking changes projects the next
minor (`0.2.0 -> 0.3.0`) instead of suggesting a jump to `1.0.0`, with a note
explaining the 0.x convention (shown after the bump lands too, so
"Recommended: MAJOR / Actual: MINOR ✅" doesn't read as a contradiction). A
package on a prerelease tag projects the next tag in its train
(`1.0.0-beta.1 -> 1.0.0-beta.2`) instead of a whole-major jump. Adds
`VersionAnalyzer.nextPrereleaseVersion` to the programmatic API. The JSON
output is unchanged: `recommendedVersionBump` remains the severity label.
