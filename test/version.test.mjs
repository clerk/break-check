import assert from "node:assert/strict";
import { test } from "node:test";

import { VersionAnalyzer, ChangeSeverity, ChangeType } from "../dist/index.js";

const analyzer = new VersionAnalyzer();

function change(type) {
  return {
    id: "x",
    type,
    severity:
      type === ChangeType.BREAKING
        ? ChangeSeverity.MAJOR
        : ChangeSeverity.MINOR,
    category: "function",
    name: "fn",
    description: "",
  };
}

// ---------- getRecommendedBump ----------

test("getRecommendedBump: no changes → patch", () => {
  assert.equal(analyzer.getRecommendedBump([]), ChangeSeverity.PATCH);
});

test("getRecommendedBump: any breaking change → major", () => {
  assert.equal(
    analyzer.getRecommendedBump([
      change(ChangeType.ADDITION),
      change(ChangeType.BREAKING),
      change(ChangeType.NON_BREAKING),
    ]),
    ChangeSeverity.MAJOR,
  );
});

test("getRecommendedBump: addition only → minor", () => {
  assert.equal(
    analyzer.getRecommendedBump([change(ChangeType.ADDITION)]),
    ChangeSeverity.MINOR,
  );
});

test("getRecommendedBump: non-breaking only → minor", () => {
  assert.equal(
    analyzer.getRecommendedBump([change(ChangeType.NON_BREAKING)]),
    ChangeSeverity.MINOR,
  );
});

// ---------- getActualBump ----------

test("getActualBump: major bump", () => {
  assert.equal(analyzer.getActualBump("1.2.3", "2.0.0"), ChangeSeverity.MAJOR);
});

test("getActualBump: minor bump", () => {
  assert.equal(analyzer.getActualBump("1.2.3", "1.3.0"), ChangeSeverity.MINOR);
});

test("getActualBump: patch bump", () => {
  assert.equal(analyzer.getActualBump("1.2.3", "1.2.4"), ChangeSeverity.PATCH);
});

test("getActualBump: same version → null", () => {
  assert.equal(analyzer.getActualBump("1.2.3", "1.2.3"), null);
});

test("getActualBump: version went backwards → null", () => {
  assert.equal(analyzer.getActualBump("2.0.0", "1.9.9"), null);
  assert.equal(analyzer.getActualBump("1.2.0", "1.1.9"), null);
  assert.equal(analyzer.getActualBump("1.2.3", "1.2.2"), null);
});

test("getActualBump: unparseable input → null", () => {
  assert.equal(analyzer.getActualBump("not-a-version", "1.0.0"), null);
  assert.equal(analyzer.getActualBump("1.0.0", "also-not"), null);
});

test("getActualBump: tolerates leading v prefix", () => {
  assert.equal(
    analyzer.getActualBump("v1.2.3", "v1.3.0"),
    ChangeSeverity.MINOR,
  );
});

// ---------- isValidBump ----------

test("isValidBump: equal severity is valid", () => {
  assert.equal(
    analyzer.isValidBump(ChangeSeverity.MINOR, ChangeSeverity.MINOR),
    true,
  );
});

test("isValidBump: over-bumping is allowed", () => {
  assert.equal(
    analyzer.isValidBump(ChangeSeverity.PATCH, ChangeSeverity.MAJOR),
    true,
  );
  assert.equal(
    analyzer.isValidBump(ChangeSeverity.MINOR, ChangeSeverity.MAJOR),
    true,
  );
});

test("isValidBump: under-bumping is invalid", () => {
  assert.equal(
    analyzer.isValidBump(ChangeSeverity.MAJOR, ChangeSeverity.MINOR),
    false,
  );
  assert.equal(
    analyzer.isValidBump(ChangeSeverity.MINOR, ChangeSeverity.PATCH),
    false,
  );
});

test("isValidBump: null actual only valid when nothing was required", () => {
  assert.equal(analyzer.isValidBump(ChangeSeverity.PATCH, null), true);
  assert.equal(analyzer.isValidBump(ChangeSeverity.MINOR, null), false);
  assert.equal(analyzer.isValidBump(ChangeSeverity.MAJOR, null), false);
});

// ---------- isZeroMajor ----------

test("isZeroMajor: 0.x.y is initial development", () => {
  assert.equal(analyzer.isZeroMajor("0.0.1"), true);
  assert.equal(analyzer.isZeroMajor("0.5.0"), true);
});

test("isZeroMajor: 1.x.y and above are not", () => {
  assert.equal(analyzer.isZeroMajor("1.0.0"), false);
  assert.equal(analyzer.isZeroMajor("10.4.2"), false);
});

test("isZeroMajor: unparseable input → false", () => {
  assert.equal(analyzer.isZeroMajor("nope"), false);
});

// ---------- isValidZeroMajorBump ----------

test("isValidZeroMajorBump: breaking change accepts a minor bump", () => {
  // 0.x.y semver allows breaking changes inside minor bumps
  assert.equal(
    analyzer.isValidZeroMajorBump(ChangeSeverity.MAJOR, ChangeSeverity.MINOR),
    true,
  );
});

test("isValidZeroMajorBump: breaking change still rejects a patch bump", () => {
  assert.equal(
    analyzer.isValidZeroMajorBump(ChangeSeverity.MAJOR, ChangeSeverity.PATCH),
    false,
  );
});

test("isValidZeroMajorBump: non-breaking changes follow normal rules", () => {
  assert.equal(
    analyzer.isValidZeroMajorBump(ChangeSeverity.MINOR, ChangeSeverity.PATCH),
    false,
  );
  assert.equal(
    analyzer.isValidZeroMajorBump(ChangeSeverity.MINOR, ChangeSeverity.MINOR),
    true,
  );
});

test("isValidZeroMajorBump: null actual only valid when nothing was required", () => {
  assert.equal(analyzer.isValidZeroMajorBump(ChangeSeverity.PATCH, null), true);
  assert.equal(
    analyzer.isValidZeroMajorBump(ChangeSeverity.MAJOR, null),
    false,
  );
});

// ---------- getValidationMessage ----------

test("getValidationMessage: valid bump → null", () => {
  assert.equal(
    analyzer.getValidationMessage(ChangeSeverity.MINOR, ChangeSeverity.MINOR),
    null,
  );
});

test("getValidationMessage: missing bump", () => {
  assert.match(
    analyzer.getValidationMessage(ChangeSeverity.MAJOR, null) ?? "",
    /not bumped/,
  );
});

test("getValidationMessage: insufficient bump mentions both severities", () => {
  const msg = analyzer.getValidationMessage(
    ChangeSeverity.MAJOR,
    ChangeSeverity.MINOR,
  );
  assert.match(msg ?? "", /minor/);
  assert.match(msg ?? "", /major/);
});

test("getValidationMessage: zero-major flag relaxes the rule", () => {
  assert.equal(
    analyzer.getValidationMessage(
      ChangeSeverity.MAJOR,
      ChangeSeverity.MINOR,
      true,
    ),
    null,
  );
});

// ---------- parseSemver ----------

test("parseSemver: basic versions", () => {
  assert.deepEqual(analyzer.parseSemver("1.2.3"), {
    major: 1,
    minor: 2,
    patch: 3,
    prerelease: undefined,
  });
});

test("parseSemver: strips leading v", () => {
  assert.deepEqual(analyzer.parseSemver("v1.2.3"), {
    major: 1,
    minor: 2,
    patch: 3,
    prerelease: undefined,
  });
});

test("parseSemver: captures prerelease tag", () => {
  assert.deepEqual(analyzer.parseSemver("1.2.3-beta.1"), {
    major: 1,
    minor: 2,
    patch: 3,
    prerelease: "beta.1",
  });
});

test("parseSemver: rejects garbage", () => {
  assert.equal(analyzer.parseSemver(""), null);
  assert.equal(analyzer.parseSemver("nope"), null);
  assert.equal(analyzer.parseSemver("1.2"), null);
});

// ---------- compareVersions ----------

test("compareVersions: equal", () => {
  assert.equal(analyzer.compareVersions("1.2.3", "1.2.3"), 0);
});

test("compareVersions: less than", () => {
  assert.equal(analyzer.compareVersions("1.2.3", "1.2.4"), -1);
  assert.equal(analyzer.compareVersions("1.2.3", "1.3.0"), -1);
  assert.equal(analyzer.compareVersions("1.2.3", "2.0.0"), -1);
});

test("compareVersions: greater than", () => {
  assert.equal(analyzer.compareVersions("2.0.0", "1.9.9"), 1);
});

test("compareVersions: unparseable input → null", () => {
  assert.equal(analyzer.compareVersions("nope", "1.0.0"), null);
});

// ---------- isPrereleaseAdvance ----------

test("isPrereleaseAdvance: numeric tag increment within one train", () => {
  assert.equal(
    analyzer.isPrereleaseAdvance("1.0.0-beta.1", "1.0.0-beta.2"),
    true,
  );
});

test("isPrereleaseAdvance: numeric identifiers compare numerically, not lexically", () => {
  assert.equal(
    analyzer.isPrereleaseAdvance("1.0.0-beta.2", "1.0.0-beta.11"),
    true,
  );
  assert.equal(
    analyzer.isPrereleaseAdvance("1.0.0-beta.11", "1.0.0-beta.2"),
    false,
  );
});

test("isPrereleaseAdvance: alpha to beta advances", () => {
  assert.equal(
    analyzer.isPrereleaseAdvance("2.0.0-alpha.3", "2.0.0-beta.1"),
    true,
  );
});

test("isPrereleaseAdvance: finalizing the release advances", () => {
  assert.equal(analyzer.isPrereleaseAdvance("1.0.0-rc.1", "1.0.0"), true);
});

test("isPrereleaseAdvance: re-tagging a final version is not an advance", () => {
  assert.equal(analyzer.isPrereleaseAdvance("1.0.0", "1.0.0-beta.1"), false);
});

test("isPrereleaseAdvance: tag moving backwards is not an advance", () => {
  assert.equal(
    analyzer.isPrereleaseAdvance("1.0.0-beta.2", "1.0.0-beta.1"),
    false,
  );
});

test("isPrereleaseAdvance: a different triple is not a prerelease advance", () => {
  assert.equal(
    analyzer.isPrereleaseAdvance("1.0.0-beta.1", "1.0.1-beta.2"),
    false,
  );
  assert.equal(analyzer.isPrereleaseAdvance("1.0.0-beta.1", "1.1.0"), false);
});

test("isPrereleaseAdvance: longer tag outranks its prefix", () => {
  assert.equal(
    analyzer.isPrereleaseAdvance("1.0.0-beta", "1.0.0-beta.1"),
    true,
  );
});

test("isPrereleaseAdvance: unparseable input → false", () => {
  assert.equal(analyzer.isPrereleaseAdvance("nope", "1.0.0"), false);
  assert.equal(analyzer.isPrereleaseAdvance("1.0.0-beta.1", "nope"), false);
});

// ---------- compareVersions: prerelease precedence ----------

test("compareVersions: prerelease ranks below the final release", () => {
  assert.equal(analyzer.compareVersions("1.0.0-beta.1", "1.0.0"), -1);
  assert.equal(analyzer.compareVersions("1.0.0", "1.0.0-beta.1"), 1);
});

test("compareVersions: prerelease tags compare per spec", () => {
  assert.equal(analyzer.compareVersions("1.0.0-beta.2", "1.0.0-beta.11"), -1);
  assert.equal(analyzer.compareVersions("1.0.0-alpha", "1.0.0-beta"), -1);
  assert.equal(analyzer.compareVersions("1.0.0-beta.1", "1.0.0-beta.1"), 0);
});

// ---------- nextPrereleaseVersion ----------

test("nextPrereleaseVersion: increments a numeric tail", () => {
  assert.equal(analyzer.nextPrereleaseVersion("1.0.0-beta.1"), "1.0.0-beta.2");
  assert.equal(analyzer.nextPrereleaseVersion("2.1.0-rc.9"), "2.1.0-rc.10");
});

test("nextPrereleaseVersion: appends .0 to a bare tag", () => {
  assert.equal(analyzer.nextPrereleaseVersion("1.0.0-beta"), "1.0.0-beta.0");
});

test("nextPrereleaseVersion: result is a prerelease advance", () => {
  for (const v of ["1.0.0-beta.1", "1.0.0-beta", "0.3.0-alpha.2.x"]) {
    const next = analyzer.nextPrereleaseVersion(v);
    assert.ok(next, `expected a next version for ${v}`);
    assert.equal(
      analyzer.isPrereleaseAdvance(v, next),
      true,
      `${v} -> ${next} should be an advance`,
    );
  }
});

test("nextPrereleaseVersion: null for untagged or unparseable versions", () => {
  assert.equal(analyzer.nextPrereleaseVersion("1.0.0"), null);
  assert.equal(analyzer.nextPrereleaseVersion("nope"), null);
});
