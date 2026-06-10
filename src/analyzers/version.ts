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
 * Compare two prerelease tags per semver spec item 11: a version without a
 * tag outranks any tagged one; otherwise dot-separated identifiers compare
 * left to right (numerics numerically, numerics below alphanumerics,
 * alphanumerics lexically), and when one tag is a prefix of the other the
 * longer one ranks higher. Returns -1 / 0 / 1.
 */
function comparePrereleaseTags(
  a: string | undefined,
  b: string | undefined,
): number {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  const as = a.split(".");
  const bs = b.split(".");
  const len = Math.min(as.length, bs.length);
  for (let i = 0; i < len; i++) {
    const x = as[i];
    const y = bs[i];
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      const dx = Number(x);
      const dy = Number(y);
      if (dx !== dy) return dx < dy ? -1 : 1;
    } else if (xNumeric !== yNumeric) {
      return xNumeric ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  if (as.length !== bs.length) return as.length < bs.length ? -1 : 1;
  return 0;
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
   * Check if a version is in initial development (major version zero, 0.x.y).
   * Such versions follow the 0.x convention: `^0.2.3` ranges stop at the next
   * minor, so the minor position is the breaking boundary. Not to be confused
   * with a semver prerelease TAG (`1.0.0-beta.1`); see `isPrereleaseAdvance`.
   * @param version - Version string
   * @returns true if version is 0.x.y
   */
  isZeroMajor(version: string): boolean {
    const parsed = this.parseSemver(version);
    return parsed !== null && parsed.major === 0;
  }

  /**
   * Whether `currentVersion` is a forward move within `previousVersion`'s
   * prerelease train: the numeric triple is unchanged and the prerelease tag
   * advanced (`1.0.0-beta.1` -> `1.0.0-beta.2`) or was dropped to finalize
   * the release (`1.0.0-beta.1` -> `1.0.0`). Such a move is never an
   * insufficient bump, whatever the changes: shipping breaking changes
   * between prereleases of the same version is the point of a prerelease.
   * The reverse direction (re-tagging a final version, or beta.2 -> beta.1)
   * is not an advance.
   */
  isPrereleaseAdvance(
    previousVersion: string,
    currentVersion: string,
  ): boolean {
    const prev = this.parseSemver(previousVersion);
    const curr = this.parseSemver(currentVersion);
    if (!prev || !curr || prev.prerelease === undefined) {
      return false;
    }
    if (
      prev.major !== curr.major ||
      prev.minor !== curr.minor ||
      prev.patch !== curr.patch
    ) {
      return false;
    }
    return comparePrereleaseTags(prev.prerelease, curr.prerelease) < 0;
  }

  /**
   * Validate bump for initial-development versions (0.x.y)
   * In 0.x, breaking changes are allowed in minor bumps
   * @param recommended - Recommended bump
   * @param actual - Actual bump
   * @returns true if valid for 0.x semantics
   */
  isValidZeroMajorBump(
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
   * @param zeroMajor - Whether the package is on a 0.x version
   * @returns Validation message or null if valid
   */
  getValidationMessage(
    recommended: ChangeSeverity,
    actual: ChangeSeverity | null,
    zeroMajor: boolean = false,
  ): string | null {
    const isValid = zeroMajor
      ? this.isValidZeroMajorBump(recommended, actual)
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
   * The next version within `version`'s prerelease train: the trailing
   * numeric identifier incremented (`1.0.0-beta.1` -> `1.0.0-beta.2`), or a
   * `.0` appended when the tag has no numeric tail (`1.0.0-beta` ->
   * `1.0.0-beta.0`, mirroring node-semver's `inc(..., "prerelease")`). Both
   * results satisfy `isPrereleaseAdvance`. Returns null when the version has
   * no prerelease tag (or doesn't parse), so callers can fall back to a
   * normal bump projection.
   */
  nextPrereleaseVersion(version: string): string | null {
    const parsed = this.parseSemver(version);
    if (!parsed || parsed.prerelease === undefined) return null;
    const ids = parsed.prerelease.split(".");
    const last = ids[ids.length - 1];
    if (/^\d+$/.test(last)) {
      ids[ids.length - 1] = String(Number(last) + 1);
    } else {
      ids.push("0");
    }
    return `${parsed.major}.${parsed.minor}.${parsed.patch}-${ids.join(".")}`;
  }

  /**
   * Apply a bump level to a version string and return the resulting version.
   * Strips any pre-release suffix. Returns null if the input doesn't parse.
   */
  applyBump(version: string, bump: ChangeSeverity): string | null {
    const parsed = this.parseSemver(version);
    if (!parsed) return null;
    switch (bump) {
      case ChangeSeverity.MAJOR:
        return `${parsed.major + 1}.0.0`;
      case ChangeSeverity.MINOR:
        return `${parsed.major}.${parsed.minor + 1}.0`;
      case ChangeSeverity.PATCH:
        return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
    }
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
   * Compare two versions, including prerelease precedence per the semver
   * spec: when the numeric triples are equal, a tagged version ranks below
   * the untagged one (`1.0.0-beta.1` < `1.0.0`) and tags compare identifier
   * by identifier (`beta.2` < `beta.11`, `alpha` < `beta`).
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

    return comparePrereleaseTags(parsedA.prerelease, parsedB.prerelease);
  }
}
