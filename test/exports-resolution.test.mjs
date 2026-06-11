import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  classifyReference,
  collectReferenceTransitions,
  extractInlineImportSpecifiers,
  findRepairedReference,
  findUnresolvableReference,
  isSubpathExported,
  looksLikeInternalChunk,
  parseModuleSpecifier,
  readDependencyExports,
  signaturesMatchModuloSwappedReferences,
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
    ".": { types: "./dist/index.d.ts" },
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
    // The root resolves against `exports` like any other subpath; it's present
    // here, so it's exported.
    assert.equal(classifyReference("@clerk/shared", dir), "exported");
    // Not installed here: unknown (caller falls back to the heuristic).
    assert.equal(classifyReference("not-installed/foo", dir), "unknown");
    // Relative specifiers are not a cross-package concern.
    assert.equal(classifyReference("./local", dir), "exported");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("classifyReference: an export-blocked or absent root is not assumed exported (#5)", () => {
  // `{ ".": null }` blocks the root; a bare `import("dep")` is unresolvable.
  const blockedRoot = makeDepWorkspace({
    ".": null,
    "./types": { types: "./dist/types.d.ts" },
  });
  // A subpath-only map with no "." key: the root is not exported.
  const noRootKey = makeDepWorkspace({ "./types": { types: "./dist/t.d.ts" } });
  try {
    assert.equal(classifyReference("@clerk/shared", blockedRoot), "blocked");
    // A real public subpath on the same package still resolves.
    assert.equal(
      classifyReference("@clerk/shared/types", blockedRoot),
      "exported",
    );
    assert.equal(classifyReference("@clerk/shared", noRootKey), "blocked");
  } finally {
    rmSync(blockedRoot, { recursive: true, force: true });
    rmSync(noRootKey, { recursive: true, force: true });
  }
});

test("classifyReference: top-level `exports: null` falls back to legacy resolution, not blocked (#5)", () => {
  // Node ignores a null `exports` field and resolves the root via main/types, so
  // a bare `import("dep")` still works. The guard must treat it as inconclusive
  // (unknown), never blocked, so a newly introduced root reference isn't falsely
  // escalated to breaking.
  const nullExports = makeDepWorkspace(null);
  try {
    assert.equal(classifyReference("@clerk/shared", nullExports), "unknown");
  } finally {
    rmSync(nullExports, { recursive: true, force: true });
  }
});

test('isSubpathExported: a null `exports` field is inconclusive; `{ ".": null }` blocks the root (#5)', () => {
  // A top-level null field == a missing field (legacy fallback), so inconclusive.
  assert.equal(isSubpathExported(null, "."), null);
  assert.equal(isSubpathExported(null, "./types"), null);
  // But an explicit null target on the root IS a block.
  assert.equal(isSubpathExported({ ".": null }, "."), false);
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

test("collectReferenceTransitions: classifies dropped and introduced specifiers, skips unchanged ones", () => {
  const dir = makeDepWorkspace({
    "./_chunks/*": null,
    "./*": { types: "./dist/*.d.ts" },
  });
  try {
    const change = {
      beforeSnippet:
        'export declare const a: (x: import("@clerk/shared/_chunks/index-Cr_OtBLq").Xm) => import("@clerk/shared/url").U;',
      afterSnippet:
        'export declare const a: (x: import("@clerk/shared/types/utils").Without) => import("@clerk/shared/url").U;',
    };
    assert.deepEqual(collectReferenceTransitions(change, dir), [
      {
        specifier: "@clerk/shared/_chunks/index-Cr_OtBLq",
        side: "removed",
        verdict: "blocked",
        deterministic: true,
      },
      {
        specifier: "@clerk/shared/types/utils",
        side: "introduced",
        verdict: "exported",
        deterministic: true,
      },
    ]);

    // Same specifiers on both sides: no transitions.
    assert.deepEqual(
      collectReferenceTransitions(
        {
          beforeSnippet: 'type A = import("@clerk/shared/url").U;',
          afterSnippet: 'type A = import("@clerk/shared/url").U | null;',
        },
        dir,
      ),
      [],
    );
    // No inline imports at all.
    assert.deepEqual(
      collectReferenceTransitions(
        { beforeSnippet: "type A = string;", afterSnippet: "type A = number;" },
        dir,
      ),
      [],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectReferenceTransitions: marks an unlocatable chunk-shaped specifier internalChunk", () => {
  const dir = mkdtempSync(join(tmpdir(), "break-check-exports-empty-"));
  try {
    const change = {
      beforeSnippet:
        'export declare const a: () => import("gone-dep/_chunks/index-Cr_OtBLq").Xm;',
      afterSnippet: "export declare const a: () => string;",
    };
    assert.deepEqual(collectReferenceTransitions(change, dir), [
      {
        specifier: "gone-dep/_chunks/index-Cr_OtBLq",
        side: "removed",
        verdict: "unknown",
        deterministic: false,
        packageNotFound: true,
        internalChunk: true,
      },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The issue #98 repro shape: a blocked chunk specifier replaced by an exported
// subpath, with the imported alias renamed alongside (`Xm` is the minified
// chunk-internal name of `Without`).
const REPAIR_BEFORE =
  'SignInWithMetamaskButton: { (props: import("@clerk/shared/_chunks/index-Cr_OtBLq").Xm<WithClerkProp<SignInWithMetamaskButtonProps>, "clerk">): React.JSX.Element | null; displayName: string; }';
const REPAIR_AFTER =
  'SignInWithMetamaskButton: { (props: import("@clerk/shared/types/utils").Without<WithClerkProp<SignInWithMetamaskButtonProps>, "clerk">): React.JSX.Element | null; displayName: string; }';

function repairFor(change, dir, isAllowed) {
  return findRepairedReference(
    change,
    collectReferenceTransitions(change, dir),
    isAllowed,
  );
}

test("findRepairedReference: blocked -> exported specifier swap with identical signature is a repair (#98)", () => {
  const dir = makeDepWorkspace({
    "./_chunks/*": null,
    "./*": { types: "./dist/*.d.ts" },
  });
  try {
    const repair = repairFor(
      { beforeSnippet: REPAIR_BEFORE, afterSnippet: REPAIR_AFTER },
      dir,
    );
    assert.deepEqual(repair, {
      from: ["@clerk/shared/_chunks/index-Cr_OtBLq"],
      to: ["@clerk/shared/types/utils"],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findRepairedReference: heuristic before-side (unlocatable chunk) still qualifies when the after side is deterministically exported", () => {
  // The removed specifier's package is gone from node_modules entirely; only
  // the chunk-shape heuristic vouches for it. The introduced side must still
  // resolve deterministically.
  const dir = makeDepWorkspace({ "./*": { types: "./dist/*.d.ts" } });
  try {
    const change = {
      beforeSnippet:
        'export declare const a: () => import("gone-dep/_chunks/index-Cr_OtBLq").Xm;',
      afterSnippet:
        'export declare const a: () => import("@clerk/shared/types/utils").Without;',
    };
    assert.deepEqual(repairFor(change, dir), {
      from: ["gone-dep/_chunks/index-Cr_OtBLq"],
      to: ["@clerk/shared/types/utils"],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findRepairedReference: refuses when the swap is not strictly an improvement", () => {
  const dir = makeDepWorkspace({
    "./_chunks/*": null,
    "./*": { types: "./dist/*.d.ts" },
  });
  try {
    // Introduced side blocked (chunk -> chunk): not a repair; the unresolvable
    // guard owns this case.
    assert.equal(
      repairFor(
        {
          beforeSnippet:
            'type A = import("@clerk/shared/_chunks/index-Cr_OtBLq").Xm;',
          afterSnippet:
            'type A = import("@clerk/shared/_chunks/index-DcO1-lAR").Ym;',
        },
        dir,
      ),
      null,
    );
    // Removed side exported (public -> public rename): the pessimistic rule
    // stands; the referenced type's identity may genuinely have changed.
    assert.equal(
      repairFor(
        {
          beforeSnippet: 'type A = import("@clerk/shared/types").Foo;',
          afterSnippet: 'type A = import("@clerk/shared/types/utils").Foo;',
        },
        dir,
      ),
      null,
    );
    // Removed side unlocatable but NOT chunk-shaped: no evidence it was
    // unconsumable, so no repair.
    assert.equal(
      repairFor(
        {
          beforeSnippet: 'type A = import("gone-dep/types").Foo;',
          afterSnippet: 'type A = import("@clerk/shared/types/utils").Foo;',
        },
        dir,
      ),
      null,
    );
    // Nothing introduced (reference dropped entirely): not a swap.
    assert.equal(
      repairFor(
        {
          beforeSnippet:
            'type A = import("@clerk/shared/_chunks/index-Cr_OtBLq").Xm;',
          afterSnippet: "type A = string;",
        },
        dir,
      ),
      null,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findRepairedReference: only the exports map may vouch for the introduced side", () => {
  const dir = makeDepWorkspace({
    "./_chunks/*": null,
    "./*": { types: "./dist/*.d.ts" },
  });
  try {
    const before =
      'type A = import("@clerk/shared/_chunks/index-Cr_OtBLq").Xm;';
    // Introduced specifier's package is not installed: verdict `unknown`, and
    // `unknown` must never satisfy the introduced side, with or without a
    // chunk-shaped name. (A mutation relaxing `verdict === "exported"` to
    // `verdict !== "blocked"` must fail these.)
    assert.equal(
      repairFor(
        {
          beforeSnippet: before,
          afterSnippet: 'type A = import("gone-dep/types").Foo;',
        },
        dir,
      ),
      null,
    );
    assert.equal(
      repairFor(
        {
          beforeSnippet: before,
          afterSnippet:
            'type A = import("gone-dep/_chunks/index-Ab12Cd34").Foo;',
        },
        dir,
      ),
      null,
    );
    // Relative and absolute specifiers bypass exports maps entirely;
    // classifyReference calls them "exported" for the fail-safe escalation
    // guard, but nothing deterministic vouches for them here. An absolute
    // path is tsc's non-portable declaration emit, which consumers can never
    // resolve.
    assert.equal(
      repairFor(
        {
          beforeSnippet: before,
          afterSnippet: 'type A = import("./chunks/index-Cr_OtBLq.js").Xm;',
        },
        dir,
      ),
      null,
    );
    assert.equal(
      repairFor(
        {
          beforeSnippet: before,
          afterSnippet:
            'type A = import("/home/runner/work/clerk/dist/utils").Without;',
        },
        dir,
      ),
      null,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findRepairedReference: a located dependency without an exports map cannot vouch for a removed chunk", () => {
  // No `exports` field at all: legacy resolution serves every file, so the
  // chunk-shaped subpath may genuinely have resolved for consumers (the .d.ts
  // ships on disk). The before state was consumable; downgrading would hide a
  // real type swap. Only an unlocatable package lets the chunk heuristic vouch.
  const dir = makeDepWorkspace(undefined);
  try {
    // Second dependency for the exported after side, installed in the same tree.
    const otherDep = join(dir, "node_modules", "new-dep");
    mkdirSync(otherDep, { recursive: true });
    writeFileSync(
      join(otherDep, "package.json"),
      JSON.stringify({
        name: "new-dep",
        version: "1.0.0",
        exports: { "./*": { types: "./dist/*.d.ts" } },
      }),
    );
    const change = {
      beforeSnippet:
        'type A = import("@clerk/shared/_chunks/index-Cr_OtBLq").Xm;',
      afterSnippet: 'type A = import("new-dep/utils").Without;',
    };
    const transitions = collectReferenceTransitions(change, dir);
    assert.deepEqual(transitions[0], {
      specifier: "@clerk/shared/_chunks/index-Cr_OtBLq",
      side: "removed",
      verdict: "unknown",
      deterministic: false,
      internalChunk: true,
    });
    assert.equal(findRepairedReference(change, transitions), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findRepairedReference: refuses when the signature changed beyond the specifier swap", () => {
  const dir = makeDepWorkspace({
    "./_chunks/*": null,
    "./*": { types: "./dist/*.d.ts" },
  });
  try {
    // Same swap, but a generic argument also changed: fails closed.
    const after = REPAIR_AFTER.replace('"clerk"', '"clerk" | "user"');
    assert.equal(
      repairFor({ beforeSnippet: REPAIR_BEFORE, afterSnippet: after }, dir),
      null,
    );
    // A removal (no after snippet) is never a repair.
    assert.equal(
      repairFor({ beforeSnippet: REPAIR_BEFORE, afterSnippet: undefined }, dir),
      null,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findRepairedReference: a resolvableSpecifiers entry on the removed side disables the repair", () => {
  // The maintainer asserted the old specifier WAS resolvable, so the premise
  // (before state unconsumable) does not hold.
  const dir = makeDepWorkspace({
    "./_chunks/*": null,
    "./*": { types: "./dist/*.d.ts" },
  });
  try {
    const allow = makeSubpathMatcher(["@clerk/shared/_chunks/*"]);
    assert.equal(
      repairFor(
        { beforeSnippet: REPAIR_BEFORE, afterSnippet: REPAIR_AFTER },
        dir,
        allow,
      ),
      null,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("signaturesMatchModuloSwappedReferences: masks the import unit plus its immediate member, tolerates whitespace", () => {
  // Alias renamed with the specifier, formatting noise on one side: match.
  assert.equal(
    signaturesMatchModuloSwappedReferences(
      'type A = import("a/_chunks/x-Abc12345").Xm< T ,  "k" >;',
      'type A = import("a/types").Without<T, "k">;',
      ["a/_chunks/x-Abc12345"],
      ["a/types"],
    ),
    true,
  );
  // Only the first member access is masked: a deeper chain must still match...
  assert.equal(
    signaturesMatchModuloSwappedReferences(
      'type A = import("a/_chunks/x-Abc12345").Xm.Inner;',
      'type A = import("a/types").Without.Inner;',
      ["a/_chunks/x-Abc12345"],
      ["a/types"],
    ),
    true,
  );
  // ...and a diverging deeper chain does not.
  assert.equal(
    signaturesMatchModuloSwappedReferences(
      'type A = import("a/_chunks/x-Abc12345").Xm.Inner;',
      'type A = import("a/types").Without.Other;',
      ["a/_chunks/x-Abc12345"],
      ["a/types"],
    ),
    false,
  );
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
