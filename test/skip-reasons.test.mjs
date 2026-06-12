import assert from "node:assert/strict";
import { test } from "node:test";

import { describeExtractionFailure } from "../dist/utils/api-extractor.js";

const AE_BOILERPLATE =
  "\n\nYou have encountered a software defect. Please consider reporting " +
  "the issue to the maintainers of this application.";

test("describeExtractionFailure: ambient declaration file (unable to determine module)", () => {
  const reason = describeExtractionFailure(
    "Internal Error: Unable to determine module for: " +
      "/repo/packages/astro/env.d.ts" +
      AE_BOILERPLATE,
  );

  assert.match(
    reason,
    /^ambient declaration file \(no top-level import or export\)/,
  );
  assert.match(reason, /cannot be snapshotted/);
  assert.match(reason, /`ignoreSubpaths`/);
  assert.ok(
    reason.endsWith(
      "(API Extractor: Unable to determine module for: " +
        "/repo/packages/astro/env.d.ts)",
    ),
  );
  assert.ok(!reason.includes("software defect"));
});

test("describeExtractionFailure: unresolvable type name (unable to follow symbol)", () => {
  const reason = describeExtractionFailure(
    'Internal Error: Unable to follow symbol for "Cookies"' + AE_BOILERPLATE,
  );

  assert.match(
    reason,
    /^the shipped declarations reference the type name "Cookies"/,
  );
  assert.match(reason, /published types are likely broken for consumers/);
  assert.match(reason, /`ignoreSubpaths`/);
  assert.ok(
    reason.endsWith('(API Extractor: Unable to follow symbol for "Cookies")'),
  );
  assert.ok(!reason.includes("software defect"));
});

test("describeExtractionFailure: unresolvable type name (symbol not found, no boilerplate)", () => {
  const reason = describeExtractionFailure(
    "Symbol not found for identifier: Cypress",
  );

  assert.match(
    reason,
    /^the shipped declarations reference the type name "Cypress"/,
  );
  assert.match(reason, /`ignoreSubpaths`/);
  assert.ok(
    reason.endsWith(
      "(API Extractor: Symbol not found for identifier: Cypress)",
    ),
  );
});

test("describeExtractionFailure: unresolvable import type (multi-line InternalError)", () => {
  const reason = describeExtractionFailure(
    'Internal Error: Symbol not found for identifier: import("foo").Bar\n' +
      "/repo/packages/example/dist/index.d.ts:3:18" +
      AE_BOILERPLATE,
  );

  assert.match(
    reason,
    /^the shipped declarations reference the type name "import\("foo"\)\.Bar"/,
  );
  assert.match(reason, /`ignoreSubpaths`/);
  assert.ok(
    reason.endsWith(
      '(API Extractor: Symbol not found for identifier: import("foo").Bar)',
    ),
  );
  assert.ok(!reason.includes("software defect"));
});

test("describeExtractionFailure: identifiers beyond \\w+ are captured", () => {
  assert.match(
    describeExtractionFailure("Symbol not found for identifier: $"),
    /reference the type name "\$"/,
  );
  assert.match(
    describeExtractionFailure(
      'Internal Error: Unable to follow symbol for "Foo.Bar"' + AE_BOILERPLATE,
    ),
    /reference the type name "Foo\.Bar"/,
  );
});

test("describeExtractionFailure: entry context names the exact scoped ignoreSubpaths entry", () => {
  const reason = describeExtractionFailure(
    "Internal Error: Unable to determine module for: " +
      "/repo/packages/astro/env.d.ts" +
      AE_BOILERPLATE,
    { packageName: "@clerk/astro", subpath: "./env" },
  );

  assert.match(
    reason,
    /add `"@clerk\/astro#\.\/env"` to `ignoreSubpaths` to acknowledge it/,
  );
  assert.ok(!reason.includes("add the subpath"));
});

test("describeExtractionFailure: entry context applies to the unresolvable-type guidance too", () => {
  const reason = describeExtractionFailure(
    "Symbol not found for identifier: Cypress",
    { packageName: "@clerk/testing", subpath: "./cypress" },
  );

  assert.match(
    reason,
    /add `"@clerk\/testing#\.\/cypress"` to `ignoreSubpaths` as a stopgap/,
  );
});

test("describeExtractionFailure: unclassified InternalError loses the boilerplate", () => {
  const reason = describeExtractionFailure(
    "Internal Error: Something nobody has seen before" + AE_BOILERPLATE,
  );

  assert.equal(reason, "Internal Error: Something nobody has seen before");
});

test("describeExtractionFailure: plain messages pass through unchanged", () => {
  const message =
    "API Extractor failed for @clerk/example (./foo): 2 errors, 0 warnings";
  assert.equal(describeExtractionFailure(message), message);
});
