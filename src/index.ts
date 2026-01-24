/**
 * @clerk/snapi - API breaking changes detection for TypeScript packages
 */

// Types
export {
  ChangeType,
  ChangeSeverity,
  type ChangeCategory,
  type ApiChange,
  type PackageAnalysis,
  type AnalysisResult,
  type ApiSnapshot,
  type PackageInfo,
} from "./types.js";

// Config
export {
  CONFIG_FILE_NAME,
  ConfigSchema,
  type SnapiConfig,
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
  readPackageInfo,
} from "./utils/api-extractor.js";
