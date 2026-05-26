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
  ApiChange,
  ApiSnapshot,
  ChangeCategory,
  ChangeSeverity,
  ChangeType,
  PackageAnalysis,
  PackageEntry,
  PackageInfo,
} from "../types.js";
import * as crypto from "node:crypto";

/**
 * Options for the detector
 */
export interface DetectorOptions {
  /** Whether to log verbose output */
  verbose?: boolean;
  /** Config file path (for resolving relative paths) */
  configPath?: string;
  /**
   * Hard-disable the AI analyzer, even when SNAPI_ANTHROPIC_API_KEY is set or
   * `config.ai.enabled === true`. CLI's `--no-ai` flag wires through here.
   */
  disableAi?: boolean;
  /**
   * Override the AI model. Highest priority. When undefined,
   * `SNAPI_AI_MODEL` env var and `config.ai.model` are consulted.
   */
  aiModel?: string;
  /**
   * Force-enable (true) or force-disable (false) strict mode. Strict mode
   * runs the AI reviewer even for pure-additions diffs. When undefined,
   * `SNAPI_AI_STRICT` env var and `config.ai.strict` are consulted.
   */
  aiStrict?: boolean;
  /** Inject a pre-built AI analyzer (used by tests). Overrides all other AI config. */
  aiAnalyzer?: AiChangeAnalyzer;
}

const snapshotKey = (packageName: string, subpath: string): string =>
  `${packageName}#${subpath}`;

/**
 * Orchestrates API breaking changes detection
 */
export class BreakingChangesDetector {
  private extractor: ApiExtractorRunner;
  private diffAnalyzer: ApiDiffAnalyzer;
  private versionAnalyzer: VersionAnalyzer;
  private aiAnalyzer: AiChangeAnalyzer | null = null;
  private aiInitialized = false;
  private aiStrict: boolean;
  private verbose: boolean;
  private configPath: string;
  private configDir: string;

  constructor(
    private config: SnapiConfig,
    private detectorOptions: DetectorOptions = {},
  ) {
    this.verbose = detectorOptions.verbose ?? false;
    this.configPath = path.resolve(
      detectorOptions.configPath ?? path.join(process.cwd(), CONFIG_FILE_NAME),
    );
    this.configDir = path.dirname(this.configPath);
    this.extractor = new ApiExtractorRunner(
      this.resolveOutputDir(config.snapshotDir),
      { verbose: this.verbose },
    );
    this.diffAnalyzer = new ApiDiffAnalyzer();
    this.versionAnalyzer = new VersionAnalyzer();
    this.aiStrict = this.resolveStrict(detectorOptions);
  }

  private ensureAiAnalyzer(): AiChangeAnalyzer | null {
    if (this.aiInitialized) return this.aiAnalyzer;
    this.aiInitialized = true;
    this.aiAnalyzer = this.maybeCreateAiAnalyzer(this.detectorOptions);
    return this.aiAnalyzer;
  }

  private resolveStrict(options: DetectorOptions): boolean {
    if (typeof options.aiStrict === "boolean") return options.aiStrict;
    const envFlag = process.env.SNAPI_AI_STRICT;
    if (envFlag && envFlag !== "0" && envFlag.toLowerCase() !== "false") {
      return true;
    }
    return this.config.ai?.strict ?? false;
  }

  get aiEnabled(): boolean {
    return this.ensureAiAnalyzer() !== null;
  }

  get aiStats(): {
    enabled: boolean;
    model: string | null;
    reviewed: number;
    overridden: number;
    discovered: number;
  } {
    const ai = this.ensureAiAnalyzer();
    if (!ai) {
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
      model: ai.model,
      reviewed: ai.reviewedCount,
      overridden: ai.overriddenCount,
      discovered: ai.discoveredCount,
    };
  }

  private maybeCreateAiAnalyzer(
    options: DetectorOptions,
  ): AiChangeAnalyzer | null {
    if (options.aiAnalyzer) return options.aiAnalyzer;
    if (options.disableAi) return null;

    const apiKey = process.env.SNAPI_ANTHROPIC_API_KEY;
    const aiCfg = this.config.ai;
    const enabledOverride = aiCfg?.enabled;

    if (enabledOverride === false) return null;
    if (enabledOverride === true && !apiKey) {
      throw new Error(
        "config.ai.enabled is true but SNAPI_ANTHROPIC_API_KEY is not set in the environment.",
      );
    }
    if (enabledOverride === undefined && !apiKey) return null;

    const model =
      options.aiModel ??
      process.env.SNAPI_AI_MODEL ??
      aiCfg?.model ??
      DEFAULT_AI_MODEL;
    return new AiChangeAnalyzer({
      apiKey: apiKey as string,
      model,
      maxChangesPerCall: aiCfg?.maxChangesPerCall ?? 80,
      verbose: this.verbose,
    });
  }

  /**
   * Generate snapshots for every (package, subpath) entry.
   * Map keys are `${packageName}#${subpath}`.
   */
  async generateSnapshots(): Promise<Map<string, ApiSnapshot>> {
    const snapshots = new Map<string, ApiSnapshot>();
    const packagePaths = resolvePackagePaths(this.config, this.configPath);
    const failures: string[] = [];

    for (const packagePath of packagePaths) {
      const packageInfo = readPackageInfo(packagePath, {
        ignoreSubpaths: this.config.ignoreSubpaths,
      });

      if (!packageInfo) {
        failures.push(`${packagePath}: no package.json found`);
        continue;
      }

      if (packageInfo.entries.length === 0) {
        failures.push(
          `${packageInfo.name}: no TypeScript declarations found (no \`types\`/\`exports\` types resolved)`,
        );
        continue;
      }

      this.log(
        `Generating snapshot for ${packageInfo.name} (${packageInfo.entries.length} entr${packageInfo.entries.length === 1 ? "y" : "ies"})...`,
      );

      const packageSnapshots: ApiSnapshot[] = [];
      const entryFailures: string[] = [];

      for (const entry of packageInfo.entries) {
        try {
          const snapshot = await this.extractor.generateSnapshot(
            packageInfo,
            entry,
          );
          snapshots.set(snapshotKey(packageInfo.name, entry.subpath), snapshot);
          packageSnapshots.push(snapshot);
          this.log(`  ✓ ${packageInfo.name} ${entry.subpath}`);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          entryFailures.push(
            `${packageInfo.name} ${entry.subpath}: ${message}`,
          );
        }
      }

      // Always write the package-level metadata for whatever entries succeeded;
      // a partial baseline is still useful for the comparison step.
      if (packageSnapshots.length > 0) {
        this.extractor.writePackageMetadata(packageInfo, packageSnapshots);
      }

      failures.push(...entryFailures);
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

  async detect(baselineDir: string): Promise<AnalysisResult> {
    const resolvedBaselineDir = this.resolveConfigRelativePath(baselineDir);

    if (!fs.existsSync(resolvedBaselineDir)) {
      throw new Error(`Baseline directory not found: ${resolvedBaselineDir}`);
    }

    this.log("Generating current API snapshots...");
    const currentSnapshots = await this.generateSnapshots();

    if (currentSnapshots.size === 0) {
      return this.createEmptyResult();
    }

    const packageAnalyses: PackageAnalysis[] = [];
    const packagePaths = resolvePackagePaths(this.config, this.configPath);

    for (const packagePath of packagePaths) {
      const packageInfo = readPackageInfo(packagePath, {
        ignoreSubpaths: this.config.ignoreSubpaths,
      });
      if (!packageInfo) continue;

      const baselineEntries = this.readBaselineEntries(
        resolvedBaselineDir,
        packageInfo.name,
      );

      // If neither baseline nor current produced anything for this package,
      // skip silently (already counted in failures).
      if (packageInfo.entries.length === 0 && baselineEntries.length === 0) {
        continue;
      }

      const analysis = await this.analyzePackage(
        packageInfo,
        baselineEntries,
        currentSnapshots,
      );
      packageAnalyses.push(analysis);
    }

    return this.buildResult(packageAnalyses);
  }

  /**
   * Load every baseline entry for a package, supporting both v1 (single
   * `<safe>.api.json` per directory) and v2 (metadata-driven) layouts.
   */
  private readBaselineEntries(
    baselineDir: string,
    packageName: string,
  ): ApiSnapshot[] {
    const safePackageName = packageName.replace(/^@/, "").replace(/\//g, "__");
    const packageDir = path.join(baselineDir, safePackageName);
    const metadataPath = path.join(packageDir, "snapi.snapshot.json");

    if (!fs.existsSync(packageDir)) {
      this.log(`No baseline found for ${packageName}`);
      return [];
    }

    const metadata = this.readSnapshotMetadata(metadataPath);

    if (metadata && metadata.schemaVersion === 2 && metadata.entries) {
      return metadata.entries
        .map((entry) => {
          const apiJsonPath = path.join(packageDir, entry.apiJsonFile);
          if (!fs.existsSync(apiJsonPath)) return null;
          return {
            packageName,
            subpath: entry.subpath,
            packagePath: metadata.packagePath ?? "",
            version: metadata.version ?? "unknown",
            timestamp: metadata.timestamp ?? "",
            apiJsonPath,
            apiReportPath: entry.apiReportFile
              ? path.join(packageDir, entry.apiReportFile)
              : "",
            metadataPath,
          } satisfies ApiSnapshot;
        })
        .filter((s): s is ApiSnapshot => s !== null);
    }

    // v1 fallback: single root entry written as `<safe>.api.json`.
    const legacyApiJsonPath = path.join(
      packageDir,
      `${safePackageName}.api.json`,
    );
    if (!fs.existsSync(legacyApiJsonPath)) {
      this.log(`No baseline found for ${packageName}`);
      return [];
    }

    return [
      {
        packageName,
        subpath: ".",
        packagePath: metadata?.packagePath ?? "",
        version: metadata?.version ?? "unknown",
        timestamp: metadata?.timestamp ?? "",
        apiJsonPath: legacyApiJsonPath,
        apiReportPath: "",
        metadataPath,
      },
    ];
  }

  private readSnapshotMetadata(metadataPath: string): {
    schemaVersion?: number;
    packagePath?: string;
    version?: string;
    timestamp?: string;
    entries?: Array<{
      subpath: string;
      apiJsonFile: string;
      apiReportFile: string | null;
    }>;
  } | null {
    if (!fs.existsSync(metadataPath)) return null;

    try {
      const parsed = JSON.parse(fs.readFileSync(metadataPath, "utf-8")) as {
        schemaVersion?: unknown;
        packagePath?: unknown;
        version?: unknown;
        timestamp?: unknown;
        entries?: unknown;
      };

      const result: {
        schemaVersion?: number;
        packagePath?: string;
        version?: string;
        timestamp?: string;
        entries?: Array<{
          subpath: string;
          apiJsonFile: string;
          apiReportFile: string | null;
        }>;
      } = {};

      if (typeof parsed.schemaVersion === "number") {
        result.schemaVersion = parsed.schemaVersion;
      }
      if (typeof parsed.packagePath === "string") {
        result.packagePath = parsed.packagePath;
      }
      if (typeof parsed.version === "string") {
        result.version = parsed.version;
      }
      if (typeof parsed.timestamp === "string") {
        result.timestamp = parsed.timestamp;
      }
      if (Array.isArray(parsed.entries)) {
        const entries: Array<{
          subpath: string;
          apiJsonFile: string;
          apiReportFile: string | null;
        }> = [];
        for (const e of parsed.entries) {
          if (
            e &&
            typeof e === "object" &&
            typeof (e as Record<string, unknown>).subpath === "string" &&
            typeof (e as Record<string, unknown>).apiJsonFile === "string"
          ) {
            const cast = e as Record<string, unknown>;
            entries.push({
              subpath: cast.subpath as string,
              apiJsonFile: cast.apiJsonFile as string,
              apiReportFile:
                typeof cast.apiReportFile === "string"
                  ? (cast.apiReportFile as string)
                  : null,
            });
          }
        }
        result.entries = entries;
      }

      return result;
    } catch {
      return null;
    }
  }

  /**
   * Run per-entry diffs and aggregate them into a single PackageAnalysis.
   */
  private async analyzePackage(
    packageInfo: PackageInfo,
    baselineEntries: ApiSnapshot[],
    currentSnapshots: Map<string, ApiSnapshot>,
  ): Promise<PackageAnalysis> {
    const allChanges: ApiChange[] = [];
    let previousVersion = "0.0.0";
    let aiReviewedBy: string | undefined;

    // Drop baseline entries whose subpath is now in `ignoreSubpaths`. The
    // user has opted out of tracking these surfaces, so we must not surface
    // removal noise for them.
    const ignored = new Set(this.config.ignoreSubpaths ?? []);
    const visibleBaselineEntries = baselineEntries.filter(
      (s) => !ignored.has(s.subpath),
    );

    const baselineBySubpath = new Map<string, ApiSnapshot>(
      visibleBaselineEntries.map((s) => [s.subpath, s]),
    );
    const currentEntries: PackageEntry[] = packageInfo.entries;

    if (baselineEntries.length > 0) {
      // Use the baseline's recorded version, falling back to a heuristic.
      previousVersion = baselineEntries[0].version;
      if (!previousVersion || previousVersion === "unknown") {
        previousVersion = this.inferPreviousVersion(packageInfo.version);
      }
    } else {
      this.log(`No baseline for ${packageInfo.name}, treating as new package`);
    }

    // 1. Diff every current subpath. A subpath with no baseline diffs against
    // an empty surface so its public members surface as additions (and feed
    // into the recommended version bump).
    for (const entry of currentEntries) {
      const currentSnap = currentSnapshots.get(
        snapshotKey(packageInfo.name, entry.subpath),
      );
      if (!currentSnap) continue;

      const baselineSnap = baselineBySubpath.get(entry.subpath);

      // Skip the new-subpath addition path when there's no baseline at all
      // for this package; reporting hundreds of "added" items the first time
      // snapi runs against a package is just noise.
      if (!baselineSnap && visibleBaselineEntries.length === 0) {
        continue;
      }

      this.log(`Comparing ${packageInfo.name} ${entry.subpath}...`);
      let entryChanges = this.diffAnalyzer.analyze(
        baselineSnap ? baselineSnap.apiJsonPath : null,
        currentSnap.apiJsonPath,
      );

      const ai = this.ensureAiAnalyzer();
      // Skip AI review when this is a brand-new subpath (no baseline to
      // diff against). The reviewer expects both sides for context, and an
      // all-additions diff is exactly the case we already short-circuit.
      if (ai && entryChanges.length > 0 && baselineSnap) {
        const hasNonAdditionChange = entryChanges.some(
          (c) => c.type !== ChangeType.ADDITION,
        );
        if (hasNonAdditionChange || this.aiStrict) {
          this.log(
            `Running AI review for ${packageInfo.name} ${entry.subpath}...`,
          );
          entryChanges = await ai.analyze(entryChanges, {
            packageName: `${packageInfo.name} (${entry.subpath})`,
            baselineApiJsonPath: baselineSnap.apiJsonPath,
            currentApiJsonPath: currentSnap.apiJsonPath,
          });
          aiReviewedBy = ai.model;
        }
      }

      for (const c of entryChanges) c.subpath = entry.subpath;
      allChanges.push(...entryChanges);
    }

    // 2. Subpaths removed from current: synthesize one BREAKING change per
    // removal. Iterating `visibleBaselineEntries` (not the raw baseline list)
    // means a subpath the user now ignores doesn't get reported as a break
    // just because it's still in an older baseline.
    const currentSubpaths = new Set(currentEntries.map((e) => e.subpath));
    for (const baseline of visibleBaselineEntries) {
      if (currentSubpaths.has(baseline.subpath)) continue;
      allChanges.push(this.buildSubpathRemovalChange(baseline.subpath));
    }

    const hasBreakingChanges = allChanges.some(
      (c) => c.type === ChangeType.BREAKING,
    );
    const recommendedBump = this.versionAnalyzer.getRecommendedBump(allChanges);
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
      changes: allChanges,
      hasBreakingChanges,
      recommendedVersionBump: recommendedBump,
      actualVersionBump: actualBump ?? undefined,
      isValidBump,
      aiReviewedBy,
    };
  }

  private buildSubpathRemovalChange(subpath: string): ApiChange {
    const description = `Subpath export \`${subpath}\` was removed`;
    const idSource = ["subpath-removed", subpath].join("|");
    return {
      id: crypto
        .createHash("sha256")
        .update(idSource)
        .digest("hex")
        .slice(0, 12),
      type: ChangeType.BREAKING,
      severity: ChangeSeverity.MAJOR,
      category: "export" as ChangeCategory,
      name: subpath,
      description,
      subpath,
    };
  }

  private inferPreviousVersion(currentVersion: string): string {
    const parsed = this.versionAnalyzer.parseSemver(currentVersion);
    if (!parsed) return "0.0.0";

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

  private buildResult(packages: PackageAnalysis[]): AnalysisResult {
    const summary = this.buildSummary(packages);

    return {
      timestamp: new Date().toISOString(),
      packages,
      hasBreakingChanges: packages.some((p) => p.hasBreakingChanges),
      summary,
    };
  }

  private buildSummary(packages: PackageAnalysis[]): AnalysisResult["summary"] {
    let breakingChanges = 0;
    let nonBreakingChanges = 0;
    let additions = 0;
    let packagesWithChanges = 0;

    for (const pkg of packages) {
      if (pkg.changes.length > 0) packagesWithChanges++;
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

  private resolveOutputDir(dir: string): string {
    return this.resolveConfigRelativePath(dir);
  }

  private resolveConfigRelativePath(targetPath: string): string {
    return path.isAbsolute(targetPath)
      ? targetPath
      : path.resolve(this.configDir, targetPath);
  }

  private log(message: string): void {
    if (this.verbose) {
      console.log(message);
    }
  }
}
