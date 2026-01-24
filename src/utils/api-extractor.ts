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
import type { ApiSnapshot, PackageInfo } from "../types.js";

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
   * Generate API snapshot for a package
   * @param packageInfo - Package information
   * @returns ApiSnapshot with paths to generated files
   * @throws Error if snapshot generation fails
   */
  async generateSnapshot(packageInfo: PackageInfo): Promise<ApiSnapshot> {
    const { name, version, path: packagePath } = packageInfo;

    // Find entry point
    const entryPoint = this.findEntryPoint(packagePath);
    if (!entryPoint) {
      throw new Error(
        `No TypeScript declaration entry point found for ${name}. ` +
          `Ensure the package is built and has .d.ts files.`,
      );
    }

    // Create output directory for this package
    const safePackageName = name.replace(/^@/, "").replace(/\//g, "__");
    const packageOutputDir = path.join(this.outputDir, safePackageName);
    fs.mkdirSync(packageOutputDir, { recursive: true });

    // Generate API Extractor config
    const config = this.createExtractorConfig(
      packagePath,
      entryPoint,
      safePackageName,
      packageOutputDir,
    );

    // Run API Extractor
    const result = this.runExtractor(config);

    if (!result.succeeded) {
      throw new Error(
        `API Extractor failed for ${name}: ${result.errorCount} errors, ${result.warningCount} warnings`,
      );
    }

    const apiJsonPath = path.join(
      packageOutputDir,
      `${safePackageName}.api.json`,
    );
    const apiReportPath = path.join(
      packageOutputDir,
      `${safePackageName}.api.md`,
    );

    // Verify output files exist
    if (!fs.existsSync(apiJsonPath)) {
      throw new Error(`API Extractor did not generate ${apiJsonPath}`);
    }

    return {
      packageName: name,
      packagePath,
      version,
      timestamp: new Date().toISOString(),
      apiJsonPath,
      apiReportPath: fs.existsSync(apiReportPath) ? apiReportPath : "",
    };
  }

  /**
   * Find the TypeScript declaration entry point for a package
   * @param packagePath - Absolute path to the package directory
   * @returns Path to the .d.ts entry point, or null if not found
   */
  findEntryPoint(packagePath: string): string | null {
    const packageJsonPath = path.join(packagePath, "package.json");
    if (!fs.existsSync(packageJsonPath)) {
      return null;
    }

    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));

    // 1. Check "types" field
    if (packageJson.types) {
      const typesPath = path.resolve(packagePath, packageJson.types);
      if (fs.existsSync(typesPath)) {
        return typesPath;
      }
    }

    // 2. Check "typings" field (legacy)
    if (packageJson.typings) {
      const typingsPath = path.resolve(packagePath, packageJson.typings);
      if (fs.existsSync(typingsPath)) {
        return typingsPath;
      }
    }

    // 3. Check exports['.'].types
    if (packageJson.exports?.["."]?.types) {
      const exportsTypesPath = path.resolve(
        packagePath,
        packageJson.exports["."].types,
      );
      if (fs.existsSync(exportsTypesPath)) {
        return exportsTypesPath;
      }
    }

    // 4. Check exports['.'].import.types or exports['.'].require.types
    const exportsRoot = packageJson.exports?.["."];
    if (exportsRoot) {
      for (const condition of ["import", "require", "default"]) {
        const conditionTypes = exportsRoot[condition]?.types;
        if (conditionTypes) {
          const conditionTypesPath = path.resolve(packagePath, conditionTypes);
          if (fs.existsSync(conditionTypesPath)) {
            return conditionTypesPath;
          }
        }
      }
    }

    // 5. Infer from "main" field (.js -> .d.ts)
    if (packageJson.main) {
      const mainPath = packageJson.main;
      const dtsPath = mainPath.replace(/\.js$/, ".d.ts");
      const resolvedDtsPath = path.resolve(packagePath, dtsPath);
      if (fs.existsSync(resolvedDtsPath)) {
        return resolvedDtsPath;
      }
    }

    // 6. Fallback: dist/index.d.ts
    const fallbackPath = path.join(packagePath, "dist", "index.d.ts");
    if (fs.existsSync(fallbackPath)) {
      return fallbackPath;
    }

    // 7. Fallback: index.d.ts in root
    const rootDtsPath = path.join(packagePath, "index.d.ts");
    if (fs.existsSync(rootDtsPath)) {
      return rootDtsPath;
    }

    return null;
  }

  /**
   * Create API Extractor configuration for a package
   */
  private createExtractorConfig(
    packagePath: string,
    entryPoint: string,
    safePackageName: string,
    packageOutputDir: string,
  ): ExtractorConfig {
    // Find tsconfig
    const tsconfigPath = this.findTsConfig(packagePath);

    const configObject: IConfigFile = {
      projectFolder: packagePath,
      mainEntryPointFilePath: entryPoint,
      apiReport: {
        enabled: true,
        reportFileName: `${safePackageName}.api.md`,
        reportFolder: packageOutputDir,
        includeForgottenExports: true,
      },
      docModel: {
        enabled: true,
        apiJsonFilePath: path.join(
          packageOutputDir,
          `${safePackageName}.api.json`,
        ),
      },
      dtsRollup: {
        enabled: false,
      },
      tsdocMetadata: {
        enabled: false,
      },
      messages: {
        extractorMessageReporting: {
          // Suppress common non-critical messages
          "ae-missing-release-tag": { logLevel: ExtractorLogLevel.None },
          "ae-unresolved-link": { logLevel: ExtractorLogLevel.Warning },
        },
        tsdocMessageReporting: {
          default: { logLevel: ExtractorLogLevel.None },
        },
      },
    };

    // Add compiler config if tsconfig exists
    if (tsconfigPath) {
      configObject.compiler = {
        tsconfigFilePath: tsconfigPath,
      };
    }

    return ExtractorConfig.prepare({
      configObject,
      configObjectFullPath: path.join(packagePath, "api-extractor.json"),
      packageJsonFullPath: path.join(packagePath, "package.json"),
    });
  }

  /**
   * Find tsconfig.json for a package
   */
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

  /**
   * Run API Extractor with the given configuration
   */
  private runExtractor(config: ExtractorConfig): ExtractorResult {
    return Extractor.invoke(config, {
      localBuild: true,
      showVerboseMessages: this.verbose,
      showDiagnostics: this.verbose,
      messageCallback: (message) => {
        // Suppress messages unless verbose
        if (this.verbose) {
          console.log(`[api-extractor] ${message.text}`);
        }
        // Mark all messages as handled to prevent console output
        message.handled = true;
      },
    });
  }
}

/**
 * Read package.json and extract package info
 * @param packagePath - Absolute path to the package directory
 * @returns PackageInfo or null if package.json doesn't exist
 */
export function readPackageInfo(packagePath: string): PackageInfo | null {
  const packageJsonPath = path.join(packagePath, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    return null;
  }

  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
    const runner = new ApiExtractorRunner("");
    const typesEntryPoint = runner.findEntryPoint(packagePath);

    return {
      name: packageJson.name,
      version: packageJson.version,
      path: packagePath,
      typesEntryPoint: typesEntryPoint ?? undefined,
    };
  } catch {
    return null;
  }
}
