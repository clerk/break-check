/**
 * Breaking Changes Detector - Orchestrates the detection workflow
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  CONFIG_FILE_NAME,
  DEFAULT_AI_MODEL,
  BreakCheckConfig,
  resolvePackagePaths,
} from "../config.js";
import {
  ApiExtractorRunner,
  API_EXTRACTOR_PACKAGE,
  DISCOVERY_VERSION,
  METADATA_FILENAME,
  LEGACY_METADATA_FILENAME,
  getApiExtractorVersion,
  readPackageInfo,
  isHashedChunkSubpath,
  makeSubpathMatcher,
} from "../utils/api-extractor.js";
import { ApiDiffAnalyzer } from "../analyzers/api-diff.js";
import { VersionAnalyzer } from "../analyzers/version.js";
import { AiChangeAnalyzer } from "../analyzers/ai-analyzer.js";
import { makeAcknowledgedMatcher } from "../utils/acknowledged.js";
import { findUnresolvableReference } from "../utils/exports-resolution.js";
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
  SkippedEntry,
} from "../types.js";
import * as crypto from "node:crypto";

/**
 * Guard against path traversal in baseline metadata. `writeSnapshotMetadata`
 * always records `apiJsonFile` / `apiReportFile` as bare `path.basename`
 * filenames, so any value carrying a path separator, a `.`/`..` segment, or a
 * NUL is malformed (or a tampered/committed baseline trying to escape the
 * package directory once it is `path.join`ed). Reject anything that is not a
 * single contained path segment so a crafted snapshot can't read an arbitrary
 * file off disk.
 */
function isContainedFilename(name: string): boolean {
  return (
    name.length > 0 &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("\0") &&
    path.basename(name) === name
  );
}

/**
 * Options for the detector
 */
export interface DetectorOptions {
  /** Whether to log verbose output */
  verbose?: boolean;
  /** Config file path (for resolving relative paths) */
  configPath?: string;
  /**
   * Hard-disable the AI analyzer, even when BREAK_CHECK_ANTHROPIC_API_KEY is set or
   * `config.ai.enabled === true`. CLI's `--no-ai` flag wires through here.
   */
  disableAi?: boolean;
  /**
   * Override the AI model. Highest priority. When undefined,
   * `BREAK_CHECK_AI_MODEL` env var and `config.ai.model` are consulted.
   */
  aiModel?: string;
  /**
   * Force-enable (true) or force-disable (false) applying the model's
   * `breaking -> non-breaking` downgrades. When undefined,
   * `BREAK_CHECK_AI_APPLY_DOWNGRADES` and `config.ai.applyDowngrades` are
   * consulted.
   */
  aiApplyDowngrades?: boolean;
  /**
   * Force-enable (true) or force-disable (false) the missed-breaks audit (which
   * also reviews additions-only diffs). When undefined, `BREAK_CHECK_AI_SCAN`
   * and `config.ai.scanForMissed` are consulted.
   */
  aiScanForMissed?: boolean;
  /** Inject a pre-built AI analyzer (used by tests). Overrides all other AI config. */
  aiAnalyzer?: AiChangeAnalyzer;
}

const snapshotKey = (packageName: string, subpath: string): string =>
  `${packageName}#${subpath}`;

const SCHEMA_VERSION_WITH_PRODUCER_STAMP = 3;

/**
 * Thrown when a baseline is refused because its recorded producer disagrees
 * with the running break-check (API Extractor major, or discovery version). It is a
 * distinct type so `cli.ts` can map it to a dedicated exit code, letting CI
 * recognize "incompatible baseline" and rebuild it rather than treating it as
 * a generic failure or as detected breaking changes.
 */
export class IncompatibleBaselineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IncompatibleBaselineError";
  }
}

function parseMajor(version: string): number | null {
  const match = /^(\d+)\./.exec(version);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Orchestrates API breaking changes detection
 */
export class BreakingChangesDetector {
  private extractor: ApiExtractorRunner;
  private diffAnalyzer: ApiDiffAnalyzer;
  private versionAnalyzer: VersionAnalyzer;
  private aiAnalyzer: AiChangeAnalyzer | null = null;
  private aiInitialized = false;
  private aiApplyDowngrades: boolean;
  private aiScanForMissed: boolean;
  private acknowledgedMatcher: (
    packageName: string,
    change: ApiChange,
  ) => boolean;
  private resolvableSpecifierMatcher: (specifier: string) => boolean;
  private verbose: boolean;
  private configPath: string;
  private configDir: string;
  /**
   * Per-entry failures collected during the last `generateSnapshots()` or
   * `detect()` run. Populated by the orchestrator; reset on each call.
   */
  private skippedEntries: SkippedEntry[] = [];

  constructor(
    private config: BreakCheckConfig,
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
    this.aiApplyDowngrades = this.resolveAiFlag(
      detectorOptions.aiApplyDowngrades,
      "BREAK_CHECK_AI_APPLY_DOWNGRADES",
      this.config.ai?.applyDowngrades,
    );
    this.aiScanForMissed = this.resolveAiFlag(
      detectorOptions.aiScanForMissed,
      "BREAK_CHECK_AI_SCAN",
      this.config.ai?.scanForMissed,
    );
    this.acknowledgedMatcher = makeAcknowledgedMatcher(
      this.config.acknowledgedChanges ?? [],
    );
    this.resolvableSpecifierMatcher = makeSubpathMatcher(
      this.config.resolvableSpecifiers ?? [],
    );
  }

  private ensureAiAnalyzer(): AiChangeAnalyzer | null {
    if (this.aiInitialized) return this.aiAnalyzer;
    this.aiInitialized = true;
    this.aiAnalyzer = this.maybeCreateAiAnalyzer(this.detectorOptions);
    return this.aiAnalyzer;
  }

  /**
   * Resolve a tri-state AI toggle: explicit option wins, then a truthy env var,
   * then the config value, defaulting to false. Shared by the
   * apply-downgrades and missed-audit flags.
   */
  private resolveAiFlag(
    optionValue: boolean | undefined,
    envName: string,
    configValue: boolean | undefined,
  ): boolean {
    if (typeof optionValue === "boolean") return optionValue;
    const envFlag = process.env[envName];
    if (envFlag && envFlag !== "0" && envFlag.toLowerCase() !== "false") {
      return true;
    }
    return configValue ?? false;
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

    const apiKey = process.env.BREAK_CHECK_ANTHROPIC_API_KEY;
    const aiCfg = this.config.ai;
    const enabledOverride = aiCfg?.enabled;

    if (enabledOverride === false) return null;
    if (enabledOverride === true && !apiKey) {
      throw new Error(
        "config.ai.enabled is true but BREAK_CHECK_ANTHROPIC_API_KEY is not set in the environment.",
      );
    }
    if (enabledOverride === undefined && !apiKey) return null;

    const model =
      options.aiModel ??
      process.env.BREAK_CHECK_AI_MODEL ??
      aiCfg?.model ??
      DEFAULT_AI_MODEL;
    return new AiChangeAnalyzer({
      apiKey: apiKey as string,
      model,
      maxChangesPerCall: aiCfg?.maxChangesPerCall ?? 80,
      verbose: this.verbose,
      // Two orthogonal knobs. applyDowngrades decides whether a
      // breaking -> non-breaking verdict is acted on or just recorded as a
      // suggestion. scanForMissed runs the audit and swaps the focused verdict
      // context for the both-surface diff that audit needs.
      applyDowngrades: this.aiApplyDowngrades,
      scanForMissed: this.aiScanForMissed,
    });
  }

  /**
   * Skipped entries from the last generate/detect call. The set is cleared
   * at the start of each `generateSnapshots()` invocation.
   */
  get lastSkippedEntries(): readonly SkippedEntry[] {
    return this.skippedEntries;
  }

  /**
   * Generate snapshots for every (package, subpath) entry.
   * Map keys are `${packageName}#${subpath}`.
   *
   * Per-entry extraction failures (the typical case: API Extractor crashing
   * on an ambient-global augmentation or a `.d.ts` outside `dist/`) are
   * reported as warnings on stderr and collected in `lastSkippedEntries`,
   * but the run continues. Only package-level fatals (missing package.json,
   * zero discoverable entries) still throw, since those usually indicate a
   * broken config rather than one weird subpath.
   */
  async generateSnapshots(): Promise<Map<string, ApiSnapshot>> {
    const snapshots = new Map<string, ApiSnapshot>();
    const packagePaths = resolvePackagePaths(this.config, this.configPath);
    const fatals: string[] = [];
    this.skippedEntries = [];

    for (const packagePath of packagePaths) {
      const packageInfo = readPackageInfo(packagePath, {
        ignoreSubpaths: this.config.ignoreSubpaths,
        ignoreHashedChunks: this.config.ignoreHashedChunks,
      });

      if (!packageInfo) {
        fatals.push(`${packagePath}: no package.json found`);
        continue;
      }

      if (packageInfo.entries.length === 0) {
        fatals.push(
          `${packageInfo.name}: no TypeScript declarations found (no \`types\`/\`exports\` types resolved)`,
        );
        continue;
      }

      this.log(
        `Generating snapshot for ${packageInfo.name} (${packageInfo.entries.length} entr${packageInfo.entries.length === 1 ? "y" : "ies"})...`,
      );

      const packageSnapshots: ApiSnapshot[] = [];

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
          const reason = error instanceof Error ? error.message : String(error);
          this.skippedEntries.push({
            packageName: packageInfo.name,
            subpath: entry.subpath,
            reason,
          });
          process.stderr.write(
            `[break-check] warning: skipping ${packageInfo.name} ${entry.subpath}: ${reason}\n`,
          );
        }
      }

      // Always write the package-level metadata for whatever entries succeeded;
      // a partial baseline is still useful for the comparison step.
      if (packageSnapshots.length > 0) {
        this.extractor.writePackageMetadata(packageInfo, packageSnapshots);
      }
    }

    if (fatals.length > 0) {
      throw new Error(
        [
          "Failed to generate API snapshots:",
          ...fatals.map((f) => `  - ${f}`),
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
        ignoreHashedChunks: this.config.ignoreHashedChunks,
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
    // Prefer the current metadata filename; fall back to the pre-rename name so
    // baselines committed before the snapi -> break-check rename still load.
    let metadataPath = path.join(packageDir, METADATA_FILENAME);
    if (!fs.existsSync(metadataPath)) {
      const legacyMetadataPath = path.join(
        packageDir,
        LEGACY_METADATA_FILENAME,
      );
      if (fs.existsSync(legacyMetadataPath)) {
        metadataPath = legacyMetadataPath;
      }
    }

    if (!fs.existsSync(packageDir)) {
      this.log(`No baseline found for ${packageName}`);
      return [];
    }

    const metadata = this.readSnapshotMetadata(metadataPath);

    this.assertCompatibleProducer(metadata, packageName, metadataPath);
    this.assertCompatibleDiscovery(metadata, packageName, metadataPath);

    if (
      metadata &&
      typeof metadata.schemaVersion === "number" &&
      metadata.schemaVersion >= 2 &&
      metadata.entries
    ) {
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
    breakCheckVersion?: string;
    discoveryVersion?: number;
    apiExtractorPackage?: string;
    apiExtractorVersion?: string;
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
        breakCheckVersion?: unknown;
        discoveryVersion?: unknown;
        apiExtractorPackage?: unknown;
        apiExtractorVersion?: unknown;
        packagePath?: unknown;
        version?: unknown;
        timestamp?: unknown;
        entries?: unknown;
      };

      const result: {
        schemaVersion?: number;
        breakCheckVersion?: string;
        discoveryVersion?: number;
        apiExtractorPackage?: string;
        apiExtractorVersion?: string;
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
      if (typeof parsed.breakCheckVersion === "string") {
        result.breakCheckVersion = parsed.breakCheckVersion;
      }
      if (typeof parsed.discoveryVersion === "number") {
        result.discoveryVersion = parsed.discoveryVersion;
      }
      if (typeof parsed.apiExtractorPackage === "string") {
        result.apiExtractorPackage = parsed.apiExtractorPackage;
      }
      if (typeof parsed.apiExtractorVersion === "string") {
        result.apiExtractorVersion = parsed.apiExtractorVersion;
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
            const apiJsonFile = cast.apiJsonFile as string;
            // Drop entries whose recorded filenames aren't plain, contained
            // names; see isContainedFilename. Defends against a tampered or
            // committed baseline traversing out of the package directory.
            if (!isContainedFilename(apiJsonFile)) continue;
            const apiReportFile =
              typeof cast.apiReportFile === "string" &&
              isContainedFilename(cast.apiReportFile)
                ? cast.apiReportFile
                : null;
            entries.push({
              subpath: cast.subpath as string,
              apiJsonFile,
              apiReportFile,
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
   * Refuse a baseline whose recorded API Extractor major version disagrees with
   * the one break-check is running. Different majors of `@microsoft/api-extractor`
   * can rename or restructure fields in the `.api.json` shape that
   * `parseApiJson` reads by hand, which silently produces nonsense diffs
   * (typically mass false-positive removals). Failing fast forces the user to
   * regenerate the baseline before the diff runs.
   *
   * Pre-stamping baselines (schemaVersion < 3) have no producer fingerprint;
   * we warn but proceed since we cannot prove a mismatch, and breaking every
   * existing baseline on a break-check minor that didn't touch AE would be hostile.
   */
  private assertCompatibleProducer(
    metadata: ReturnType<typeof this.readSnapshotMetadata>,
    packageName: string,
    metadataPath: string,
  ): void {
    if (!metadata) return;

    const baselineAeVersion = metadata.apiExtractorVersion;
    if (!baselineAeVersion) {
      if (
        typeof metadata.schemaVersion === "number" &&
        metadata.schemaVersion < SCHEMA_VERSION_WITH_PRODUCER_STAMP
      ) {
        process.stderr.write(
          `[break-check] warning: baseline for ${packageName} predates producer-version stamping ` +
            `(schemaVersion ${metadata.schemaVersion} at ${metadataPath}). ` +
            `Regenerate with \`break-check snapshot\` to enable API Extractor drift detection.\n`,
        );
      }
      return;
    }

    const runningAeVersion = getApiExtractorVersion();
    const baselineMajor = parseMajor(baselineAeVersion);
    const runningMajor = parseMajor(runningAeVersion);

    if (
      baselineMajor !== null &&
      runningMajor !== null &&
      baselineMajor !== runningMajor
    ) {
      throw new IncompatibleBaselineError(
        `Baseline for ${packageName} was produced by ${API_EXTRACTOR_PACKAGE} ` +
          `v${baselineAeVersion}; this break-check runs v${runningAeVersion} ` +
          `(major version mismatch). The .api.json shape is not guaranteed ` +
          `compatible across API Extractor majors, so the diff would be ` +
          `unreliable. Regenerate the baseline with \`break-check snapshot\` ` +
          `against the baseline ref, then retry.`,
      );
    }
  }

  /**
   * Refuse a baseline whose entry-point discovery semantics differ from the
   * running break-check. When discovery changes which subpaths are enumerated (e.g.
   * #37's wildcard expansion), an older baseline covers a smaller surface, so
   * the diff reports every newly discovered subpath as a phantom addition.
   * Failing fast forces a regeneration against the baseline ref, mirroring the
   * API Extractor major gate above.
   *
   * Baselines that predate discovery-version stamping but still carry the
   * producer stamp (schemaVersion >= 3) are also refused: we cannot prove
   * their surface matches. Truly old baselines (schemaVersion < 3) fall
   * through to the producer-stamp warning instead, since breaking every
   * legacy baseline would be hostile and the per-subpath guard keeps their
   * reports from ballooning.
   */
  private assertCompatibleDiscovery(
    metadata: ReturnType<typeof this.readSnapshotMetadata>,
    packageName: string,
    metadataPath: string,
  ): void {
    if (!metadata) return;

    const baselineDiscovery = metadata.discoveryVersion;

    if (typeof baselineDiscovery === "number") {
      if (baselineDiscovery < DISCOVERY_VERSION) {
        throw new IncompatibleBaselineError(
          `Baseline for ${packageName} was produced with break-check discovery ` +
            `version ${baselineDiscovery}; this break-check uses discovery version ` +
            `${DISCOVERY_VERSION}. Entry-point discovery changed between them, ` +
            `so the baseline enumerates a different API surface and the diff ` +
            `would report newly discovered subpaths as phantom additions. ` +
            `Regenerate the baseline with \`break-check snapshot\` against the ` +
            `baseline ref, then retry.`,
        );
      }
      return;
    }

    if (
      typeof metadata.schemaVersion === "number" &&
      metadata.schemaVersion >= SCHEMA_VERSION_WITH_PRODUCER_STAMP
    ) {
      throw new IncompatibleBaselineError(
        `Baseline for ${packageName} (schemaVersion ${metadata.schemaVersion} ` +
          `at ${metadataPath}) predates break-check discovery-version stamping, so ` +
          `its API surface cannot be guaranteed to match this break-check's ` +
          `discovery (version ${DISCOVERY_VERSION}). Regenerate the baseline ` +
          `with \`break-check snapshot\` against the baseline ref, then retry.`,
      );
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

    // Drop baseline entries the user has opted out of (`ignoreSubpaths`, now
    // glob-aware) so we don't surface removal noise for them. Also drop
    // content-hashed bundler chunks: an older baseline produced before the
    // hashed-chunk filter still records them, and the current discovery no
    // longer enumerates them, so without this they'd read as phantom removals.
    // Filtering both sides identically reconciles old baselines without a
    // discovery-version bump.
    const ignoreMatch = makeSubpathMatcher(this.config.ignoreSubpaths ?? []);
    const visibleBaselineEntries = baselineEntries.filter(
      (s) =>
        !ignoreMatch(s.subpath) &&
        !(this.config.ignoreHashedChunks && isHashedChunkSubpath(s.subpath)),
    );

    const baselineBySubpath = new Map<string, ApiSnapshot>(
      visibleBaselineEntries.map((s) => [s.subpath, s]),
    );
    const currentEntries: PackageEntry[] = packageInfo.entries;

    // Current `.api.json` per subpath, so the AI reviewer can resolve a changed
    // type's usage sites (callers) across the package's other subpath rollups,
    // not just the one being diffed. See `buildFocusedSurfaceBlock`.
    const currentApiJsonBySubpath = new Map<string, string>();
    for (const entry of currentEntries) {
      const snap = currentSnapshots.get(
        snapshotKey(packageInfo.name, entry.subpath),
      );
      if (snap) currentApiJsonBySubpath.set(entry.subpath, snap.apiJsonPath);
    }

    if (baselineEntries.length > 0) {
      // Use the baseline's recorded version, falling back to a heuristic.
      previousVersion = baselineEntries[0].version;
      if (!previousVersion || previousVersion === "unknown") {
        previousVersion = this.inferPreviousVersion(packageInfo.version);
      }
    } else {
      this.log(`No baseline for ${packageInfo.name}, treating as new package`);
    }

    // 1. Diff every current subpath against its baseline entry.
    for (const entry of currentEntries) {
      const currentSnap = currentSnapshots.get(
        snapshotKey(packageInfo.name, entry.subpath),
      );
      if (!currentSnap) continue;

      const baselineSnap = baselineBySubpath.get(entry.subpath);

      // A current subpath with no baseline entry.
      if (!baselineSnap) {
        // No baseline at all for this package: it's the first run against a
        // new package, so reporting hundreds of "added" members is just
        // noise. Stay silent.
        if (visibleBaselineEntries.length === 0) {
          continue;
        }
        // The package IS baselined but this specific subpath is new (a
        // genuine new export, a coverage bump, or a discovery change that
        // newly enumerates it). Collapse it to a single "new subpath"
        // addition instead of diffing every member against an empty surface
        // and flooding the report with one addition per exported member.
        // Symmetric with the subpath-removal handling below.
        const memberCount = this.diffAnalyzer.analyze(
          null,
          currentSnap.apiJsonPath,
        ).length;
        const addition = this.buildSubpathAdditionChange(
          entry.subpath,
          memberCount,
        );
        allChanges.push(addition);
        continue;
      }

      this.log(`Comparing ${packageInfo.name} ${entry.subpath}...`);
      let entryChanges = this.diffAnalyzer.analyze(
        baselineSnap.apiJsonPath,
        currentSnap.apiJsonPath,
      );

      // Deterministic guard (runs before the AI sees the changes): flag any
      // breaking change whose new signature references a module specifier
      // consumers can't resolve (an export-blocked / internal-chunk dependency
      // subpath). The AI may not downgrade a flagged change, even under
      // --ai-apply-downgrades. See `findUnresolvableReference`.
      this.flagUnresolvableReferences(entryChanges, packageInfo.path);

      const ai = this.ensureAiAnalyzer();
      // No rule-based changes means baseline and current matched for this
      // entry, so there is nothing to review. We deliberately do not invoke the
      // AI here, even with the missed-breaks audit on: with no change to anchor
      // against there is nothing for it to find. The audit runs alongside an
      // entry that does have changes.
      if (ai && entryChanges.length > 0) {
        const hasNonAdditionChange = entryChanges.some(
          (c) => c.type !== ChangeType.ADDITION,
        );
        // Additions-only diffs are only worth a call for the missed-breaks
        // audit; there is nothing to confirm, escalate, or downgrade otherwise.
        if (hasNonAdditionChange || this.aiScanForMissed) {
          this.log(
            `Running AI review for ${packageInfo.name} ${entry.subpath}...`,
          );
          const siblingCurrentApiJsonPaths = Array.from(
            currentApiJsonBySubpath.entries(),
          )
            .filter(([subpath]) => subpath !== entry.subpath)
            .map(([, apiJsonPath]) => apiJsonPath);
          entryChanges = await ai.analyze(entryChanges, {
            packageName: `${packageInfo.name} (${entry.subpath})`,
            baselineApiJsonPath: baselineSnap.apiJsonPath,
            currentApiJsonPath: currentSnap.apiJsonPath,
            siblingCurrentApiJsonPaths,
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

    // 3. Apply maintainer acknowledgements last: a breaking change the config
    // greens is flipped to non-breaking (recording the rule-based verdict in
    // `ruleBasedType`), unconditionally and regardless of the AI's opinion. This
    // is the explicit escape hatch for a verified-safe change the differ (and
    // even the AI) still flags. Running it over the assembled list covers
    // rule-based, AI-escalated/discovered, and synthesized subpath changes.
    const acknowledgedChanges = allChanges.map((change) => {
      if (
        change.type !== ChangeType.BREAKING ||
        !this.acknowledgedMatcher(packageInfo.name, change)
      ) {
        return change;
      }
      return {
        ...change,
        type: ChangeType.NON_BREAKING,
        severity: ChangeSeverity.MINOR,
        ruleBasedType: change.ruleBasedType ?? change.type,
        acknowledged: true,
      };
    });

    const hasBreakingChanges = acknowledgedChanges.some(
      (c) => c.type === ChangeType.BREAKING,
    );
    const recommendedBump =
      this.versionAnalyzer.getRecommendedBump(acknowledgedChanges);
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
      changes: acknowledgedChanges,
      hasBreakingChanges,
      recommendedVersionBump: recommendedBump,
      actualVersionBump: actualBump ?? undefined,
      isValidBump,
      aiReviewedBy,
    };
  }

  /**
   * Mark (and, where safe, escalate) any change whose new signature introduces a
   * reference to a non-resolvable module specifier. `fromDir` is the analyzed
   * package directory, from which the dependency's `package.json` exports map is
   * resolved (walking up `node_modules`).
   *
   * - A change the rule pass already flagged `breaking` is marked
   *   `unresolvableReference` so the AI cannot downgrade it (the reported issue
   *   #60 class). Either a deterministic `exports` block or the coarse
   *   `/_chunks/` heuristic qualifies, since marking an already-breaking change
   *   only ever prevents a relaxation, never manufactures a break.
   * - A `non-breaking` modification is escalated to breaking ONLY when the
   *   reference is *deterministically* blocked (resolved against the dependency's
   *   `exports`), e.g. a newly-added optional parameter whose type lives in an
   *   export-blocked subpath. The heuristic is deliberately NOT used to escalate,
   *   so a chunk-shaped name can never invent a breaking change.
   * - Additions are left alone: a brand-new export is not a breaking change even
   *   when its type is unusable downstream.
   */
  private flagUnresolvableReferences(
    changes: ApiChange[],
    fromDir: string,
  ): void {
    for (const change of changes) {
      if (change.type === ChangeType.ADDITION) continue;
      if (change.unresolvableReference) continue;
      const hit = findUnresolvableReference(
        change,
        fromDir,
        this.resolvableSpecifierMatcher,
      );
      if (!hit) continue;

      if (change.type === ChangeType.BREAKING) {
        change.unresolvableReference = true;
        change.unresolvableSpecifier = hit.specifier;
      } else if (hit.deterministic) {
        change.ruleBasedType = change.ruleBasedType ?? change.type;
        change.type = ChangeType.BREAKING;
        change.severity = ChangeSeverity.MAJOR;
        change.unresolvableReference = true;
        change.unresolvableSpecifier = hit.specifier;
      }
    }
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

  /**
   * Synthesize a single ADDITION for a subpath that exists in the current
   * build but has no baseline entry. We deliberately do NOT enumerate the
   * subpath's members: when a package gains a subpath (genuine new export, a
   * coverage bump, or a discovery change that newly enumerates a surface),
   * diffing every member against an empty baseline floods the report with
   * one addition per export. Collapsing to a single change keeps the report
   * reviewable and the recommended bump (ADDITION -> minor) correct.
   */
  private buildSubpathAdditionChange(
    subpath: string,
    memberCount: number,
  ): ApiChange {
    const suffix =
      memberCount > 0
        ? ` (${memberCount} exported member${memberCount === 1 ? "" : "s"})`
        : "";
    const description = `New subpath export \`${subpath}\`${suffix}`;
    const idSource = ["subpath-added", subpath].join("|");
    return {
      id: crypto
        .createHash("sha256")
        .update(idSource)
        .digest("hex")
        .slice(0, 12),
      type: ChangeType.ADDITION,
      severity: ChangeSeverity.MINOR,
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

    const result: AnalysisResult = {
      timestamp: new Date().toISOString(),
      packages,
      hasBreakingChanges: packages.some((p) => p.hasBreakingChanges),
      summary,
    };
    if (this.skippedEntries.length > 0) {
      result.skippedEntries = [...this.skippedEntries];
    }
    // The analyzer instance is memoized by ensureAiAnalyzer and accumulates
    // review gaps across every (package, subpath) call, so read it once here.
    const incompleteReviews = this.aiAnalyzer?.incompleteReviews ?? [];
    if (incompleteReviews.length > 0) {
      result.incompleteReviews = [...incompleteReviews];
    }
    return result;
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
