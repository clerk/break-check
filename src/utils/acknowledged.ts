/**
 * Matcher for the `acknowledgedChanges` config allowlist.
 *
 * A maintainer lists changes they have verified as safe; a breaking change that
 * matches is flipped to non-breaking (see `detector.ts`). Each pattern is
 * `"<name>"` or `"<packageName>#<name>"`, where `<name>` is the change's
 * qualified name and may use `*` globs. The package part, when present, is
 * matched exactly against the package name.
 */

import { ApiChange } from "../types.js";
import { globToRegExpSource } from "./api-extractor.js";

interface AckPattern {
  /** Package name to match exactly, or null for "any package". */
  packageName: string | null;
  /** Predicate over a change's qualified name (exact string or compiled glob). */
  matchesName: (name: string) => boolean;
}

/**
 * Compile the name part of a pattern. A part without `*` matches the change
 * name exactly; a part with `*` is compiled to a regex where `*` matches any
 * run of characters within the name (change names carry no `/`, so the
 * single-segment glob is the right granularity for `Clerk.__internal_*`).
 */
function compileNameMatcher(name: string): (n: string) => boolean {
  if (!name.includes("*")) {
    return (n) => n === name;
  }
  const re = new RegExp(`^${globToRegExpSource(name)}$`);
  return (n) => re.test(n);
}

/**
 * Build a predicate that tests whether a change has been acknowledged in
 * config. An empty list never matches. Blank entries are ignored.
 */
export function makeAcknowledgedMatcher(
  patterns: string[],
): (packageName: string, change: ApiChange) => boolean {
  const compiled: AckPattern[] = [];
  for (const raw of patterns) {
    const pattern = raw.trim();
    if (!pattern) continue;
    const hash = pattern.indexOf("#");
    if (hash === -1) {
      compiled.push({
        packageName: null,
        matchesName: compileNameMatcher(pattern),
      });
      continue;
    }
    const pkg = pattern.slice(0, hash);
    const name = pattern.slice(hash + 1);
    compiled.push({
      packageName: pkg || null,
      matchesName: compileNameMatcher(name),
    });
  }

  if (compiled.length === 0) return () => false;

  return (packageName: string, change: ApiChange): boolean =>
    compiled.some(
      (p) =>
        (p.packageName === null || p.packageName === packageName) &&
        p.matchesName(change.name),
    );
}
