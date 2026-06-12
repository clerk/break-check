/**
 * Wrapper around Microsoft API Extractor for generating API snapshots
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import {
  Extractor,
  ExtractorConfig,
  ExtractorResult,
  IConfigFile,
  ExtractorLogLevel,
} from "@microsoft/api-extractor";
import type { ApiSnapshot, PackageEntry, PackageInfo } from "../types.js";

export const SNAPSHOT_METADATA_VERSION = 4;
export const METADATA_FILENAME = "break-check.snapshot.json";
/**
 * Pre-rename per-package metadata filename. `detect` reads it as a fallback so
 * baselines committed before the snapi -> break-check rename still load without
 * being silently treated as "no baseline".
 */
export const LEGACY_METADATA_FILENAME = "snapi.snapshot.json";
export const API_EXTRACTOR_PACKAGE = "@microsoft/api-extractor";

/**
 * Version of break-check's entry-point discovery semantics. Bump this whenever a
 * change alters *which* entry points are enumerated (e.g. #37's wildcard
 * subpath expansion would have bumped it). `detect` refuses a baseline whose
 * recorded discovery version is older than the running one, because the two
 * snapshots no longer cover the same surface and the diff would report newly
 * enumerated subpaths as phantom additions. This is independent of the
 * package version bump in package.json.
 */
export const DISCOVERY_VERSION = 1;

const requireFromHere = createRequire(import.meta.url);

let cachedBreakCheckVersion: string | null = null;
let cachedApiExtractorVersion: string | null = null;

export function getBreakCheckVersion(): string {
  if (cachedBreakCheckVersion) return cachedBreakCheckVersion;
  try {
    const pkg = requireFromHere("../../package.json") as { version?: string };
    cachedBreakCheckVersion = pkg.version ?? "0.0.0";
  } catch {
    cachedBreakCheckVersion = "0.0.0";
  }
  return cachedBreakCheckVersion;
}

export function getApiExtractorVersion(): string {
  if (cachedApiExtractorVersion) return cachedApiExtractorVersion;
  try {
    const pkg = requireFromHere(`${API_EXTRACTOR_PACKAGE}/package.json`) as {
      version?: string;
    };
    cachedApiExtractorVersion = pkg.version ?? "0.0.0";
  } catch {
    cachedApiExtractorVersion = "0.0.0";
  }
  return cachedApiExtractorVersion;
}

/**
 * Options for the ApiExtractorRunner
 */
export interface ApiExtractorRunnerOptions {
  /** Whether to log verbose output */
  verbose?: boolean;
  /** Whether to keep temporary files after extraction */
  keepTempFiles?: boolean;
}

/**
 * Options for entry-point discovery
 */
export interface FindEntryPointsOptions {
  /**
   * Subpath keys to drop from discovery. An entry without `*` is matched
   * exactly (e.g. `./internal`); an entry containing `*` is treated as a glob
   * (`*` matches within a path segment, `**` across segments) so unstable or
   * unpredictable subpaths can be suppressed without enumerating them. An
   * entry may carry a package scope (`@clerk/astro#./env`); see
   * `makeScopedSubpathMatcher`.
   */
  ignoreSubpaths?: string[];
  /**
   * Drop wildcard-expanded subpaths whose basename looks like a content-hashed
   * bundler chunk (e.g. `./index-Dq-_K2VH`). Defaults to `true`. See
   * `isHashedChunkSubpath`.
   */
  ignoreHashedChunks?: boolean;
}

/**
 * Heuristic: does a wildcard-expanded subpath look like a content-hashed
 * bundler chunk (rolldown / tsdown / esbuild / rollup) rather than a real,
 * importable public entry point?
 *
 * Those bundlers name shared chunks `<name>-<hash>` where the hash is an
 * 8-character base64url token (`A-Za-z0-9_-`). The hash flips whenever the
 * chunk's contents change, so when such a file is exposed through a `./*`
 * wildcard it produces a different subpath every build, which the diff reads
 * as a removed + added subpath (a phantom breaking change). These chunks are
 * not public API; the real entry points that reference them already roll their
 * contents in via API Extractor's `includeForgottenExports`.
 *
 * To avoid misclassifying legitimate dictionary-word subpaths (e.g.
 * `./use-callback`, whose `callback` suffix is also 8 characters), the 8-char
 * suffix must look high-entropy: contain a digit, an uppercase letter, or a
 * `_`. The real hashes (`Dq-_K2VH`, `CcPzUbGM`, `ZibUt-Ji`, `Dvy3tJz6`) all
 * satisfy this; an all-lowercase English word does not.
 */
export function isHashedChunkSubpath(subpath: string): boolean {
  const segment = subpath.replace(/^\.\//, "").split("/").pop() ?? "";
  const match = /-([A-Za-z0-9_-]{8})$/.exec(segment);
  if (!match) return false;
  const hash = match[1];
  return /[0-9]/.test(hash) || /[A-Z]/.test(hash) || /_/.test(hash);
}

/**
 * Convert an `ignoreSubpaths` glob to a regex source: `**` matches across path
 * segments (`.*`), a single `*` matches within one segment (`[^/]*`), and every
 * other character is taken literally (regex metacharacters escaped). Scanned
 * left to right so `**` is consumed before the single-`*` case.
 */
export function globToRegExpSource(pattern: string): string {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        source += ".*";
        i++;
      } else {
        source += "[^/]*";
      }
      continue;
    }
    source += /[.+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
  }
  return source;
}

/**
 * Build a predicate that tests a subpath against a list of `ignoreSubpaths`
 * patterns. Patterns without `*` match exactly (the historical behavior);
 * patterns with `*` are compiled to a regex where `*` matches any run of
 * non-`/` characters and `**` matches across `/`. Match is against the full
 * subpath key (e.g. `./index-Dq-_K2VH`). An empty list never matches.
 */
export function makeSubpathMatcher(
  patterns: string[],
): (subpath: string) => boolean {
  if (patterns.length === 0) return () => false;

  const exact = new Set<string>();
  const regexes: RegExp[] = [];
  for (const pattern of patterns) {
    if (!pattern.includes("*")) {
      exact.add(pattern);
      continue;
    }
    regexes.push(new RegExp(`^${globToRegExpSource(pattern)}$`));
  }

  return (subpath: string): boolean =>
    exact.has(subpath) || regexes.some((re) => re.test(subpath));
}

/** Exact match without `*`, glob match with it (same rules as `makeSubpathMatcher`). */
function compileGlobOrExact(pattern: string): (value: string) => boolean {
  if (!pattern.includes("*")) return (value) => value === pattern;
  const re = new RegExp(`^${globToRegExpSource(pattern)}$`);
  return (value) => re.test(value);
}

interface ScopedSubpathPattern {
  /** Package-name predicate, or null for "any package". */
  matchesPackage: ((packageName: string) => boolean) | null;
  matchesSubpath: (subpath: string) => boolean;
}

/**
 * Package-scoped variant of `makeSubpathMatcher` for `ignoreSubpaths`.
 *
 * An entry starting with `.` is a bare subpath pattern that applies to every
 * configured package, byte-for-byte the historical semantics (subpath keys may
 * legally contain `#`, so the leading `.` short-circuits the scope split). Any
 * other entry containing `#` is split at the first `#` into
 * `<packagePattern>#<subpathPattern>`, mirroring the `acknowledgedChanges`
 * `#` separator (but note: `acknowledgedChanges` matches its package part
 * exactly; the glob package part here is an `ignoreSubpaths` extension); the
 * entry then only ignores the subpath in packages matching the package
 * pattern. Both sides accept the same globs as `makeSubpathMatcher` (`*`
 * within a `/`-segment, `**` across), so `@clerk/*#./internal` scopes to one
 * npm scope while `@clerk/astro#./env` pins one package. An empty package part
 * (`#./env`) means "any package".
 *
 * An entry with neither a leading `.` nor a `#` stays a bare subpath pattern.
 * That branch is load-bearing back compat, not decoration: a non-glob entry of
 * that shape can never match an exports key (they all start with `.`), but
 * glob forms can and keep their historical meaning (`**` matches every key,
 * `*` matches the root `.`). The only input class this function reinterprets
 * is a non-dot entry CONTAINING `#` (e.g. `**#./env`), previously a subpath
 * glob over a literal `#` in the key, now a scoped entry; exports keys
 * containing `#` are pathological, so no realistic existing config changes
 * meaning.
 */
export function makeScopedSubpathMatcher(
  patterns: string[],
): (packageName: string, subpath: string) => boolean {
  if (patterns.length === 0) return () => false;

  const compiled: ScopedSubpathPattern[] = [];
  for (const pattern of patterns) {
    const hash = pattern.startsWith(".") ? -1 : pattern.indexOf("#");
    if (hash === -1) {
      compiled.push({
        matchesPackage: null,
        matchesSubpath: compileGlobOrExact(pattern),
      });
      continue;
    }
    const pkg = pattern.slice(0, hash);
    const subpath = pattern.slice(hash + 1);
    compiled.push({
      matchesPackage: pkg ? compileGlobOrExact(pkg) : null,
      matchesSubpath: compileGlobOrExact(subpath),
    });
  }

  return (packageName: string, subpath: string): boolean =>
    compiled.some(
      (p) =>
        (p.matchesPackage === null || p.matchesPackage(packageName)) &&
        p.matchesSubpath(subpath),
    );
}

/**
 * Trailing boilerplate API Extractor appends to its InternalError messages.
 * Stripped from skip reasons so reports don't tell maintainers to file an
 * upstream bug for conditions that are expected and actionable on their side.
 */
const AE_INTERNAL_ERROR_BOILERPLATE =
  "\n\nYou have encountered a software defect. Please consider reporting " +
  "the issue to the maintainers of this application.";

/**
 * Translate an API Extractor failure message into an actionable skip reason.
 *
 * Matching is on message strings because break-check has no runtime
 * `typescript` dependency to re-diagnose the entry point with. That is
 * acceptable: `@microsoft/api-extractor` is pinned to an exact version and an
 * AE bump mandates a break-check major (see AGENTS.md), so the strings are
 * stable for any given release. An unrecognized message passes through with
 * only the boilerplate stripped, so a new AE failure shape is still reported
 * verbatim rather than misclassified.
 *
 * When the caller knows which (package, subpath) failed, the guidance names
 * the exact package-scoped `ignoreSubpaths` entry to copy, so acknowledging
 * the skip doesn't blanket-ignore the same subpath in every other package.
 */
export function describeExtractionFailure(
  message: string,
  entry?: { packageName: string; subpath: string },
): string {
  const stripped = message.endsWith(AE_INTERNAL_ERROR_BOILERPLATE)
    ? message.slice(0, -AE_INTERNAL_ERROR_BOILERPLATE.length).trim()
    : message.trim();

  // The hint rides inside a backtick code span in the markdown report, and
  // the reporter's mdProse intentionally preserves backticks. package.json is
  // attacker-controlled in CI, so a backtick smuggled into the name or an
  // exports key must not terminate the span early; neutralize it the same way
  // the reporter's mdCode does (backtick -> apostrophe).
  const mdSafe = (value: string): string => value.replace(/`/g, "'");
  const ackHint = entry
    ? `add \`"${mdSafe(entry.packageName)}#${mdSafe(entry.subpath)}"\` ` +
      "to `ignoreSubpaths`"
    : "add the subpath to `ignoreSubpaths`";

  // Fires when the entry .d.ts is an ambient script (no top-level
  // import/export). AE can never analyze such surfaces; see rushstack
  // issues #1176 / #2142.
  const ambient = /^Internal Error: Unable to determine module for: .+$/.exec(
    stripped,
  );
  if (ambient) {
    return (
      "ambient declaration file (no top-level import or export): " +
      "API Extractor can only analyze module entry points, so this " +
      `global-augmentation surface cannot be snapshotted; ${ackHint} ` +
      "to acknowledge it " +
      `(API Extractor: ${stripFirstLinePrefix(stripped)})`
    );
  }

  // Three AE code paths for the same root cause: the shipped declarations
  // name a type that cannot be resolved from the entry point. Identifier
  // capture is (.+), not (\w+): identifiers can be `$`, quoted, or dotted.
  // The third shape (ExportAnalyzer's import-type variant) appends a source
  // location on the next line, so it is matched on the first line only.
  const unresolved =
    /^Internal Error: Unable to follow symbol for "(.+)"$/.exec(stripped) ??
    /^Symbol not found for identifier: (.+)$/.exec(stripped) ??
    /^Internal Error: Symbol not found for identifier: (.+)\n/.exec(stripped);
  if (unresolved) {
    return (
      `the shipped declarations reference the type name "${unresolved[1]}", ` +
      "which cannot be resolved from the entry point; the published types " +
      "are likely broken for consumers (often a dropped import or a types " +
      "package that is only a devDependency); fix the published types, or " +
      `${ackHint} as a stopgap ` +
      `(API Extractor: ${stripFirstLinePrefix(stripped)})`
    );
  }

  return stripped;
}

function stripFirstLinePrefix(message: string): string {
  const firstLine = message.split("\n", 1)[0];
  return firstLine.replace(/^Internal Error: /, "");
}

interface DiscoveryResult {
  entries: PackageEntry[];
  skippedWildcards: string[];
  missingFiles: Array<{ subpath: string; path: string }>;
  /**
   * Subpaths whose `exports` value declares a types target that could not be
   * turned into an entry point (the target escapes the package directory, or a
   * wildcard types pattern matched no files). Subpaths declaring no types at
   * all are NOT listed; a JS-only or asset export is not a coverage hole.
   */
  unresolvedTypes: Array<{ subpath: string; declared: string }>;
}

/**
 * Wrapper around Microsoft API Extractor to generate API snapshots
 */
export class ApiExtractorRunner {
  private verbose: boolean;
  private keepTempFiles: boolean;

  constructor(
    private outputDir: string,
    options: ApiExtractorRunnerOptions = {},
  ) {
    this.verbose = options.verbose ?? false;
    this.keepTempFiles = options.keepTempFiles ?? false;
  }

  /**
   * Generate an API snapshot for a single (package, entry) tuple.
   * Multiple entries from the same package share an output directory and a
   * single metadata file (written by the caller via `writePackageMetadata`).
   */
  async generateSnapshot(
    packageInfo: PackageInfo,
    entry: PackageEntry,
  ): Promise<ApiSnapshot> {
    const { name, version, path: packagePath } = packageInfo;

    const safePackageName = sanitizePackageName(name);
    const safeSubpath = sanitizeSubpath(entry.subpath);
    const packageOutputDir = path.join(this.outputDir, safePackageName);
    fs.mkdirSync(packageOutputDir, { recursive: true });

    const apiJsonName = `${safePackageName}__${safeSubpath}.api.json`;
    const apiReportName = `${safePackageName}__${safeSubpath}.api.md`;

    const config = this.createExtractorConfig({
      packagePath,
      entryPoint: entry.typesEntry,
      packageOutputDir,
      apiJsonName,
      apiReportName,
    });

    const result = this.runExtractor(config);

    if (!result.succeeded) {
      throw new Error(
        `API Extractor failed for ${name} (${entry.subpath}): ${result.errorCount} errors, ${result.warningCount} warnings`,
      );
    }

    const apiJsonPath = path.join(packageOutputDir, apiJsonName);
    const apiReportPath = path.join(packageOutputDir, apiReportName);
    const metadataPath = path.join(packageOutputDir, METADATA_FILENAME);

    if (!fs.existsSync(apiJsonPath)) {
      throw new Error(`API Extractor did not generate ${apiJsonPath}`);
    }

    return {
      packageName: name,
      subpath: entry.subpath,
      packagePath,
      version,
      timestamp: new Date().toISOString(),
      apiJsonPath,
      apiReportPath: fs.existsSync(apiReportPath) ? apiReportPath : "",
      metadataPath,
    };
  }

  /**
   * Write the per-package metadata file listing all generated entries, the
   * producing break-check / API Extractor versions, and the discovery version.
   */
  writePackageMetadata(
    packageInfo: PackageInfo,
    snapshots: ApiSnapshot[],
  ): void {
    if (snapshots.length === 0) return;

    const safePackageName = sanitizePackageName(packageInfo.name);
    const packageOutputDir = path.join(this.outputDir, safePackageName);
    const metadataPath = path.join(packageOutputDir, METADATA_FILENAME);

    const payload = {
      schemaVersion: SNAPSHOT_METADATA_VERSION,
      breakCheckVersion: getBreakCheckVersion(),
      discoveryVersion: DISCOVERY_VERSION,
      apiExtractorPackage: API_EXTRACTOR_PACKAGE,
      apiExtractorVersion: getApiExtractorVersion(),
      packageName: packageInfo.name,
      packagePath: packageInfo.path,
      version: packageInfo.version,
      timestamp: new Date().toISOString(),
      entries: snapshots.map((s) => ({
        subpath: s.subpath,
        apiJsonFile: path.basename(s.apiJsonPath),
        apiReportFile: s.apiReportPath ? path.basename(s.apiReportPath) : null,
      })),
    };

    fs.writeFileSync(
      metadataPath,
      JSON.stringify(payload, null, 2) + "\n",
      "utf-8",
    );
  }

  /**
   * Discover every entry point declared via the package's `exports` map, plus
   * the root entry inferred from `types`/`typings`/`main` when no exports map
   * is present.
   */
  findEntryPoints(
    packagePath: string,
    options: FindEntryPointsOptions = {},
  ): PackageEntry[] {
    const discovery = discoverPackageEntries(packagePath, options);

    if (discovery.skippedWildcards.length > 0) {
      this.warn(
        `${packagePath}: skipping wildcard subpath exports: ${discovery.skippedWildcards.join(", ")}`,
      );
    }
    for (const m of discovery.missingFiles) {
      this.warn(
        `${packagePath}: subpath \`${m.subpath}\` resolved to missing file ${m.path}`,
      );
    }
    for (const u of discovery.unresolvedTypes) {
      this.warn(
        `${packagePath}: subpath \`${u.subpath}\` declares types ${u.declared} that could not be resolved`,
      );
    }

    return discovery.entries;
  }

  /**
   * Back-compat: return the root entry's `.d.ts` path, or null.
   * Used by `readPackageInfo` callers that only care about a single file path.
   */
  findEntryPoint(packagePath: string): string | null {
    const entries = this.findEntryPoints(packagePath);
    const root = entries.find((e) => e.subpath === ".");
    return root?.typesEntry ?? null;
  }

  // Entry-point discovery lives in the module-level `discoverPackageEntries`
  // so `readPackageInfo` can surface the full discovery result (including the
  // subpaths that could NOT be resolved), not just the entries.

  /**
   * Create API Extractor configuration for a single entry point.
   */
  private createExtractorConfig(args: {
    packagePath: string;
    entryPoint: string;
    packageOutputDir: string;
    apiJsonName: string;
    apiReportName: string;
  }): ExtractorConfig {
    const {
      packagePath,
      entryPoint,
      packageOutputDir,
      apiJsonName,
      apiReportName,
    } = args;
    const tsconfigPath = this.findTsConfig(packagePath);

    const configObject: IConfigFile = {
      projectFolder: packagePath,
      mainEntryPointFilePath: entryPoint,
      apiReport: {
        enabled: true,
        reportFileName: apiReportName,
        reportFolder: packageOutputDir,
        reportTempFolder: packageOutputDir,
        includeForgottenExports: true,
      },
      docModel: {
        enabled: true,
        apiJsonFilePath: path.join(packageOutputDir, apiJsonName),
      },
      dtsRollup: {
        enabled: false,
      },
      tsdocMetadata: {
        enabled: false,
      },
      messages: {
        extractorMessageReporting: {
          "ae-missing-release-tag": { logLevel: ExtractorLogLevel.None },
          "ae-unresolved-link": { logLevel: ExtractorLogLevel.Warning },
        },
        tsdocMessageReporting: {
          default: { logLevel: ExtractorLogLevel.None },
        },
      },
    };

    if (tsconfigPath) {
      configObject.compiler = {
        tsconfigFilePath: tsconfigPath,
      };
    } else {
      configObject.compiler = {
        overrideTsconfig: {
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            skipLibCheck: true,
          },
          files: [entryPoint],
        },
      };
    }

    return ExtractorConfig.prepare({
      configObject,
      configObjectFullPath: path.join(packagePath, "api-extractor.json"),
      packageJsonFullPath: path.join(packagePath, "package.json"),
    });
  }

  private findTsConfig(packagePath: string): string | null {
    const candidates = [
      "tsconfig.json",
      "tsconfig.build.json",
      "tsconfig.lib.json",
    ];

    for (const candidate of candidates) {
      const tsconfigPath = path.join(packagePath, candidate);
      if (fs.existsSync(tsconfigPath)) {
        return tsconfigPath;
      }
    }

    return null;
  }

  private runExtractor(config: ExtractorConfig): ExtractorResult {
    return Extractor.invoke(config, {
      localBuild: true,
      showVerboseMessages: this.verbose,
      showDiagnostics: this.verbose,
      messageCallback: (message) => {
        if (this.verbose) {
          console.log(`[api-extractor] ${message.text}`);
        }
        message.handled = true;
      },
    });
  }

  private warn(message: string): void {
    if (this.verbose) {
      console.warn(`[break-check] ${message}`);
    }
  }
}

/**
 * Discover every entry point declared via the package's `exports` map, plus the
 * root entry inferred from `types`/`typings`/`main` when no exports map is
 * present. Module-level (it touches no extractor state) so `readPackageInfo`
 * can expose the full result, including the subpaths that could not be
 * resolved, rather than just the entries.
 */
function discoverPackageEntries(
  packagePath: string,
  options: FindEntryPointsOptions,
): DiscoveryResult {
  const result: DiscoveryResult = {
    entries: [],
    skippedWildcards: [],
    missingFiles: [],
    unresolvedTypes: [],
  };

  const packageJsonPath = path.join(packagePath, "package.json");
  if (!fs.existsSync(packageJsonPath)) return result;

  let packageJson: Record<string, unknown>;
  try {
    packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
  } catch {
    return result;
  }

  // Scoped entries match against the name this package.json declares; a
  // missing/non-string name leaves bare entries working and scoped entries
  // inert (nothing to scope against).
  const packageName =
    typeof packageJson.name === "string" ? packageJson.name : "";
  const scopedIgnore = makeScopedSubpathMatcher(options.ignoreSubpaths ?? []);
  const ignoreMatch = (subpath: string): boolean =>
    scopedIgnore(packageName, subpath);
  const dropHashedChunks = options.ignoreHashedChunks ?? true;
  const exports = packageJson.exports;

  if (exports && typeof exports === "object" && !Array.isArray(exports)) {
    const seen = new Set<string>();
    for (const [subpath, value] of Object.entries(
      exports as Record<string, unknown>,
    )) {
      if (!subpath.startsWith(".")) continue;
      if (ignoreMatch(subpath)) continue;
      if (subpath === "./package.json") continue;

      if (subpath.includes("*")) {
        // Wildcard subpaths (e.g. `"./*": "./dist/runtime/*.d.mts"`) are
        // how packages like @clerk/shared expose most of their API. Glob
        // the filesystem and synthesize one concrete entry per match so
        // breaking changes under wildcard surfaces aren't invisible.
        const expansion = expandWildcardSubpath(subpath, value, packagePath);
        if (expansion.entries.length === 0) {
          result.skippedWildcards.push(subpath);
          // A wildcard whose declared types pattern could not be honored
          // (multi-star, escaping target, glob failure) may hide real files,
          // so record it as a coverage hole. An empty match or a wildcard
          // with no types target exposes no surface and stays silent.
          if (expansion.unsupported) {
            const declared = findTypesTarget(value);
            if (declared) {
              result.unresolvedTypes.push({ subpath, declared });
            }
          }
          continue;
        }
        for (const e of expansion.entries) {
          if (ignoreMatch(e.subpath)) continue;
          // Content-hashed bundler chunks caught by a `./*` glob are not
          // public API and their names change every build; dropping them
          // keeps the diff from churning. See `isHashedChunkSubpath`.
          if (dropHashedChunks && isHashedChunkSubpath(e.subpath)) continue;
          if (seen.has(e.subpath)) continue;
          seen.add(e.subpath);
          result.entries.push(e);
        }
        continue;
      }

      const typesPath = resolveTypesFromExportValue(value, packagePath);
      if (!typesPath) {
        // A declared target that `resolveWithinPackage` refused (it escapes
        // the package directory) is a coverage hole; a subpath declaring no
        // types at all has nothing to snapshot and stays silent.
        const declared = findTypesTarget(value);
        if (declared) {
          result.unresolvedTypes.push({ subpath, declared });
        }
        continue;
      }

      if (!fs.existsSync(typesPath)) {
        result.missingFiles.push({ subpath, path: typesPath });
        continue;
      }

      if (seen.has(subpath)) continue;
      seen.add(subpath);
      result.entries.push({ subpath, typesEntry: typesPath });
    }

    // If we found entries via exports map, we're done.
    if (result.entries.length > 0) return result;
  }

  // Fallback path: no exports map (or it produced no usable entries).
  // Resolve a single root entry from `types`/`typings`/`main` + sensible defaults.
  if (ignoreMatch(".")) return result;

  const rootTypes = resolveRootTypes(packageJson, packagePath);
  if (rootTypes) {
    result.entries.push({ subpath: ".", typesEntry: rootTypes });
  }

  return result;
}

function sanitizePackageName(name: string): string {
  return name.replace(/^@/, "").replace(/\//g, "__");
}

function sanitizeSubpath(subpath: string): string {
  if (subpath === ".") return "_root";
  // Drop leading "./" then turn nested slashes into "__"
  return subpath.replace(/^\.\//, "").replace(/\//g, "__");
}

/**
 * Resolve `target` (a path read from a scanned package's package.json) against
 * `packagePath`, returning the absolute path only when it stays inside the
 * package root. A package.json is attacker-controlled in CI (the Action builds
 * a PR's manifest), so a `types`/`exports` value like `../../../secret.d.ts`
 * must not let discovery pull a `.d.ts` from outside the package it describes
 * into the snapshot, report, or AI payload. The check is lexical (no symlink
 * resolution), matching the baseline-side `isContainedFilename` guard in
 * detector.ts and the prefix/suffix containment in `expandWildcardSubpath`; a
 * non-contained target resolves to null and the caller skips that entry.
 */
function resolveWithinPackage(
  packagePath: string,
  target: string,
): string | null {
  const root = path.resolve(packagePath);
  const resolved = path.resolve(root, target);
  const rel = path.relative(root, resolved);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    return null;
  }
  return resolved;
}

function resolveTypesFromExportValue(
  value: unknown,
  packagePath: string,
): string | null {
  const declared = findTypesTarget(value);
  return declared ? resolveWithinPackage(packagePath, declared) : null;
}

/**
 * Find the type-declaration target declared by an `exports` value, searching
 * nested condition objects recursively (e.g. `{ node: { import: { types } } }`,
 * which Node/TS resolve fine but a single-level scan misses). At each level the
 * `types` condition wins, then the common conditions in Node's preference
 * order, then any remaining branch in declaration order. A plain string matches
 * only when it is a declaration file (`.d.ts`/`.d.mts`/`.d.cts`); a `types`
 * condition's string value is taken as declared regardless of extension.
 * Returns the raw (unresolved) target, or null when the value declares no type
 * surface at all, so callers can tell a typed subpath break-check failed to
 * resolve apart from a JS-only or asset subpath that has nothing to snapshot.
 */
function findTypesTarget(value: unknown): string | null {
  if (typeof value === "string") {
    return /\.d\.[cm]?ts$/.test(value) ? value : null;
  }
  if (Array.isArray(value)) {
    for (const branch of value) {
      const found = findTypesTarget(branch);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const conditional = value as Record<string, unknown>;

  if (typeof conditional.types === "string") return conditional.types;

  const preferred = ["types", "import", "require", "default"];
  for (const condition of preferred) {
    if (!(condition in conditional)) continue;
    const found = findTypesTarget(conditional[condition]);
    if (found) return found;
  }
  for (const [condition, branch] of Object.entries(conditional)) {
    if (preferred.includes(condition)) continue;
    const found = findTypesTarget(branch);
    if (found) return found;
  }
  return null;
}

/**
 * Expand a wildcard subpath export (e.g. `"./*": "./dist/runtime/*.d.mts"`)
 * into one concrete `PackageEntry` per matching file on disk. Mirrors how
 * Node resolves consumer-side imports of `<pkg>/foo` against the pattern:
 * the part of the consumer path that the `*` captures is substituted into
 * the value to find the actual `.d.ts`.
 *
 * Only single-wildcard patterns are supported (the common case and the
 * shape the Node spec actually documents). Multi-wildcard patterns and
 * targets that escape the package return no entries with `unsupported`
 * set, which the caller surfaces as an unresolved (skipped) subpath.
 *
 * The glob uses a single-segment `*`, so this catches packages like
 * `@clerk/shared` that expose `./file`, `./url`, `./error` flat; nested
 * `./internal/foo/bar` style wildcards are not auto-expanded yet.
 */
interface WildcardExpansion {
  entries: PackageEntry[];
  /**
   * True when the value DECLARES a types target but the expansion machinery
   * could not honor it: a multi-star pattern, a target escaping the package, or
   * a glob failure. Files may exist behind such a pattern, so an empty result
   * is a coverage hole. False when the value declares no types at all (a JS or
   * asset wildcard) or the pattern simply matched no files; in both of those
   * cases there is no actual type surface a consumer could resolve either, so
   * an empty result is benign.
   */
  unsupported: boolean;
}

function expandWildcardSubpath(
  keyPattern: string,
  value: unknown,
  packagePath: string,
): WildcardExpansion {
  if (value === null) return { entries: [], unsupported: false };

  const declared = findTypesTarget(value);
  if (!declared) return { entries: [], unsupported: false };

  const typesPath = resolveWithinPackage(packagePath, declared);
  if (!typesPath) return { entries: [], unsupported: true };

  const keyStarCount = (keyPattern.match(/\*/g) ?? []).length;
  const valStarCount = (typesPath.match(/\*/g) ?? []).length;
  if (keyStarCount !== 1 || valStarCount !== 1) {
    return { entries: [], unsupported: true };
  }

  const starIdx = typesPath.indexOf("*");
  const prefix = typesPath.slice(0, starIdx);
  const suffix = typesPath.slice(starIdx + 1);

  let matches: string[] = [];
  try {
    matches = fs.globSync(typesPath) as string[];
  } catch {
    return { entries: [], unsupported: true };
  }

  const entries: PackageEntry[] = [];
  for (const match of matches) {
    const abs = path.resolve(match);
    if (!abs.startsWith(prefix) || !abs.endsWith(suffix)) continue;
    const captured = abs.slice(prefix.length, abs.length - suffix.length);
    if (!captured) continue;
    const subpath = keyPattern.replace("*", captured);
    entries.push({ subpath, typesEntry: abs });
  }

  // `fs.globSync` makes no ordering guarantee across platforms or
  // filesystems, and these entries flow straight into the `entries` array
  // in `break-check.snapshot.json`. Sort by subpath so two runs on different
  // runners produce byte-identical metadata instead of spurious
  // order-only baseline churn.
  entries.sort((a, b) => a.subpath.localeCompare(b.subpath));
  return { entries, unsupported: false };
}

function resolveRootTypes(
  packageJson: Record<string, unknown>,
  packagePath: string,
): string | null {
  // 1. types field
  const types = packageJson.types;
  if (typeof types === "string") {
    const p = resolveWithinPackage(packagePath, types);
    if (p && fs.existsSync(p)) return p;
  }

  // 2. typings (legacy)
  const typings = packageJson.typings;
  if (typeof typings === "string") {
    const p = resolveWithinPackage(packagePath, typings);
    if (p && fs.existsSync(p)) return p;
  }

  // 3. exports["."] - resolved generically
  const exports = packageJson.exports;
  if (exports && typeof exports === "object" && !Array.isArray(exports)) {
    const rootEntry = (exports as Record<string, unknown>)["."];
    if (rootEntry) {
      const resolved = resolveTypesFromExportValue(rootEntry, packagePath);
      if (resolved && fs.existsSync(resolved)) return resolved;
    }
  }

  // 4. Infer from "main" (.js -> .d.ts)
  const main = packageJson.main;
  if (typeof main === "string") {
    const dts = main.replace(/\.js$/, ".d.ts");
    const p = resolveWithinPackage(packagePath, dts);
    if (p && fs.existsSync(p)) return p;
  }

  // 5. dist/index.d.ts
  const distDts = path.join(packagePath, "dist", "index.d.ts");
  if (fs.existsSync(distDts)) return distDts;

  // 6. index.d.ts at root
  const rootDts = path.join(packagePath, "index.d.ts");
  if (fs.existsSync(rootDts)) return rootDts;

  return null;
}

/**
 * Read package.json and resolve every public entry point (root + subpaths).
 */
export function readPackageInfo(
  packagePath: string,
  options: FindEntryPointsOptions = {},
): PackageInfo | null {
  const packageJsonPath = path.join(packagePath, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    return null;
  }

  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
    const discovery = discoverPackageEntries(packagePath, options);

    // Subpaths that declare a type surface break-check could not snapshot.
    // Exposed so the detector can record them as skipped entries; otherwise
    // they are silent coverage holes that even --fail-on-skipped misses.
    const unresolvedSubpaths = [
      ...discovery.unresolvedTypes.map((u) => ({
        subpath: u.subpath,
        reason:
          `exports declares types \`${u.declared}\` that could not be ` +
          `resolved to a file inside the package`,
      })),
      ...discovery.missingFiles.map((m) => ({
        subpath: m.subpath,
        reason: `types entry resolved to missing file ${m.path}`,
      })),
    ];

    return {
      name: packageJson.name,
      version: packageJson.version,
      path: packagePath,
      entries: discovery.entries,
      ...(unresolvedSubpaths.length > 0 ? { unresolvedSubpaths } : {}),
    };
  } catch {
    return null;
  }
}
