/**
 * Resolve whether a module specifier referenced inside a public `.d.ts` is a
 * real, importable entry point of its target package.
 *
 * Why this exists: a public type can start referencing a dependency's internal,
 * export-blocked subpath (e.g. `import("@clerk/shared/_chunks/index-DcO1-lAR").$a`
 * when `@clerk/shared` declares `"./_chunks/*": null`). The structural shape of
 * the referenced type may be unchanged, but the consumer cannot resolve the
 * module specifier, so under `nodenext` it errors (TS2307) or silently degrades
 * to `any` (skipLibCheck). That is a breaking change the AI reviewer otherwise
 * waves through as a "build artifact rename" (see issue #60). break-check's own
 * `canonicalType` discards the subpath before the diff/AI ever see it, so the
 * only place the signal survives is the raw `.d.ts` text in `afterSnippet`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { isHashedChunkSubpath } from "./api-extractor.js";

export interface ParsedSpecifier {
  /** Bare package name, including scope (`@clerk/shared`, `react`). */
  pkg: string;
  /** Subpath into the package: `.` for the root, else `./foo/bar`. */
  subpath: string;
}

/**
 * Split a bare module specifier into its package name and subpath. Returns null
 * for relative (`./x`) or absolute (`/x`) specifiers, which are intra-package
 * and never a cross-package resolvability concern.
 */
export function parseModuleSpecifier(
  specifier: string,
): ParsedSpecifier | null {
  if (!specifier || specifier.startsWith(".") || specifier.startsWith("/")) {
    return null;
  }
  const parts = specifier.split("/");
  let pkg: string;
  let rest: string[];
  if (specifier.startsWith("@")) {
    if (parts.length < 2 || !parts[0] || !parts[1]) return null;
    pkg = `${parts[0]}/${parts[1]}`;
    rest = parts.slice(2);
  } else {
    pkg = parts[0];
    rest = parts.slice(1);
  }
  const subpath = rest.length === 0 ? "." : `./${rest.join("/")}`;
  return { pkg, subpath };
}

/**
 * Extract the specifier of every inline `import("...")` type in a `.d.ts`
 * excerpt. API Extractor emits an unresolvable import as literal inline text
 * (there is no symbol to bind, so it cannot be aliased), so a scan over the raw
 * snippet reliably finds the offending specifier.
 */
export function extractInlineImportSpecifiers(
  snippet: string | undefined,
): string[] {
  if (!snippet) return [];
  const re = /import\(\s*(['"])([^'"]+)\1\s*\)/g;
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(snippet)) !== null) out.add(m[2]);
  return [...out];
}

/** Does an `exports` target (string / array / conditions object) resolve to a non-null value under some condition? */
function targetResolvesNonNull(target: unknown): boolean {
  if (target === null || target === undefined) return false;
  if (typeof target === "string") return true;
  if (Array.isArray(target)) return target.some(targetResolvesNonNull);
  if (typeof target === "object") {
    return Object.values(target as Record<string, unknown>).some(
      targetResolvesNonNull,
    );
  }
  return false;
}

/**
 * Minimal Node `exports` resolution answering only "does `subpath` resolve to a
 * non-null target?". Returns true (exported), false (blocked via `null`, or no
 * matching key), or null (no usable `exports` field, so Node would fall back to
 * legacy resolution and we cannot be sure).
 *
 * Handles the cases that matter for this guard: exact subpath keys, single-`*`
 * wildcard patterns with longest-base-prefix-wins (so `"./_chunks/*"` beats
 * `"./*"`), `null` targets (blocked), and condition objects (any non-null branch
 * counts as exported). Full PACKAGE_EXPORTS_RESOLVE condition matching is not
 * needed: a subpath blocked with `null` is null under every condition.
 */
export function isSubpathExported(
  exportsField: unknown,
  subpath: string,
): boolean | null {
  if (exportsField === undefined) return null;
  // `"exports": null` blocks every subpath, the root included.
  if (exportsField === null) return false;

  const isObject =
    exportsField !== null &&
    typeof exportsField === "object" &&
    !Array.isArray(exportsField);
  const keys = isObject ? Object.keys(exportsField as object) : [];
  const hasSubpathKeys = keys.some((k) => k.startsWith("."));

  // Sugar form (string, array, or conditions-only object): only the package
  // root is exported.
  if (!isObject || !hasSubpathKeys) {
    return subpath === ".";
  }

  const map = exportsField as Record<string, unknown>;

  if (Object.prototype.hasOwnProperty.call(map, subpath)) {
    return targetResolvesNonNull(map[subpath]);
  }

  // Single-`*` wildcard patterns. Node's PATTERN_KEY_COMPARE picks the longest
  // base prefix, breaking ties on the longer trailing suffix (so `"./*.json"`
  // beats `"./*"` for `./a.json`). Mirror both so the verdict is independent of
  // object key order.
  let best: { key: string; baseLen: number; sufLen: number } | null = null;
  for (const key of keys) {
    const star = key.indexOf("*");
    if (star === -1 || key.indexOf("*", star + 1) !== -1) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (subpath.length < prefix.length + suffix.length) continue;
    if (!subpath.startsWith(prefix)) continue;
    if (suffix && !subpath.endsWith(suffix)) continue;
    if (
      best === null ||
      prefix.length > best.baseLen ||
      (prefix.length === best.baseLen && suffix.length > best.sufLen)
    ) {
      best = { key, baseLen: prefix.length, sufLen: suffix.length };
    }
  }
  if (best) return targetResolvesNonNull(map[best.key]);

  // No matching key: not exported.
  return false;
}

/**
 * Walk up `node_modules` from `fromDir` to find a dependency's `package.json`
 * and return its `exports` field. `found` distinguishes "package not installed
 * here" from "installed but has no exports map". `fs.readFileSync` follows
 * symlinks, so pnpm's symlinked store and workspace packages resolve correctly.
 */
export function readDependencyExports(
  pkg: string,
  fromDir: string,
): { found: boolean; exports?: unknown } {
  let dir = path.resolve(fromDir);
  const segments = pkg.split("/");
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const candidate = path.join(
      dir,
      "node_modules",
      ...segments,
      "package.json",
    );
    if (fs.existsSync(candidate)) {
      try {
        const json = JSON.parse(fs.readFileSync(candidate, "utf-8")) as Record<
          string,
          unknown
        >;
        return { found: true, exports: json.exports };
      } catch {
        return { found: false };
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { found: false };
}

export type ReferenceResolvability = "exported" | "blocked" | "unknown";

/**
 * Classify whether a referenced module specifier resolves to a public, exported
 * entry point of its target package. `unknown` means we could not locate the
 * dependency or it has no `exports` map; callers should fall back to the coarse
 * `looksLikeInternalChunk` heuristic rather than escalate on `unknown` alone.
 */
export function classifyReference(
  specifier: string,
  fromDir: string,
): ReferenceResolvability {
  const parsed = parseModuleSpecifier(specifier);
  if (!parsed) return "exported"; // relative/intra-package: not our concern
  // The root (`.`) is resolved against the dependency's `exports` like any other
  // subpath. Once a package declares `exports`, that map fully governs
  // resolution, so a root blocked with `"."`/`exports: null` is genuinely
  // unimportable (`ERR_PACKAGE_PATH_NOT_EXPORTED`), not silently served from
  // `main`/`index`. When the dependency can't be located or has no `exports`,
  // `isSubpathExported` returns null below and the root falls through to
  // `unknown`, which never escalates on its own (the chunk heuristic ignores
  // the root), so the common case stays untouched.
  const { found, exports } = readDependencyExports(parsed.pkg, fromDir);
  if (!found) return "unknown";
  const verdict = isSubpathExported(exports, parsed.subpath);
  if (verdict === null) return "unknown";
  return verdict ? "exported" : "blocked";
}

/**
 * Coarse backstop for when the dependency can't be located: does the specifier's
 * subpath look like an internal bundler chunk (a `/_chunks/` segment, or a
 * content-hashed `-<hash>` basename)? Reuses the discovery-time heuristic.
 */
export function looksLikeInternalChunk(specifier: string): boolean {
  const parsed = parseModuleSpecifier(specifier);
  if (!parsed || parsed.subpath === ".") return false;
  if (parsed.subpath.split("/").includes("_chunks")) return true;
  return isHashedChunkSubpath(parsed.subpath);
}

/** Result of `findUnresolvableReference`. */
export interface UnresolvableReference {
  /** The offending module specifier. */
  specifier: string;
  /**
   * True when the verdict is exact (the specifier was resolved against the
   * dependency's `exports` and is blocked/absent). False when it rests on the
   * coarse `/_chunks/` + content-hash heuristic because the dependency could not
   * be located. Callers can act on `deterministic` to avoid escalating on a
   * heuristic guess (which fails safe only when the change is already breaking).
   */
  deterministic: boolean;
}

/**
 * Decide whether a change newly introduces a reference to a module specifier
 * that consumers cannot resolve. Compares the inline import specifiers of the
 * before/after snippets so an unchanged (already-present) reference is not
 * re-flagged; only a specifier introduced by the new signature is judged.
 * Returns the offending specifier (and whether the verdict is deterministic),
 * or null when the change is clean.
 *
 * `isAllowed` is the maintainer escape hatch (config `resolvableSpecifiers`): a
 * specifier it matches is treated as resolvable regardless of the heuristics.
 */
export function findUnresolvableReference(
  change: { beforeSnippet?: string; afterSnippet?: string },
  fromDir: string,
  isAllowed: (specifier: string) => boolean = () => false,
): UnresolvableReference | null {
  const after = extractInlineImportSpecifiers(change.afterSnippet);
  if (after.length === 0) return null;
  const before = new Set(extractInlineImportSpecifiers(change.beforeSnippet));
  for (const spec of after) {
    if (before.has(spec)) continue;
    if (isAllowed(spec)) continue;
    const verdict = classifyReference(spec, fromDir);
    if (verdict === "blocked") return { specifier: spec, deterministic: true };
    if (verdict === "unknown" && looksLikeInternalChunk(spec)) {
      return { specifier: spec, deterministic: false };
    }
  }
  return null;
}
