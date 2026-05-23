/**
 * Core type definitions for snapi
 */

/**
 * Classification of API changes
 */
export enum ChangeType {
  /** Breaking change that requires major version bump */
  BREAKING = "breaking",
  /** Non-breaking change (minor) */
  NON_BREAKING = "non-breaking",
  /** New addition to the API */
  ADDITION = "addition",
}

/**
 * Severity level mapping to semver
 */
export enum ChangeSeverity {
  /** Breaking changes - requires major bump */
  MAJOR = "major",
  /** New features, non-breaking - requires minor bump */
  MINOR = "minor",
  /** Bug fixes, internal changes - patch bump */
  PATCH = "patch",
}

/**
 * Category of API element that changed
 */
export type ChangeCategory =
  | "export"
  | "function"
  | "interface"
  | "type"
  | "class"
  | "enum"
  | "variable";

/**
 * Where the AI verdict places a change relative to the rule-based analyzer
 */
export type AiAnalysisSource =
  | "rule-confirmed"
  | "rule-overridden"
  | "ai-discovered";

/**
 * AI-authored analysis attached to an ApiChange
 */
export interface AiAnalysis {
  source: AiAnalysisSource;
  /** Model's confidence in its verdict, 0..1 */
  confidence: number;
  /** Short explanation of why this verdict is correct */
  rationale: string;
  /** Migration guidance; only set when the final type is BREAKING */
  migration?: string;
  /** Model identifier that produced this verdict */
  model: string;
}

/**
 * Represents a single API change detected between versions
 */
export interface ApiChange {
  /** Unique identifier (hash of change details) */
  id: string;
  /** Type of change (authoritative; may be set by the AI reviewer) */
  type: ChangeType;
  /** Severity level */
  severity: ChangeSeverity;
  /** Category of the changed API element */
  category: ChangeCategory;
  /** Name of the changed API element */
  name: string;
  /** Human-readable description of the change */
  description: string;
  /** Code snippet before the change */
  beforeSnippet?: string;
  /** Code snippet after the change */
  afterSnippet?: string;
  /** Source location of the change */
  location?: {
    file: string;
    line?: number;
  };
  /** Original classification from the rule-based analyzer, set only if AI changed `type` */
  ruleBasedType?: ChangeType;
  /** Present when the AI analyzer reviewed (or produced) this change */
  aiAnalysis?: AiAnalysis;
}

/**
 * Analysis result for a single package
 */
export interface PackageAnalysis {
  /** Package name from package.json */
  packageName: string;
  /** Path to the package directory */
  packagePath: string;
  /** Version information */
  version: {
    /** Current version being analyzed */
    current: string;
    /** Previous/baseline version */
    previous: string;
  };
  /** List of detected changes */
  changes: ApiChange[];
  /** Whether any breaking changes were detected */
  hasBreakingChanges: boolean;
  /** Recommended semver bump based on changes */
  recommendedVersionBump: ChangeSeverity;
  /** Actual version bump (if versions differ) */
  actualVersionBump?: ChangeSeverity;
  /** Whether the actual bump satisfies the recommended bump */
  isValidBump: boolean;
}

/**
 * Overall analysis result across all packages
 */
export interface AnalysisResult {
  /** Timestamp of the analysis */
  timestamp: string;
  /** Analysis results per package */
  packages: PackageAnalysis[];
  /** Whether any package has breaking changes */
  hasBreakingChanges: boolean;
  /** Summary statistics */
  summary: {
    /** Total packages analyzed */
    totalPackages: number;
    /** Packages with at least one change */
    packagesWithChanges: number;
    /** Total breaking changes across all packages */
    breakingChanges: number;
    /** Total non-breaking changes */
    nonBreakingChanges: number;
    /** Total additions */
    additions: number;
  };
}

/**
 * API snapshot metadata
 */
export interface ApiSnapshot {
  /** Package name from package.json */
  packageName: string;
  /** Path to the package directory */
  packagePath: string;
  /** Package version at time of snapshot */
  version: string;
  /** ISO timestamp when snapshot was generated */
  timestamp: string;
  /** Path to the .api.md report file */
  apiReportPath: string;
  /** Path to the .api.json file */
  apiJsonPath: string;
  /** Path to snapi metadata for this snapshot */
  metadataPath: string;
}

/**
 * Package information read from package.json
 */
export interface PackageInfo {
  /** Package name */
  name: string;
  /** Package version */
  version: string;
  /** Absolute path to the package directory */
  path: string;
  /** TypeScript entry point (.d.ts file) */
  typesEntryPoint?: string;
}
