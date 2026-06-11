/**
 * Core type definitions for break-check
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
 * Where the AI verdict places a change relative to the rule-based analyzer.
 *
 * `ai-suggested-downgrade` is the lean-mode-only state: the model judged a
 * rule-based breaking change to be non-breaking, but downgrades are not applied
 * by default, so the change is kept breaking and the model's suggestion is
 * recorded for a human to apply via `--ai-apply-downgrades`.
 *
 * `ai-suggested-escalation` is the mirror image for a change the detector
 * deterministically downgraded as a repaired reference (`repairedReference`):
 * the model judged it breaking, but the deterministic verdict wins, so the
 * change stays non-breaking and the model's opinion is recorded.
 */
export type AiAnalysisSource =
  | "rule-confirmed"
  | "rule-overridden"
  | "ai-discovered"
  | "ai-suggested-downgrade"
  | "ai-suggested-escalation";

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
 * Resolvability verdict for one inline `import("...")` specifier a change's
 * signature dropped or introduced. `verdict` comes from resolving the specifier
 * against the dependency's `exports` map; `unknown` covers everything that map
 * could not settle: the dependency is not installed, it has no usable `exports`
 * field (legacy resolution then serves every file, so the subpath may well
 * resolve), or the specifier is not a bare package specifier at all (relative,
 * absolute, or malformed).
 */
export interface ReferenceResolution {
  /** The module specifier, e.g. `@clerk/shared/_chunks/index-DcO1-lAR`. */
  specifier: string;
  /** Whether the specifier was dropped from the before side or introduced on the after side. */
  side: "removed" | "introduced";
  /** Exports-map verdict for the specifier. */
  verdict: "exported" | "blocked" | "unknown";
  /**
   * True when `verdict` was settled by the dependency's actual `exports` map.
   * False for every `unknown`, including a relative/absolute/malformed
   * specifier, where nothing was verified in either direction.
   */
  deterministic: boolean;
  /** Set when `verdict` is `unknown` and the specifier looks like an internal bundler chunk. */
  internalChunk?: boolean;
  /**
   * Set when the specifier's dependency package could not be located on disk.
   * Distinguishes "unlocatable" from "installed but no `exports` map": in the
   * latter case legacy resolution serves every file, so even a chunk-shaped
   * subpath may genuinely resolve for consumers.
   */
  packageNotFound?: boolean;
}

/**
 * Recorded when a breaking modification was deterministically downgraded
 * because its only diff is swapping unresolvable module specifiers for
 * exported ones (see `ApiChange.repairedReference`).
 */
export interface RepairedReference {
  /** Removed specifiers, each export-blocked (or chunk-shaped with the dependency unlocatable). */
  from: string[];
  /** Introduced specifiers, each deterministically exported. */
  to: string[];
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
  /** Subpath export this change belongs to (`.`, `./react`, ...). Set by the orchestrator. */
  subpath?: string;
  /** Source location of the change */
  location?: {
    file: string;
    line?: number;
  };
  /** Original classification from the rule-based analyzer, set only if AI changed `type` */
  ruleBasedType?: ChangeType;
  /**
   * Set when a `acknowledgedChanges` config entry greened this change: the
   * maintainer asserts it is safe, so a `breaking` classification is flipped to
   * `non-breaking` (with `ruleBasedType` recording the original). Unlike an AI
   * downgrade this is unconditional and not gated behind `--ai-apply-downgrades`.
   */
  acknowledged?: boolean;
  /**
   * Set when the change's new signature references a module specifier that
   * consumers cannot resolve (a dependency subpath blocked or absent in that
   * dependency's `exports`, e.g. an internal `/_chunks/` bundler path). Such a
   * change is breaking regardless of structural shape, because the type degrades
   * to `any` (skipLibCheck) or fails to compile (TS2307) downstream. This is a
   * deterministic guard the AI cannot override: the AI may not downgrade a
   * change carrying this flag, even under `--ai-apply-downgrades`. An explicit
   * `acknowledgedChanges` entry can still clear it.
   */
  unresolvableReference?: boolean;
  /** The offending module specifier when `unresolvableReference` is set. */
  unresolvableSpecifier?: string;
  /**
   * Set when the change was deterministically downgraded to non-breaking
   * because its only diff is a reference repair: every specifier the signature
   * dropped was unconsumable (export-blocked in the dependency's `exports`, or
   * an internal-chunk-shaped path with the dependency unlocatable), every
   * specifier it introduced resolves to a public export, and the signatures are
   * otherwise identical once the swapped `import("...").Name` units are masked.
   * The before state errored (TS2307) or degraded to `any` downstream, so the
   * swap strictly improves resolvability (issue #98, the inverse of
   * `unresolvableReference`). The AI may not escalate a change carrying this
   * field; `ruleBasedType` records the original verdict.
   */
  repairedReference?: RepairedReference;
  /**
   * Exports-map verdicts for the inline import specifiers this change dropped
   * or introduced. Attached whenever the specifier sets differ between the
   * before and after snippets, so the AI reviewer (and JSON consumers) get
   * deterministic resolvability facts instead of guessing from path shapes.
   */
  referenceResolutions?: ReferenceResolution[];
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
  /** Model identifier when AI review ran for this package; absent otherwise. */
  aiReviewedBy?: string;
}

/**
 * A subpath break-check tried to snapshot but couldn't, typically because API
 * Extractor threw on an ambient-global augmentation or a `.d.ts` outside
 * `dist/`. These are surfaced as warnings rather than fatal errors so a
 * single broken entry doesn't tank the whole run; users can add the
 * subpath to `ignoreSubpaths` once they've seen the warning.
 */
export interface SkippedEntry {
  /** Package name as declared in package.json. */
  packageName: string;
  /** Subpath that failed (`.`, `./cypress`, `./env`, ...). */
  subpath: string;
  /** Underlying error message from the extractor. */
  reason: string;
}

/**
 * A (package, subpath) whose AI review did not complete: the call failed, timed
 * out, or returned an unusable payload even after the analyzer's split-and-retry.
 * The affected changes keep their rule-based (pessimistic) classification, so
 * they may be over-reported as breaking. Surfaced in the report so a maintainer
 * knows coverage was partial rather than silently trusting an incomplete review.
 */
export interface AiReviewFailure {
  /** Package + subpath label, e.g. `@clerk/shared (./types)`. */
  packageName: string;
  /** Underlying reason the call could not be completed. */
  reason: string;
  /** Number of changes left with only their rule-based verdict. */
  unreviewed: number;
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
  /** Subpaths break-check could not snapshot on either side of the diff. */
  skippedEntries?: SkippedEntry[];
  /** (package, subpath) reviews the AI analyzer could not complete; their
   * changes carry only rule-based verdicts. Absent when AI is off or all
   * reviews succeeded. */
  incompleteReviews?: AiReviewFailure[];
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
 * A single resolved entry point for a package: one subpath in the exports map
 * with its corresponding `.d.ts` file.
 */
export interface PackageEntry {
  /** Subpath as written in the exports map (`.`, `./react`, `./internal/foo`). */
  subpath: string;
  /** Absolute path to the resolved `.d.ts` file for this subpath. */
  typesEntry: string;
}

/**
 * API snapshot metadata. One ApiSnapshot per (package, subpath) tuple.
 */
export interface ApiSnapshot {
  /** Package name from package.json */
  packageName: string;
  /** Subpath this snapshot was generated for (`.`, `./react`, ...) */
  subpath: string;
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
  /** Path to break-check metadata for this snapshot's package directory */
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
  /** All resolved entry points (root + subpaths). Empty if the package has no exports map and no detectable root types. */
  entries: PackageEntry[];
  /**
   * Subpaths whose `exports` entry declares a type surface break-check could
   * not turn into an entry point: the declared `.d.ts` file is missing, the
   * target escapes the package directory, or a wildcard types pattern matched
   * nothing. Subpaths with no declared types at all (JS-only or asset exports)
   * are not listed; they are not a coverage hole. The detector surfaces these
   * as skipped entries so `--fail-on-skipped` and the report see them.
   */
  unresolvedSubpaths?: Array<{ subpath: string; reason: string }>;
}
