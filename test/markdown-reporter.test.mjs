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

test("markdown reporter: no truncation notice when the report fits", () => {
  const result = makeMultiPackageResult(2, 1);
  const out = new MarkdownReporter().generate(result);
  assert.ok(
    !out.includes("Report truncated"),
    "a small report should not be truncated",
  );
  assert.ok(out.includes("@demo/pkg-0") && out.includes("@demo/pkg-1"));
});
