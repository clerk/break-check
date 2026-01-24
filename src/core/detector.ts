/**
 * Breaking Changes Detector - Orchestrates the detection workflow
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { SnapiConfig, resolvePackagePaths } from "../config.js";
import { ApiExtractorRunner, readPackageInfo } from "../utils/api-extractor.js";
import { ApiDiffAnalyzer } from "../analyzers/api-diff.js";
import { VersionAnalyzer } from "../analyzers/version.js";
import {
  AnalysisResult,
  PackageAnalysis,
  ApiSnapshot,
  ChangeType,
  PackageInfo,
} from "../types.js";

/**
 * Options for the detector
 */
export interface DetectorOptions {
  /** Whether to log verbose output */
  verbose?: boolean;
  /** Config file path (for resolving relative paths) */
  configPath?: string;
}

/**
 * Orchestrates API breaking changes detection
 */
export class BreakingChangesDetector {
  private extractor: ApiExtractorRunner;
  private diffAnalyzer: ApiDiffAnalyzer;
  private versionAnalyzer: VersionAnalyzer;
  private verbose: boolean;
  private configPath: string;

  constructor(
    private config: SnapiConfig,
    options: DetectorOptions = {},
  ) {
    this.verbose = options.verbose ?? false;
    this.configPath = options.configPath ?? process.cwd();
    this.extractor = new ApiExtractorRunner(
      this.resolveOutputDir(config.snapshotDir),
      { verbose: this.verbose },
    );
    this.diffAnalyzer = new ApiDiffAnalyzer();
    this.versionAnalyzer = new VersionAnalyzer();
  }

  /**
   * Generate snapshots for all configured packages
   * @returns Map of package name to snapshot
   */
  async generateSnapshots(): Promise<Map<string, ApiSnapshot>> {
    const snapshots = new Map<string, ApiSnapshot>();
    const packagePaths = resolvePackagePaths(this.config, this.configPath);

    for (const packagePath of packagePaths) {
      const packageInfo = readPackageInfo(packagePath);

      if (!packageInfo) {
        this.log(`Skipping ${packagePath}: no package.json found`);
        continue;
      }

      if (!packageInfo.typesEntryPoint) {
        this.log(
          `Skipping ${packageInfo.name}: no TypeScript declarations found`,
        );
        continue;
      }

      this.log(`Generating snapshot for ${packageInfo.name}...`);

      try {
        const snapshot = await this.extractor.generateSnapshot(packageInfo);
        snapshots.set(packageInfo.name, snapshot);
        this.log(`  ✓ Generated snapshot for ${packageInfo.name}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log(
          `  ✗ Failed to generate snapshot for ${packageInfo.name}: ${message}`,
        );
      }
    }

    return snapshots;
  }

  /**
   * Run full detection: generate current snapshots, compare to baseline
   * @param baselineDir - Directory containing baseline snapshots
   * @returns Complete analysis result
   */
  async detect(baselineDir: string): Promise<AnalysisResult> {
    const resolvedBaselineDir = path.resolve(this.configPath, baselineDir);

    // Generate current snapshots
    this.log("Generating current API snapshots...");
    const currentSnapshots = await this.generateSnapshots();

    if (currentSnapshots.size === 0) {
      return this.createEmptyResult();
    }

    // Analyze each package
    const packageAnalyses: PackageAnalysis[] = [];
    const packagePaths = resolvePackagePaths(this.config, this.configPath);

    for (const packagePath of packagePaths) {
      const packageInfo = readPackageInfo(packagePath);
      if (!packageInfo) continue;

      const currentSnapshot = currentSnapshots.get(packageInfo.name);
      if (!currentSnapshot) continue;

      // Find baseline snapshot
      const baselineSnapshot = this.findBaselineSnapshot(
        resolvedBaselineDir,
        packageInfo.name,
      );

      const analysis = await this.analyzePackage(
        packageInfo,
        baselineSnapshot,
        currentSnapshot,
      );

      packageAnalyses.push(analysis);
    }

    return this.buildResult(packageAnalyses);
  }

  /**
   * Find baseline snapshot for a package
   */
  private findBaselineSnapshot(
    baselineDir: string,
    packageName: string,
  ): ApiSnapshot | null {
    const safePackageName = packageName.replace(/^@/, "").replace(/\//g, "__");
    const apiJsonPath = path.join(
      baselineDir,
      safePackageName,
      `${safePackageName}.api.json`,
    );

    if (!fs.existsSync(apiJsonPath)) {
      this.log(`No baseline found for ${packageName}`);
      return null;
    }

    // Read version from the baseline snapshot metadata or package
    // For now, we'll use "unknown" as we don't store version in snapshot
    return {
      packageName,
      packagePath: "",
      version: "unknown",
      timestamp: "",
      apiJsonPath,
      apiReportPath: "",
    };
  }

  /**
   * Analyze a single package
   */
  private async analyzePackage(
    packageInfo: PackageInfo,
    baselineSnapshot: ApiSnapshot | null,
    currentSnapshot: ApiSnapshot,
  ): Promise<PackageAnalysis> {
    let changes: ApiChange[] = [];
    let previousVersion = "0.0.0";

    if (baselineSnapshot) {
      this.log(`Comparing ${packageInfo.name}...`);

      // Get previous version from baseline package.json if available
      previousVersion = baselineSnapshot.version;
      if (previousVersion === "unknown") {
        // Try to extract from the api.json metadata
        try {
          const apiJson = JSON.parse(
            fs.readFileSync(baselineSnapshot.apiJsonPath, "utf-8"),
          );
          // API Extractor stores package name but not version directly
          // We'll use the current version minus assumed patch for comparison
          previousVersion = this.inferPreviousVersion(packageInfo.version);
        } catch {
          previousVersion = "0.0.0";
        }
      }

      changes = this.diffAnalyzer.analyze(
        baselineSnapshot.apiJsonPath,
        currentSnapshot.apiJsonPath,
      );
    } else {
      this.log(`No baseline for ${packageInfo.name}, treating as new package`);
    }

    const hasBreakingChanges = changes.some(
      (c) => c.type === ChangeType.BREAKING,
    );
    const recommendedBump = this.versionAnalyzer.getRecommendedBump(changes);
    const actualBump = this.versionAnalyzer.getActualBump(
      previousVersion,
      packageInfo.version,
    );
    const isValidBump = this.versionAnalyzer.isValidBump(
      recommendedBump,
      actualBump,
    );

    return {
      packageName: packageInfo.name,
      packagePath: packageInfo.path,
      version: {
        current: packageInfo.version,
        previous: previousVersion,
      },
      changes,
      hasBreakingChanges,
      recommendedVersionBump: recommendedBump,
      actualVersionBump: actualBump ?? undefined,
      isValidBump,
    };
  }

  /**
   * Infer a previous version (simple heuristic)
   */
  private inferPreviousVersion(currentVersion: string): string {
    const parsed = this.versionAnalyzer.parseSemver(currentVersion);
    if (!parsed) return "0.0.0";

    // Assume patch bump from previous
    if (parsed.patch > 0) {
      return `${parsed.major}.${parsed.minor}.${parsed.patch - 1}`;
    }
    if (parsed.minor > 0) {
      return `${parsed.major}.${parsed.minor - 1}.0`;
    }
    if (parsed.major > 0) {
      return `${parsed.major - 1}.0.0`;
    }
    return "0.0.0";
  }

  /**
   * Build the final analysis result
   */
  private buildResult(packages: PackageAnalysis[]): AnalysisResult {
    const summary = this.buildSummary(packages);

    return {
      timestamp: new Date().toISOString(),
      packages,
      hasBreakingChanges: packages.some((p) => p.hasBreakingChanges),
      summary,
    };
  }

  /**
   * Build summary statistics
   */
  private buildSummary(packages: PackageAnalysis[]): AnalysisResult["summary"] {
    let breakingChanges = 0;
    let nonBreakingChanges = 0;
    let additions = 0;
    let packagesWithChanges = 0;

    for (const pkg of packages) {
      if (pkg.changes.length > 0) {
        packagesWithChanges++;
      }

      for (const change of pkg.changes) {
        switch (change.type) {
          case ChangeType.BREAKING:
            breakingChanges++;
            break;
          case ChangeType.NON_BREAKING:
            nonBreakingChanges++;
            break;
          case ChangeType.ADDITION:
            additions++;
            break;
        }
      }
    }

    return {
      totalPackages: packages.length,
      packagesWithChanges,
      breakingChanges,
      nonBreakingChanges,
      additions,
    };
  }

  /**
   * Create an empty result
   */
  private createEmptyResult(): AnalysisResult {
    return {
      timestamp: new Date().toISOString(),
      packages: [],
      hasBreakingChanges: false,
      summary: {
        totalPackages: 0,
        packagesWithChanges: 0,
        breakingChanges: 0,
        nonBreakingChanges: 0,
        additions: 0,
      },
    };
  }

  /**
   * Resolve output directory relative to config
   */
  private resolveOutputDir(dir: string): string {
    return path.resolve(path.dirname(this.configPath), dir);
  }

  /**
   * Log a message if verbose mode is enabled
   */
  private log(message: string): void {
    if (this.verbose) {
      console.log(message);
    }
  }
}

// Re-export ApiChange for convenience
import type { ApiChange } from "../types.js";
