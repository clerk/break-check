---
"@clerk/break-check": patch
---

Stop API Extractor from writing a stray `<package>.api.md` file at the project root during `break-check snapshot`. The temp report folder now matches the configured report folder, so every generated file lives under the snapshot output directory.
