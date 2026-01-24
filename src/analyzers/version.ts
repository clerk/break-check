/**
 * Version Analyzer - Validates semver compliance for API changes
 */

import { ChangeSeverity, ApiChange, ChangeType } from "../types.js";

/**
 * Parsed semver components
 */
interface SemverComponents {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
}

/**
 * Analyzer for version bump validation
 */
export class VersionAnalyzer {
  /**
   * Determine the recommended version bump based on detected changes
   * @param changes - List of detected API changes
   * @returns Recommended semver bump level
   */
  getRecommendedBump(changes: ApiChange[]): ChangeSeverity {
    if (changes.length === 0) {
      return ChangeSeverity.PATCH;
    }

    // Any breaking change requires a major bump
    if (changes.some((c) => c.type === ChangeType.BREAKING)) {
      return ChangeSeverity.MAJOR;
    }

    // Any addition or non-breaking change requires at least minor
    if (
      changes.some(
        (c) =>
          c.type === ChangeType.ADDITION || c.type === ChangeType.NON_BREAKING,
      )
    ) {
      return ChangeSeverity.MINOR;
    }

    // Default to patch for any other changes
    return ChangeSeverity.PATCH;
  }

  /**
   * Determine the actual version bump between two versions
   * @param previousVersion - Previous version string (e.g., "1.2.3")
   * @param currentVersion - Current version string (e.g., "1.3.0")
   * @returns The bump level, or null if versions are invalid or not bumped
   */
  getActualBump(
    previousVersion: string,
    currentVersion: string,
  ): ChangeSeverity | null {
    const prev = this.parseSemver(previousVersion);
    const curr = this.parseSemver(currentVersion);

    if (!prev || !curr) {
      return null;
    }

    // Major bump
    if (curr.major > prev.major) {
      return ChangeSeverity.MAJOR;
    }

    // Version decreased in major - invalid
    if (curr.major < prev.major) {
      return null;
    }

    // Minor bump (same major)
    if (curr.minor > prev.minor) {
      return ChangeSeverity.MINOR;
    }

    // Version decreased in minor - invalid
    if (curr.minor < prev.minor) {
      return null;
    }

    // Patch bump (same major and minor)
    if (curr.patch > prev.patch) {
      return ChangeSeverity.PATCH;
    }

    // No bump or version decreased
    return null;
  }

  /**
   * Validate if the actual version bump is sufficient for the detected changes
   * @param recommended - Recommended bump based on changes
   * @param actual - Actual bump between versions
   * @returns true if the bump is valid (sufficient)
   */
  isValidBump(
    recommended: ChangeSeverity,
    actual: ChangeSeverity | null,
  ): boolean {
    // If no actual bump detected, it's only valid if no changes require a bump
    if (actual === null) {
      return recommended === ChangeSeverity.PATCH;
    }

    const severityRank: Record<ChangeSeverity, number> = {
      [ChangeSeverity.PATCH]: 0,
      [ChangeSeverity.MINOR]: 1,
      [ChangeSeverity.MAJOR]: 2,
    };

    // Actual bump must be >= recommended bump
    // Over-bumping is allowed (e.g., major bump for minor changes)
    return severityRank[actual] >= severityRank[recommended];
  }

  /**
   * Check if a version is a pre-release (0.x.y)
   * Pre-release versions have different semver semantics
   * @param version - Version string
   * @returns true if version is 0.x.y
   */
  isPreRelease(version: string): boolean {
    const parsed = this.parseSemver(version);
    return parsed !== null && parsed.major === 0;
  }

  /**
   * Validate bump for pre-release versions (0.x.y)
   * In pre-release, breaking changes are allowed in minor bumps
   * @param recommended - Recommended bump
   * @param actual - Actual bump
   * @returns true if valid for pre-release semantics
   */
  isValidPreReleaseBump(
    recommended: ChangeSeverity,
    actual: ChangeSeverity | null,
  ): boolean {
    if (actual === null) {
      return recommended === ChangeSeverity.PATCH;
    }

    // For 0.x.y versions, minor bumps can contain breaking changes
    if (recommended === ChangeSeverity.MAJOR) {
      return actual === ChangeSeverity.MAJOR || actual === ChangeSeverity.MINOR;
    }

    return this.isValidBump(recommended, actual);
  }

  /**
   * Get a human-readable validation message
   * @param recommended - Recommended bump
   * @param actual - Actual bump
   * @param isPreRelease - Whether this is a pre-release version
   * @returns Validation message or null if valid
   */
  getValidationMessage(
    recommended: ChangeSeverity,
    actual: ChangeSeverity | null,
    isPreRelease: boolean = false,
  ): string | null {
    const isValid = isPreRelease
      ? this.isValidPreReleaseBump(recommended, actual)
      : this.isValidBump(recommended, actual);

    if (isValid) {
      return null;
    }

    if (actual === null) {
      return `Version was not bumped, but ${recommended} bump is required`;
    }

    return `${actual} bump is insufficient; ${recommended} bump required`;
  }

  /**
   * Parse a semver version string into components
   * @param version - Version string (e.g., "1.2.3", "1.2.3-beta.1")
   * @returns Parsed components or null if invalid
   */
  parseSemver(version: string): SemverComponents | null {
    if (!version || typeof version !== "string") {
      return null;
    }

    // Remove leading 'v' if present
    const normalized = version.startsWith("v") ? version.slice(1) : version;

    // Match semver pattern: major.minor.patch[-prerelease]
    const match = normalized.match(
      /^(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z0-9.-]+))?/,
    );

    if (!match) {
      return null;
    }

    return {
      major: parseInt(match[1], 10),
      minor: parseInt(match[2], 10),
      patch: parseInt(match[3], 10),
      prerelease: match[4],
    };
  }

  /**
   * Compare two versions
   * @param a - First version
   * @param b - Second version
   * @returns -1 if a < b, 0 if a === b, 1 if a > b, null if invalid
   */
  compareVersions(a: string, b: string): number | null {
    const parsedA = this.parseSemver(a);
    const parsedB = this.parseSemver(b);

    if (!parsedA || !parsedB) {
      return null;
    }

    if (parsedA.major !== parsedB.major) {
      return parsedA.major < parsedB.major ? -1 : 1;
    }

    if (parsedA.minor !== parsedB.minor) {
      return parsedA.minor < parsedB.minor ? -1 : 1;
    }

    if (parsedA.patch !== parsedB.patch) {
      return parsedA.patch < parsedB.patch ? -1 : 1;
    }

    return 0;
  }
}
