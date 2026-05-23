/**
 * Breaking Changes Detector - Orchestrates the detection workflow
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  CONFIG_FILE_NAME,
  DEFAULT_AI_MODEL,
  SnapiConfig,
  resolvePackagePaths,
} from "../config.js";
import { ApiExtractorRunner, readPackageInfo } from "../utils/api-extractor.js";
import { ApiDiffAnalyzer } from "../analyzers/api-diff.js";
import { VersionAnalyzer } from "../analyzers/version.js";
import { AiChangeAnalyzer } from "../analyzers/ai-analyzer.js";
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
  /**
   * Hard-disable the AI analyzer, even when ANTHROPIC_API_KEY is set or
   * `config.ai.enabled === true`. CLI's `--no-ai` flag wires through here.
   */
  disableAi?: boolean;
  /** Override the AI model. Wins over config.ai.model. */
  aiModel?: string;
  /** Inject a pre-built AI analyzer (used by tests). Overrides all other AI config. */
  aiAnalyzer?: AiChangeAnalyzer;
}

/**
 * Orchestrates API breaking changes detection
 */
export class BreakingChangesDetector {
  private extractor: ApiExtractorRunner;
  private diffAnalyzer: ApiDiffAnalyzer;
  private versionAnalyzer: VersionAnalyzer;
  private aiAnalyzer: AiChangeAnalyzer | null;
  private verbose: boolean;
  private configPath: string;
  private configDir: string;

  constructor(
    private config: SnapiConfig,
    options: DetectorOptions = {},
  ) {
    this.verbose = options.verbose ?? false;
    this.configPath = path.resolve(
      options.configPath ?? path.join(process.cwd(), CONFIG_FILE_NAME),
    );
    this.configDir = path.dirname(this.configPath);
    this.extractor = new ApiExtractorRunner(
      this.resolveOutputDir(config.snapshotDir),
      { verbose: this.verbose },
    );
    this.diffAnalyzer = new ApiDiffAnalyzer();
    this.versionAnalyzer = new VersionAnalyzer();
    this.aiAnalyzer = this.maybeCreateAiAnalyzer(options);
  }

  /**
   * Whether the AI analyzer is active for this detector instance.
   */
  get aiEnabled(): boolean {
    return this.aiAnalyzer !== null;
  }

  /**
   * Summary stats reported by the AI analyzer across all packages so far.
   */
  get aiStats(): {
    enabled: boolean;
    model: string | null;
    reviewed: number;
    overridden: number;
    discovered: number;
  } {
    if (!this.aiAnalyzer) {
      return {
        enabled: false,
        model: null,
        reviewed: 0,
        overridden: 0,
        discovered: 0,
      };
    }
    return {
      enabled: true,
      model: this.config.ai?.model ?? DEFAULT_AI_MODEL,
      reviewed: this.aiAnalyzer.reviewedCount,
      overridden: this.aiAnalyzer.overriddenCount,
      discovered: this.aiAnalyzer.discoveredCount,
    };
  }

  private maybeCreateAiAnalyzer(
    options: DetectorOptions,
  ): AiChangeAnalyzer | null {
    if (options.aiAnalyzer) return options.aiAnalyzer;
    if (options.disableAi) return null;

    const apiKey = process.env.ANTHROPIC_API_KEY;
    const aiCfg = this.config.ai;
    const enabledOverride = aiCfg?.enabled;

    if (enabledOverride === false) return null;
    if (enabledOverride === true && !apiKey) {
      throw new Error(
        "config.ai.enabled is true but ANTHROPIC_API_KEY is not set in the environment.",
      );
    }
    if (enabledOverride === undefined && !apiKey) return null;

    const model = options.aiModel ?? aiCfg?.model ?? DEFAULT_AI_MODEL;
    return new AiChangeAnalyzer({
      apiKey: apiKey as string,
      model,
      maxChangesPerCall: aiCfg?.maxChangesPerCall ?? 80,
      verbose: this.verbose,
    });
  }

  /**
   * Generate snapshots for all configured packages
   * @returns Map of package name to snapshot
   */
  async generateSnapshots(): Promise<Map<string, ApiSnapshot>> {
    const snapshots = new Map<string, ApiSnapshot>();
    const packagePaths = resolvePackagePaths(this.config, this.configPath);
    const failures: string[] = [];

    for (const packagePath of packagePaths) {
      const packageInfo = readPackageInfo(packagePath);

      if (!packageInfo) {
        failures.push(`${packagePath}: no package.json found`);
        continue;
      }

      if (!packageInfo.typesEntryPoint) {
        failures.push(`${packageInfo.name}: no TypeScript declarations found`);
        continue;
      }

      this.log(`Generating snapshot for ${packageInfo.name}...`);

      try {
        const snapshot = await this.extractor.generateSnapshot(packageInfo);
        snapshots.set(packageInfo.name, snapshot);
        this.log(`  ✓ Generated snapshot for ${packageInfo.name}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${packageInfo.name}: ${message}`);
      }
    }

    if (failures.length > 0) {
      throw new Error(
        [
          "Failed to generate API snapshots:",
          ...failures.map((f) => `  - ${f}`),
        ].join("\n"),
      );
    }

    return snapshots;
  }

  /**
   * Run full detection: generate current snapshots, compare to baseline
   * @param baselineDir - Directory containing baseline snapshots
   * @returns Complete analysis result
   */
  async detect(baselineDir: string): Promise<AnalysisResult> {
    const resolvedBaselineDir = this.resolveConfigRelativePath(baselineDir);

    if (!fs.existsSync(resolvedBaselineDir)) {
      throw new Error(`Baseline directory not found: ${resolvedBaselineDir}`);
    }

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
    const metadataPath = path.join(
      baselineDir,
      safePackageName,
      "snapi.snapshot.json",
    );

    if (!fs.existsSync(apiJsonPath)) {
      this.log(`No baseline found for ${packageName}`);
      return null;
    }

    const metadata = this.readSnapshotMetadata(metadataPath);

    return {
      packageName,
      packagePath: metadata?.packagePath ?? "",
      version: metadata?.version ?? "unknown",
      timestamp: metadata?.timestamp ?? "",
      apiJsonPath,
      apiReportPath: "",
      metadataPath,
    };
  }

  private readSnapshotMetadata(
    metadataPath: string,
  ): { packagePath?: string; version?: string; timestamp?: string } | null {
    if (!fs.existsSync(metadataPath)) {
      return null;
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(metadataPath, "utf-8")) as {
        packagePath?: unknown;
        version?: unknown;
        timestamp?: unknown;
      };

      return {
        packagePath:
          typeof parsed.packagePath === "string"
            ? parsed.packagePath
            : undefined,
        version:
          typeof parsed.version === "string" ? parsed.version : undefined,
        timestamp:
          typeof parsed.timestamp === "string" ? parsed.timestamp : undefined,
      };
    } catch {
      return null;
    }
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
        previousVersion = this.inferPreviousVersion(packageInfo.version);
      }

      changes = this.diffAnalyzer.analyze(
        baselineSnapshot.apiJsonPath,
        currentSnapshot.apiJsonPath,
      );

      if (this.aiAnalyzer) {
        this.log(`Running AI review for ${packageInfo.name}...`);
        changes = await this.aiAnalyzer.analyze(changes, {
          packageName: packageInfo.name,
          baselineApiJsonPath: baselineSnapshot.apiJsonPath,
          currentApiJsonPath: currentSnapshot.apiJsonPath,
        });
      }
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
    const isValidBump =
      this.versionAnalyzer.isValidBump(recommendedBump, actualBump) ||
      !this.config.checkVersionBump;

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
    return this.resolveConfigRelativePath(dir);
  }

  private resolveConfigRelativePath(targetPath: string): string {
    return path.isAbsolute(targetPath)
      ? targetPath
      : path.resolve(this.configDir, targetPath);
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
