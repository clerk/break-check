/**
 * @clerk/snapi - API breaking changes detection for TypeScript packages
 */

// Types
export {
  ChangeType,
  ChangeSeverity,
  type ChangeCategory,
  type ApiChange,
  type AiAnalysis,
  type AiAnalysisSource,
  type PackageAnalysis,
  type AnalysisResult,
  type ApiSnapshot,
  type PackageInfo,
  type PackageEntry,
} from "./types.js";

// Config
export {
  CONFIG_FILE_NAME,
  DEFAULT_AI_MODEL,
  type SnapiConfig,
  type AiConfig,
  createDefaultConfig,
  findConfigFile,
  loadConfig,
  writeConfig,
  getConfigDir,
  resolvePackagePaths,
} from "./config.js";

// Utils
export {
  ApiExtractorRunner,
  type ApiExtractorRunnerOptions,
  type FindEntryPointsOptions,
  readPackageInfo,
} from "./utils/api-extractor.js";

// Core
export {
  BreakingChangesDetector,
  type DetectorOptions,
} from "./core/detector.js";

// Analyzers
export { ApiDiffAnalyzer } from "./analyzers/api-diff.js";
export { VersionAnalyzer } from "./analyzers/version.js";
export {
  AiChangeAnalyzer,
  type AiAnalyzerOptions,
  type AiPackageContext,
  type AiVerdict,
  type AiClient,
} from "./analyzers/ai-analyzer.js";

// Reporters
export {
  MarkdownReporter,
  type MarkdownReporterOptions,
} from "./reporters/markdown.js";
