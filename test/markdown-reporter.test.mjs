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

test("markdown reporter: oversized snippets are truncated and wrapped in <details>", () => {
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

  assert.ok(out.includes("<details>"), "expected <details> wrapper");
  assert.ok(
    out.includes("Diff truncated"),
    "expected summary mentioning truncation",
  );
  assert.match(out, /more lines? elided/);
  // Sanity: the rendered report should be far smaller than the raw snippet size.
  assert.ok(
    out.length < 10_000,
    `expected truncated report under 10KB, got ${out.length} bytes`,
  );
});
