import assert from "node:assert/strict";
import { test } from "node:test";

import { MarkdownReporter } from "../dist/reporters/markdown.js";
import { ChangeSeverity, ChangeType } from "../dist/types.js";

function makeResult(change) {
  return {
    timestamp: "2026-05-27T00:00:00.000Z",
    summary: {
      totalPackages: 1,
      packagesWithChanges: 1,
      breakingChanges: change.type === ChangeType.BREAKING ? 1 : 0,
      nonBreakingChanges: change.type === ChangeType.NON_BREAKING ? 1 : 0,
      additions: change.type === ChangeType.ADDITION ? 1 : 0,
    },
    hasBreakingChanges: change.type === ChangeType.BREAKING,
    packages: [
      {
        packageName: "@demo/pkg",
        version: { previous: "1.0.0", current: "1.0.1" },
        recommendedVersionBump: "minor",
        changes: [change],
      },
    ],
  };
}

test("markdown reporter: short snippets are rendered inline without <details>", () => {
  const change = {
    id: "x",
    type: ChangeType.NON_BREAKING,
    severity: ChangeSeverity.MINOR,
    category: "type",
    name: "Foo",
    description: "Type changed",
    beforeSnippet: "type Foo = { a: string };",
    afterSnippet: "type Foo = { a: string; b: string };",
  };
  const out = new MarkdownReporter({ includeFooter: false }).generate(
    makeResult(change),
  );
  assert.ok(out.includes("```diff"), "expected a diff fence");
  assert.ok(
    !out.includes("Diff truncated"),
    "short snippets should not be truncated",
  );
  assert.ok(
    !out.includes("more lines elided"),
    "no elision marker for short snippets",
  );
});

test("markdown reporter: tiny edit in huge snippet renders as a focused diff", () => {
  const bigLines = Array.from({ length: 500 }, (_, i) => `key${i}: string;`);
  const beforeSnippet = `type Foo = {\n${bigLines.join("\n")}\n};`;
  const afterSnippet = `type Foo = {\n${bigLines.join("\n")}\nadded: string;\n};`;

  const change = {
    id: "x",
    type: ChangeType.NON_BREAKING,
    severity: ChangeSeverity.MINOR,
    category: "type",
    name: "Foo",
    description: "Type changed",
    beforeSnippet,
    afterSnippet,
  };
  const out = new MarkdownReporter({
    includeFooter: false,
    snippetMaxLines: 60,
  }).generate(makeResult(change));

  // The actual diff is one new line; surrounding identical content should be
  // collapsed into elision markers, not rendered head+tail of each side.
  assert.match(out, /unchanged lines? elided/);
  assert.ok(
    out.includes("+ added: string;"),
    "expected the added line to be visible",
  );
  // Mostly-identical snippets should not produce a wall of `-` lines.
  const removedLines = out.split("\n").filter((line) => line.startsWith("- "));
  assert.ok(
    removedLines.length <= 1,
    `expected at most 1 removed line, got ${removedLines.length}`,
  );
  // Short enough to render inline.
  assert.ok(!out.includes("<details>"), "small diffs render inline");
  // Sanity: the rendered report should be far smaller than the raw snippet.
  assert.ok(
    out.length < 10_000,
    `expected report under 10KB, got ${out.length} bytes`,
  );
});

test("markdown reporter: large unrelated snippets fall back to head+tail with <details>", () => {
  const before = Array.from({ length: 300 }, (_, i) => `oldKey${i}: string;`);
  const after = Array.from({ length: 300 }, (_, i) => `newKey${i}: number;`);
  const beforeSnippet = `type Foo = {\n${before.join("\n")}\n};`;
  const afterSnippet = `type Foo = {\n${after.join("\n")}\n};`;

  const change = {
    id: "x",
    type: ChangeType.BREAKING,
    severity: ChangeSeverity.MAJOR,
    category: "type",
    name: "Foo",
    description: "Type changed",
    beforeSnippet,
    afterSnippet,
  };
  const out = new MarkdownReporter({
    includeFooter: false,
    snippetMaxLines: 60,
  }).generate(makeResult(change));

  assert.ok(out.includes("<details>"), "expected <details> wrapper");
  assert.ok(out.includes("Diff (before:"), "expected diff summary line");
  assert.match(out, /more lines? elided/);
});

function makeMultiPackageResult(packageCount, changesPerPackage) {
  const packages = [];
  for (let p = 0; p < packageCount; p++) {
    const changes = [];
    for (let c = 0; c < changesPerPackage; c++) {
      changes.push({
        id: `p${p}c${c}`,
        type: ChangeType.ADDITION,
        severity: ChangeSeverity.MINOR,
        category: "function",
        name: `fn_${p}_${c}`,
        description:
          `Added function fn_${p}_${c} with a reasonably long description so the section takes up space. `.repeat(
            3,
          ),
      });
    }
    packages.push({
      packageName: `@demo/pkg-${p}`,
      version: { previous: "1.0.0", current: "1.1.0" },
      recommendedVersionBump: "minor",
      changes,
    });
  }
  return {
    timestamp: "2026-05-29T00:00:00.000Z",
    summary: {
      totalPackages: packageCount,
      packagesWithChanges: packageCount,
      breakingChanges: 0,
      nonBreakingChanges: 0,
      additions: packageCount * changesPerPackage,
    },
    hasBreakingChanges: false,
    packages,
  };
}

test("markdown reporter: caps total report size and notes the overflow", () => {
  const result = makeMultiPackageResult(40, 5);
  const budget = 8000;

  // Without a budget the report is well over the limit.
  const full = new MarkdownReporter().generate(result);
  assert.ok(
    full.length > budget,
    `precondition: unbudgeted report should exceed ${budget}, got ${full.length}`,
  );

  const out = new MarkdownReporter({ maxReportChars: budget }).generate(result);
  assert.ok(
    out.length <= budget,
    `expected report within ${budget} chars, got ${out.length}`,
  );
  assert.match(out, /Report truncated to fit GitHub's comment size limit/);
  assert.match(out, /omitted from this comment/);
  // The summary table is part of the always-included head.
  assert.ok(out.includes("## Summary"), "summary must always be present");
  // At least the first package section should make it in.
  assert.ok(out.includes("@demo/pkg-0"), "first package should be included");
});

test("markdown reporter: acknowledged change shows the tag and note, no breaking warning", () => {
  const change = {
    id: "x",
    // A config acknowledgement flips a rule-based breaking change to
    // non-breaking, recording the original in ruleBasedType.
    type: ChangeType.NON_BREAKING,
    severity: ChangeSeverity.MINOR,
    category: "type",
    name: "OAuthConsentInfo",
    description: "Breaking change in type `OAuthConsentInfo`: Type changed",
    beforeSnippet: "type OAuthConsentInfo = { a: string };",
    afterSnippet: "type OAuthConsentInfo = { a: string; b: string };",
    ruleBasedType: ChangeType.BREAKING,
    acknowledged: true,
  };
  const out = new MarkdownReporter({ includeFooter: false }).generate(
    makeResult(change),
  );
  assert.ok(
    out.includes("_(acknowledged)_"),
    "expected acknowledged heading tag",
  );
  assert.ok(out.includes("Acknowledged"), "expected the acknowledged note");
  assert.ok(
    out.includes("break-check.config.json"),
    "note should point at the config file",
  );
  // It renders as a non-breaking change, so the breaking-changes section and
  // major-bump warning must not appear.
  assert.ok(
    !out.includes("Breaking Changes"),
    "acknowledged change must not appear under a Breaking Changes section",
  );
  assert.ok(
    !out.includes("Major version bump required"),
    "an acknowledged-only diff must not warn about a major bump",
  );
});

test("markdown reporter: no truncation notice when the report fits", () => {
  const result = makeMultiPackageResult(2, 1);
  const out = new MarkdownReporter().generate(result);
  assert.ok(
    !out.includes("Report truncated"),
    "a small report should not be truncated",
  );
  assert.ok(out.includes("@demo/pkg-0") && out.includes("@demo/pkg-1"));
});

/* ---------------------------------------- breaking-first layout helpers -- */

function changeOf(type, name, subpath) {
  return {
    id: name,
    type,
    severity:
      type === ChangeType.BREAKING
        ? ChangeSeverity.MAJOR
        : ChangeSeverity.MINOR,
    category: "type",
    name,
    description: `change ${name}`,
    beforeSnippet: `type ${name} = { a: string };`,
    afterSnippet: `type ${name} = { a: number };`,
    ...(subpath ? { subpath } : {}),
  };
}

function pkgOf(name, changes, extra = {}) {
  return {
    packageName: name,
    version: { previous: "1.0.0", current: "1.0.1" },
    recommendedVersionBump: changes.some((c) => c.type === ChangeType.BREAKING)
      ? "major"
      : "minor",
    changes,
    ...extra,
  };
}

function resultOf(packages, extra = {}) {
  const all = packages.flatMap((p) => p.changes);
  return {
    timestamp: "2026-06-03T00:00:00.000Z",
    summary: {
      totalPackages: packages.length,
      packagesWithChanges: packages.length,
      breakingChanges: all.filter((c) => c.type === ChangeType.BREAKING).length,
      nonBreakingChanges: all.filter((c) => c.type === ChangeType.NON_BREAKING)
        .length,
      additions: all.filter((c) => c.type === ChangeType.ADDITION).length,
    },
    hasBreakingChanges: all.some((c) => c.type === ChangeType.BREAKING),
    packages,
    ...extra,
  };
}

test("markdown reporter: packages with breaking changes are ordered first", () => {
  const safe = pkgOf("@demo/safe", [changeOf(ChangeType.NON_BREAKING, "Safe")]);
  const risky = pkgOf("@demo/risky", [changeOf(ChangeType.BREAKING, "Risky")]);
  // Array order puts the safe package first; the reporter must reorder.
  const out = new MarkdownReporter({ includeFooter: false }).generate(
    resultOf([safe, risky]),
  );
  const riskyIdx = out.indexOf("## @demo/risky");
  const safeIdx = out.indexOf("## @demo/safe");
  assert.ok(riskyIdx > -1 && safeIdx > -1);
  assert.ok(
    riskyIdx < safeIdx,
    "breaking package should render before the non-breaking one",
  );
});

test("markdown reporter: subpaths with breaking changes are ordered first", () => {
  const p = pkgOf("@demo/pkg", [
    changeOf(ChangeType.NON_BREAKING, "ClientThing", "./client"),
    changeOf(ChangeType.BREAKING, "TypeThing", "./types"),
  ]);
  const out = new MarkdownReporter({ includeFooter: false }).generate(
    resultOf([p]),
  );
  const typesIdx = out.indexOf("### Subpath `./types`");
  const clientIdx = out.indexOf("### Subpath `./client`");
  assert.ok(typesIdx > -1 && clientIdx > -1);
  assert.ok(
    typesIdx < clientIdx,
    "breaking subpath should render before the alphabetically-earlier non-breaking one",
  );
});

test("markdown reporter: breaking changes are never collapsed; large non-breaking collapse", () => {
  const breaking = Array.from({ length: 12 }, (_, i) =>
    changeOf(ChangeType.BREAKING, `B${i}`, "./types"),
  );
  const nonBreaking = Array.from({ length: 12 }, (_, i) =>
    changeOf(ChangeType.NON_BREAKING, `N${i}`, "./types"),
  );
  const out = new MarkdownReporter({ includeFooter: false }).generate(
    resultOf([pkgOf("@demo/pkg", [...breaking, ...nonBreaking])]),
  );

  const brkHeader = out.indexOf("Breaking Changes (12)");
  const nbHeader = out.indexOf("Non-breaking Changes (12)");
  assert.ok(brkHeader > -1 && nbHeader > -1);
  // The breaking section (up to the non-breaking header) is fully expanded.
  const breakingBlock = out.slice(brkHeader, nbHeader);
  assert.ok(
    !breakingBlock.includes("<details>"),
    "breaking changes must never be collapsed",
  );
  // The large non-breaking section collapses behind <details>.
  assert.ok(
    out.slice(nbHeader).includes("Click to expand 12 changes"),
    "a large non-breaking section should collapse",
  );
});

test("markdown reporter: a breaking-changes index lists every break up front", () => {
  const p = pkgOf("@demo/pkg", [
    changeOf(ChangeType.BREAKING, "Risky", "./types"),
  ]);
  const out = new MarkdownReporter({ includeFooter: false }).generate(
    resultOf([p]),
  );
  assert.ok(
    out.includes("Breaking changes index (1)"),
    "expected the breaking index heading",
  );
  const idxPos = out.indexOf("Breaking changes index");
  const pkgPos = out.indexOf("## @demo/pkg");
  assert.ok(
    idxPos > -1 && idxPos < pkgPos,
    "index should appear before package sections",
  );
  assert.match(out, /\| @demo\/pkg \| `\.\/types` \| `Risky` \|/);
});

test("markdown reporter: incomplete AI reviews are surfaced and the stamp is partial", () => {
  const p = pkgOf(
    "@demo/pkg",
    [changeOf(ChangeType.BREAKING, "Risky", "./types")],
    {
      aiReviewedBy: "claude-test",
    },
  );
  const out = new MarkdownReporter({ includeFooter: false }).generate(
    resultOf([p], {
      incompleteReviews: [
        {
          packageName: "@demo/pkg (./types)",
          reason: "request too large",
          unreviewed: 3,
        },
      ],
    }),
  );
  assert.match(out, /reviewed by `claude-test` \(partial\)/);
  assert.match(out, /AI review did not complete for 1 subpath/);
  assert.match(out, /3 changes unreviewed/);
  assert.ok(
    out.includes("@demo/pkg (./types)"),
    "should name the failed subpath",
  );
});
