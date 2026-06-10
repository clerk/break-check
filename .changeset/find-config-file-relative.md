---
"@clerk/break-check": patch
---

`findConfigFile` no longer hangs when called with a relative start directory.
The walk-up loop compared against `path.parse(startDir).root`, which is empty
for a relative path while `path.dirname` bottoms out at `"."`, so the loop
never terminated. The start directory is now resolved against cwd before
walking. The CLI always passed absolute paths, so this only affected
programmatic callers of the exported function.
