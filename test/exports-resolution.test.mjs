import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  classifyReference,
  extractInlineImportSpecifiers,
  findUnresolvableReference,
  isSubpathExported,
  looksLikeInternalChunk,
  parseModuleSpecifier,
  readDependencyExports,
} from "../dist/utils/exports-resolution.js";

import { makeSubpathMatcher } from "../dist/utils/api-extractor.js";

test("parseModuleSpecifier: scoped, unscoped, root, relative", () => {
  assert.deepEqual(
    parseModuleSpecifier("@clerk/shared/_chunks/index-DcO1-lAR"),
    {
      pkg: "@clerk/shared",
      subpath: "./_chunks/index-DcO1-lAR",
    },
  );
  assert.deepEqual(parseModuleSpecifier("@clerk/shared"), {
    pkg: "@clerk/shared",
    subpath: ".",
  });
  assert.deepEqual(parseModuleSpecifier("react/jsx-runtime"), {
    pkg: "react",
    subpath: "./jsx-runtime",
  });
  assert.deepEqual(parseModuleSpecifier("lodash"), {
    pkg: "lodash",
    subpath: ".",
  });
  assert.equal(parseModuleSpecifier("./local"), null);
  assert.equal(parseModuleSpecifier("/abs"), null);
});

test("extractInlineImportSpecifiers: pulls every import() specifier from a .d.ts excerpt", () => {
  assert.deepEqual(
    extractInlineImportSpecifiers(
      'export declare const decodeJwt: (token: string) => import("@clerk/shared/_chunks/index-DcO1-lAR").$a;',
    ),
    ["@clerk/shared/_chunks/index-DcO1-lAR"],
  );
  // Multiple specifiers, single-quote support, dedup.
  assert.deepEqual(
    extractInlineImportSpecifiers(
      "type T = import('a/x').A | import(\"b/y\").B | import('a/x').C;",
    ),
    ["a/x", "b/y"],
  );
  assert.deepEqual(extractInlineImportSpecifiers(undefined), []);
  assert.deepEqual(extractInlineImportSpecifiers("type T = string;"), []);
});

test("isSubpathExported: exact keys, wildcards, null-block, longest-prefix-wins", () => {
  const exports = {
    ".": { types: "./dist/index.d.ts" },
    "./types": { types: "./dist/types.d.ts" },
    "./_chunks/*": null,
    "./*": { types: "./dist/*.d.ts" },
  };
  // Exact public subpath.
  assert.equal(isSubpathExported(exports, "./types"), true);
  // Root.
  assert.equal(isSubpathExported(exports, "."), true);
  // Wildcard public match.
  assert.equal(isSubpathExported(exports, "./url"), true);
  // Blocked via null; longest-prefix `./_chunks/*` must beat `./*`.
  assert.equal(isSubpathExported(exports, "./_chunks/index-DcO1-lAR"), false);
});

test("isSubpathExported: equal-base wildcards tie-break on suffix length, order-independent (matches Node)", () => {
  // `./*.json` (longer suffix) must beat `./*` on the equal base prefix `./`,
  // regardless of declaration order, mirroring Node's PATTERN_KEY_COMPARE.
  const blockedFirst = { "./*.json": null, "./*": { types: "./dist/*.d.ts" } };
  const blockedLast = { "./*": { types: "./dist/*.d.ts" }, "./*.json": null };
  assert.equal(isSubpathExported(blockedFirst, "./data.json"), false);
  assert.equal(isSubpathExported(blockedLast, "./data.json"), false);
  // A non-suffixed subpath still resolves via `./*` in both orderings.
  assert.equal(isSubpathExported(blockedFirst, "./foo"), true);
  assert.equal(isSubpathExported(blockedLast, "./foo"), true);
});

test("isSubpathExported: sugar forms and missing map", () => {
  // String sugar: only root is exported.
  assert.equal(isSubpathExported("./dist/index.js", "."), true);
  assert.equal(isSubpathExported("./dist/index.js", "./types"), false);
  // Conditions-only object (no "." keys): root only.
  assert.equal(
    isSubpathExported({ import: "./i.js", require: "./r.js" }, "./types"),
    false,
  );
  // No exports field at all: inconclusive (legacy resolution).
  assert.equal(isSubpathExported(undefined, "./types"), null);
  // Subpath map with no matching key: not exported.
  assert.equal(isSubpathExported({ "./types": "./t.d.ts" }, "./other"), false);
});

test("looksLikeInternalChunk: _chunks segment and hashed basenames", () => {
  assert.equal(
    looksLikeInternalChunk("@clerk/shared/_chunks/index-DcO1-lAR"),
    true,
  );
  assert.equal(looksLikeInternalChunk("pkg/dist/index-Dq-_K2VH"), true);
  // Public, dictionary-word subpath: not a chunk.
  assert.equal(looksLikeInternalChunk("@clerk/shared/use-callback"), false);
  assert.equal(looksLikeInternalChunk("@clerk/shared/types"), false);
  assert.equal(looksLikeInternalChunk("react"), false);
});

function makeDepWorkspace(exportsField) {
  const dir = mkdtempSync(join(tmpdir(), "break-check-exports-"));
  const depDir = join(dir, "node_modules", "@clerk", "shared");
  mkdirSync(depDir, { recursive: true });
  writeFileSync(
    join(depDir, "package.json"),
    JSON.stringify({
      name: "@clerk/shared",
      version: "1.0.0",
      exports: exportsField,
    }),
  );
  return dir;
}

test("readDependencyExports / classifyReference: resolves against an installed dependency", () => {
  const dir = makeDepWorkspace({
    "./types": { types: "./dist/types.d.ts" },
    "./_chunks/*": null,
    "./*": { types: "./dist/*.d.ts" },
  });
  try {
    const found = readDependencyExports("@clerk/shared", dir);
    assert.equal(found.found, true);

    assert.equal(
      classifyReference("@clerk/shared/_chunks/index-DcO1-lAR", dir),
      "blocked",
    );
    assert.equal(classifyReference("@clerk/shared/types", dir), "exported");
    assert.equal(classifyReference("@clerk/shared/url", dir), "exported");
    // Package root is always public.
    assert.equal(classifyReference("@clerk/shared", dir), "exported");
    // Not installed here: unknown (caller falls back to the heuristic).
    assert.equal(classifyReference("not-installed/foo", dir), "unknown");
    // Relative specifiers are not a cross-package concern.
    assert.equal(classifyReference("./local", dir), "exported");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findUnresolvableReference: flags a newly-introduced export-blocked specifier", () => {
  const dir = makeDepWorkspace({
    "./types": { types: "./dist/types.d.ts" },
    "./_chunks/*": null,
  });
  try {
    const change = {
      beforeSnippet:
        'export declare const decodeJwt: (token: string) => import("@clerk/shared/types").Jwt;',
      afterSnippet:
        'export declare const decodeJwt: (token: string) => import("@clerk/shared/_chunks/index-DcO1-lAR").$a;',
    };
    const hit = findUnresolvableReference(change, dir);
    assert.equal(hit?.specifier, "@clerk/shared/_chunks/index-DcO1-lAR");
    assert.equal(hit?.deterministic, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findUnresolvableReference: an unchanged reference is not re-flagged", () => {
  const dir = makeDepWorkspace({ "./_chunks/*": null });
  try {
    const spec = 'import("@clerk/shared/_chunks/index-DcO1-lAR").$a';
    // Same blocked specifier on both sides => not newly introduced => clean.
    const change = {
      beforeSnippet: `export declare const a: () => ${spec};`,
      afterSnippet: `export declare const a: (x: number) => ${spec};`,
    };
    assert.equal(findUnresolvableReference(change, dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findUnresolvableReference: resolvableSpecifiers allowlist suppresses the flag", () => {
  const dir = makeDepWorkspace({ "./_chunks/*": null });
  try {
    const change = {
      beforeSnippet:
        'export declare const a: () => import("@clerk/shared/types").Jwt;',
      afterSnippet:
        'export declare const a: () => import("@clerk/shared/_chunks/index-DcO1-lAR").$a;',
    };
    const allow = makeSubpathMatcher(["@clerk/shared/_chunks/*"]);
    assert.equal(findUnresolvableReference(change, dir, allow), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findUnresolvableReference: coarse backstop flags a _chunks ref when the dep can't be located", () => {
  // Empty workspace: classifyReference returns 'unknown', so the
  // looksLikeInternalChunk backstop must catch the /_chunks/ path.
  const dir = mkdtempSync(join(tmpdir(), "break-check-exports-empty-"));
  try {
    const change = {
      beforeSnippet: 'export declare const a: () => import("dep/types").Jwt;',
      afterSnippet:
        'export declare const a: () => import("dep/_chunks/index-DcO1-lAR").Jwt;',
    };
    const hit = findUnresolvableReference(change, dir);
    assert.equal(hit?.specifier, "dep/_chunks/index-DcO1-lAR");
    // Heuristic-only (dependency not locatable): not a deterministic verdict.
    assert.equal(hit?.deterministic, false);

    // A plain new public-looking ref to an unlocatable dep is NOT flagged
    // (unknown + not chunk-like => clean), to avoid false positives.
    const clean = {
      beforeSnippet: "export declare const a: () => string;",
      afterSnippet: 'export declare const a: () => import("dep/types").Jwt;',
    };
    assert.equal(findUnresolvableReference(clean, dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
