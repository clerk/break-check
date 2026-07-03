import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  findAbsorbingArmEquivalence,
  loadAliasSurface,
} from "../dist/utils/union-absorption.js";

/** Write a minimal `.api.md` report whose fenced block is `ts`, and load it. */
function surfaceFrom(ts) {
  const dir = mkdtempSync(join(tmpdir(), "break-check-absorb-"));
  const file = join(dir, "pkg.api.md");
  writeFileSync(
    file,
    `## API Report File for "@demo/pkg"\n\n\`\`\`ts\n\n${ts}\n\`\`\`\n`,
  );
  const surface = loadAliasSurface(file);
  rmSync(dir, { recursive: true, force: true });
  return surface;
}

function equivalence(name, baselineTs, currentTs) {
  const baseline = surfaceFrom(baselineTs);
  const current = surfaceFrom(currentTs);
  assert.ok(baseline, "baseline surface must load");
  assert.ok(current, "current surface must load");
  return findAbsorbingArmEquivalence(name, baseline, current);
}

// The verbatim issue #114 shape: the changed alias is an unexpanded
// application, the absorbing arm lives in the (unexported) Autocomplete
// definition, T defaults to string, and the new arm is a conditional type.
const AUTOCOMPLETE = `// @public (undocumented)
type Autocomplete<U extends T, T = string> = U | (T & Record<never, never>);
`;
const OLD_ARM = `// @public (undocumented)
type WithPathPatternWildcard<T = string> = \`\${T & string}(.*)\`;
`;
const NEW_ARM = `// @public (undocumented)
type WithPathSegmentWildcard<T = string> = T extends '/' ? '/:path*' : \`\${T & string}/:path*\`;
`;

test("union-absorption: the issue #114 Autocomplete arm swap is equivalent", () => {
  const hit = equivalence(
    "PathPattern",
    `${AUTOCOMPLETE}${OLD_ARM}${NEW_ARM}
// @public (undocumented)
export type PathPattern = Autocomplete<WithPathPatternWildcard>;
`,
    `${AUTOCOMPLETE}${OLD_ARM}${NEW_ARM}
// @public (undocumented)
export type PathPattern = Autocomplete<WithPathSegmentWildcard>;
`,
  );
  assert.ok(hit, "expected the swap to prove suggestion-only");
  assert.equal(hit.primitive, "string");
  assert.match(hit.arm, /Record<never,never>/);
  assert.deepEqual(hit.removed, ["WithPathPatternWildcard"]);
  assert.deepEqual(hit.added, ["WithPathSegmentWildcard"]);
});

test("union-absorption: a direct union with a `string & {}` arm is equivalent", () => {
  const hit = equivalence(
    "P",
    "export type P = 'a' | (string & {});",
    "export type P = 'b' | (string & {});",
  );
  assert.ok(hit);
  assert.equal(hit.primitive, "string");
  assert.equal(hit.arm, "string&{}");
  assert.deepEqual(hit.removed, ["'a'"]);
  assert.deepEqual(hit.added, ["'b'"]);
});

test("union-absorption: the `Record<never, never>` spelling and added arms work", () => {
  const hit = equivalence(
    "P",
    "export type P = 'a' | (string & Record<never, never>);",
    "export type P = 'a' | 'b' | `x-${string}` | (string & Record<never, never>);",
  );
  assert.ok(hit);
  assert.deepEqual(hit.removed, []);
  assert.deepEqual(hit.added, ["'b'", "`x-${string}`"]);
});

test("union-absorption: the number variant is equivalent", () => {
  const hit = equivalence(
    "P",
    "export type P = 1 | 2 | (number & {});",
    "export type P = 3 | (number & {});",
  );
  assert.ok(hit);
  assert.equal(hit.primitive, "number");
});

test("union-absorption: a reference-free keyword arm may ride along unchanged", () => {
  const hit = equivalence(
    "P",
    "export type P = null | 'a' | (string & {});",
    "export type P = null | 'b' | (string & {});",
  );
  assert.ok(hit, "an unchanged `null` arm is identity-safe on both sides");
});

test("union-absorption: removing the absorbing arm stays breaking", () => {
  assert.equal(
    equivalence(
      "P",
      "export type P = 'a' | (string & {});",
      "export type P = 'a' | 'b';",
    ),
    null,
  );
});

test("union-absorption: respelling the absorbing arm stays breaking", () => {
  // `{}` and `Record<never, never>` are equivalent brands, but the arm is not
  // byte-identical across sides, so the conservative answer is breaking.
  assert.equal(
    equivalence(
      "P",
      "export type P = 'a' | (string & {});",
      "export type P = 'b' | (string & Record<never, never>);",
    ),
    null,
  );
});

test("union-absorption: a changed arm that is not a subtype stays breaking", () => {
  // Numeric literals are not string subtypes: `1` was genuinely removed.
  assert.equal(
    equivalence(
      "P",
      "export type P = 1 | (string & {});",
      "export type P = 2 | (string & {});",
    ),
    null,
  );
});

test("union-absorption: a plain literal union without an absorber stays breaking", () => {
  // The issue #85 contract: a genuine literal-arm change is a real break.
  assert.equal(
    equivalence(
      "P",
      "export type P = 'a' | 'b';",
      "export type P = 'a' | 'c';",
    ),
    null,
  );
});

test("union-absorption: an unchanged referenced arm that proves on both sides rides along", () => {
  const shared = "type Suffix = `x-${string}`;\n";
  const hit = equivalence(
    "P",
    `${shared}export type P = Suffix | 'a' | (string & {});`,
    `${shared}export type P = Suffix | 'b' | (string & {});`,
  );
  assert.ok(hit, "Suffix resolves to a template literal on both sides");
});

test("union-absorption: an unchanged unresolvable reference arm stays breaking", () => {
  // `Foo` is imported: byte-identity proves nothing (the import could point
  // at a different type in each version), and it cannot be proven a subtype.
  assert.equal(
    equivalence(
      "P",
      "export type P = Foo | 'a' | (string & {});",
      "export type P = Foo | 'b' | (string & {});",
    ),
    null,
  );
});

test("union-absorption: a changed arm referencing an unresolvable name stays breaking", () => {
  assert.equal(
    equivalence(
      "P",
      "export type P = Foo | (string & {});",
      "export type P = Bar | (string & {});",
    ),
    null,
  );
});

test("union-absorption: a type parameter named Record poisons the alias", () => {
  assert.equal(
    equivalence(
      "P",
      "export type P<Record> = 'a' | (string & Record<never, never>);",
      "export type P<Record> = 'b' | (string & Record<never, never>);",
    ),
    null,
  );
});

test("union-absorption: a surface that imports Record is refused", () => {
  const surface = surfaceFrom(
    "import { Record } from 'other';\n\nexport type P = 'a' | (string & Record<never, never>);",
  );
  assert.equal(surface, null);
});

test("union-absorption: a changed absorbing-arm argument diverges the expansion", () => {
  // The absorber derives from T; changing the application's binding for T
  // changes the absorbing arm itself, so nothing may be downgraded.
  const alias = "type Auto<U, T = string> = U | (T & Record<never, never>);\n";
  assert.equal(
    equivalence(
      "P",
      `${alias}export type P = Auto<'a'>;`,
      `${alias}export type P = Auto<'b', number>;`,
    ),
    null,
  );
});

test("union-absorption: a changed Autocomplete definition diverges the sides", () => {
  assert.equal(
    equivalence(
      "P",
      "type Auto<U, T = string> = U | (T & Record<never, never>);\nexport type P = Auto<'a'>;",
      "type Auto<U, T = string> = U;\nexport type P = Auto<'b'>;",
    ),
    null,
  );
});

test("union-absorption: a namespace-nested alias does not shadow a top-level one", () => {
  const surface = surfaceFrom(
    "declare namespace NS {\n  type P = string;\n}\n\nexport type P = 'a' | (string & {});",
  );
  assert.ok(surface);
  assert.equal(surface.byName.get("P").bodyText, "'a'|(string&{})");
});

test("union-absorption: template-literal internal spacing is not conflated", () => {
  // The two literals differ only inside the quotes; treating them as the same
  // arm under a NUMBER absorber would hide a real change.
  assert.equal(
    equivalence(
      "P",
      "export type P = 1 | 'a | b' | (number & {});",
      "export type P = 2 | 'a|b' | (number & {});",
    ),
    null,
  );
});

test("union-absorption: a missing alias on either side stays breaking", () => {
  const baseline = surfaceFrom("export type P = 'a' | (string & {});");
  const current = surfaceFrom("export type Q = 'b' | (string & {});");
  assert.equal(findAbsorbingArmEquivalence("P", baseline, current), null);
});
