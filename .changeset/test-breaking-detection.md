---
"@clerk/break-check": major
---

Test PR exercising the breaking-change detector against a real mix of API shape changes:

- `loadConfig(configPath?)` → `loadConfig(configPath)` (parameter is now required)
- `MarkdownReporter#generateJson` renamed to `MarkdownReporter#toJson`
- `getConfigDir` export removed (inlined into `resolvePackagePaths`)
- `findConfigFile(startDir?)` gains an optional `options?` parameter and a new `FindConfigFileOptions` type
- `DetectorOptions` gains an optional `silent?: boolean` field
