---
"@clerk/break-check": minor
---

Skip reasons for subpaths API Extractor cannot snapshot are now classified
into actionable messages instead of echoing AE's raw InternalError text. An
ambient entry `.d.ts` (no top-level import or export) is reported as a surface
AE can never analyze, and an unresolvable type name in the shipped
declarations is reported as likely-broken published types; both point at
`ignoreSubpaths` as the acknowledgment path and keep the original AE first
line for traceability. Unrecognized messages pass through with only the
"software defect" boilerplate stripped.
