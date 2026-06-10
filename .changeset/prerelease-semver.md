---
"@clerk/break-check": minor
---

Version-bump validation now follows semver range semantics instead of raw
labels. A breaking change in a `0.x` package is satisfied by a minor bump
(`^0.2.3` ranges stop at the next minor, so that IS the breaking boundary);
previously every 0.x breaking change was flagged "insufficient" unless it went
to 1.0.0. An advance within one prerelease train (`1.0.0-beta.1 ->
1.0.0-beta.2`, or finalizing to `1.0.0`) is no longer reported as "version was
not bumped". `VersionAnalyzer.compareVersions` now honors prerelease
precedence per the semver spec (`1.0.0-beta.1` ranks below `1.0.0`), and a new
`VersionAnalyzer.isPrereleaseAdvance` is exported.

BREAKING (programmatic API only): `VersionAnalyzer.isPreRelease` and
`isValidPreReleaseBump` are renamed to `isZeroMajor` and
`isValidZeroMajorBump`. The old names conflated the 0.x convention with semver
prerelease tags, which this release starts handling as a distinct concept.
Per the 0.x rule above (which break-check now applies to itself), this rename
ships in a minor.
