/**
 * Wrapper around Microsoft API Extractor for generating API snapshots
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  Extractor,
  ExtractorConfig,
  ExtractorResult,
  IConfigFile,
  ExtractorLogLevel,
} from "@microsoft/api-extractor";
import type { ApiSnapshot, PackageEntry, PackageInfo } from "../types.js";

const SNAPSHOT_METADATA_VERSION = 2;
const METADATA_FILENAME = "snapi.snapshot.json";

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
  /** Subpath keys to drop from discovery (exact match, e.g. `./internal`). */
  ignoreSubpaths?: string[];
}

interface DiscoveryResult {
  entries: PackageEntry[];
  skippedWildcards: string[];
  missingFiles: Array<{ subpath: string; path: string }>;
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
   * Write the per-package metadata file (schema v2) listing all generated entries.
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
    const discovery = this.discoverEntries(packagePath, options);

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

  private discoverEntries(
    packagePath: string,
    options: FindEntryPointsOptions,
  ): DiscoveryResult {
    const result: DiscoveryResult = {
      entries: [],
      skippedWildcards: [],
      missingFiles: [],
    };

    const packageJsonPath = path.join(packagePath, "package.json");
    if (!fs.existsSync(packageJsonPath)) return result;

    let packageJson: Record<string, unknown>;
    try {
      packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
    } catch {
      return result;
    }

    const ignore = new Set(options.ignoreSubpaths ?? []);
    const exports = packageJson.exports;

    if (exports && typeof exports === "object" && !Array.isArray(exports)) {
      for (const [subpath, value] of Object.entries(
        exports as Record<string, unknown>,
      )) {
        if (!subpath.startsWith(".")) continue;
        if (ignore.has(subpath)) continue;
        if (subpath.includes("*")) {
          result.skippedWildcards.push(subpath);
          continue;
        }
        if (subpath === "./package.json") continue;

        const typesPath = resolveTypesFromExportValue(value, packagePath);
        if (!typesPath) continue;

        if (!fs.existsSync(typesPath)) {
          result.missingFiles.push({ subpath, path: typesPath });
          continue;
        }

        result.entries.push({ subpath, typesEntry: typesPath });
      }

      // If we found entries via exports map, we're done.
      if (result.entries.length > 0) return result;
    }

    // Fallback path: no exports map (or it produced no usable entries).
    // Resolve a single root entry from `types`/`typings`/`main` + sensible defaults.
    if (ignore.has(".")) return result;

    const rootTypes = resolveRootTypes(packageJson, packagePath);
    if (rootTypes) {
      result.entries.push({ subpath: ".", typesEntry: rootTypes });
    }

    return result;
  }

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
      console.warn(`[snapi] ${message}`);
    }
  }
}

function sanitizePackageName(name: string): string {
  return name.replace(/^@/, "").replace(/\//g, "__");
}

function sanitizeSubpath(subpath: string): string {
  if (subpath === ".") return "_root";
  // Drop leading "./" then turn nested slashes into "__"
  return subpath.replace(/^\.\//, "").replace(/\//g, "__");
}

function resolveTypesFromExportValue(
  value: unknown,
  packagePath: string,
): string | null {
  if (typeof value === "string") {
    return /\.d\.m?ts$/.test(value) ? path.resolve(packagePath, value) : null;
  }

  if (!value || typeof value !== "object") return null;
  const conditional = value as Record<string, unknown>;

  // Order matches Node's "types-first" resolution preference, scanning the
  // most common condition keys.
  for (const condition of ["import", "require", "default"]) {
    const branch = conditional[condition];
    if (!branch) continue;
    if (typeof branch === "string" && /\.d\.m?ts$/.test(branch)) {
      return path.resolve(packagePath, branch);
    }
    if (branch && typeof branch === "object") {
      const types = (branch as Record<string, unknown>).types;
      if (typeof types === "string") {
        return path.resolve(packagePath, types);
      }
    }
  }

  // Top-level `types` inside the conditional block ({"types": "...", ...})
  const topTypes = conditional.types;
  if (typeof topTypes === "string") {
    return path.resolve(packagePath, topTypes);
  }

  return null;
}

function resolveRootTypes(
  packageJson: Record<string, unknown>,
  packagePath: string,
): string | null {
  // 1. types field
  const types = packageJson.types;
  if (typeof types === "string") {
    const p = path.resolve(packagePath, types);
    if (fs.existsSync(p)) return p;
  }

  // 2. typings (legacy)
  const typings = packageJson.typings;
  if (typeof typings === "string") {
    const p = path.resolve(packagePath, typings);
    if (fs.existsSync(p)) return p;
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
    const p = path.resolve(packagePath, dts);
    if (fs.existsSync(p)) return p;
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
    const runner = new ApiExtractorRunner("");
    const entries = runner.findEntryPoints(packagePath, options);

    return {
      name: packageJson.name,
      version: packageJson.version,
      path: packagePath,
      entries,
    };
  } catch {
    return null;
  }
}
