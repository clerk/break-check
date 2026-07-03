import assert from "node:assert/strict";
import { test } from "node:test";

import { canonicalizeType } from "../dist/utils/canonicalize-type.js";

test("canonicalizeType: sorts top-level union members", () => {
  assert.equal(canonicalizeType("string|number"), "number|string");
  assert.equal(canonicalizeType("number|string"), "number|string");
  assert.equal(
    canonicalizeType("string|number|boolean"),
    "boolean|number|string",
  );
});

test("canonicalizeType: is order-independent (symmetric) and idempotent", () => {
  const a = canonicalizeType('"c"|"a"|"b"');
  const b = canonicalizeType('"b"|"c"|"a"');
  assert.equal(a, b);
  assert.equal(canonicalizeType(a), a);
});

test("canonicalizeType: sorts a union nested inside a generic", () => {
  assert.equal(
    canonicalizeType("Array<string|number>"),
    "Array<number|string>",
  );
  assert.equal(canonicalizeType("Map<string,A|B>"), "Map<string,A|B>");
});

test("canonicalizeType: sorts unions inside an object body, per property", () => {
  // Independent unions in separate properties must not be conflated, and the
  // property order is preserved.
  assert.equal(canonicalizeType("{a:2|1;b:4|3}"), "{a:1|2;b:3|4}");
});

test("canonicalizeType: preserves tuple element order, sorts inner unions", () => {
  assert.equal(canonicalizeType("[string,number]"), "[string,number]");
  assert.equal(canonicalizeType("[B|A,D|C]"), "[A|B,C|D]");
});

test("canonicalizeType: sorts intersection members", () => {
  assert.equal(canonicalizeType("{b:2}&{a:1}"), "{a:1}&{b:2}");
});

test("canonicalizeType: respects &-over-| precedence", () => {
  // A & B | C parses as (A & B) | C; the two spellings are the same type.
  assert.equal(canonicalizeType("A&B|C"), canonicalizeType("C|B&A"));
});

test("canonicalizeType: does not split a pipe inside a string literal", () => {
  assert.equal(canonicalizeType('"a|b"|"c"'), '"a|b"|"c"');
  assert.equal(canonicalizeType('"c"|"a|b"'), '"a|b"|"c"');
});

test("canonicalizeType: dedups exact-equal members", () => {
  assert.equal(canonicalizeType("A|A|B"), "A|B");
});

test("canonicalizeType: fail-closed on function and conditional types", () => {
  // The union after `=>` / a conditional branch is not reordered (returned as
  // given), so a bug never reorders something it cannot parse.
  assert.equal(canonicalizeType("(x:A)=>B|C"), "(x:A)=>B|C");
  assert.equal(canonicalizeType("A extends B?C:D|E"), "A extends B?C:D|E");
});

test("canonicalizeType: fail-closed on malformed input", () => {
  assert.equal(canonicalizeType("Foo<string|number"), "Foo<string|number");
  assert.equal(canonicalizeType("string|number)"), "string|number)");
});

test("canonicalizeType: leaves non-union strings untouched", () => {
  assert.equal(canonicalizeType("void"), "void");
  assert.equal(canonicalizeType("Promise<void>"), "Promise<void>");
  assert.equal(canonicalizeType(""), "");
});

import {
  collapseUnquotedWhitespace,
  normalizeTypeSpacing,
} from "../dist/utils/canonicalize-type.js";

test("normalizeTypeSpacing: strips spacing outside quotes only", () => {
  assert.equal(
    normalizeTypeSpacing("{ a : string ; b : number }"),
    "{a:string;b:number}",
  );
  // The literal's interior is real type content: 'a | b' and 'a|b' are
  // different types and must not normalize to the same key.
  assert.equal(normalizeTypeSpacing("'a | b' | 'c'"), "'a | b'|'c'");
  assert.notEqual(
    normalizeTypeSpacing("'a | b'"),
    normalizeTypeSpacing("'a|b'"),
  );
  assert.equal(normalizeTypeSpacing("`x ${ string } y`"), "`x ${ string } y`");
});

test("normalizeTypeSpacing: leaves an unterminated quote as-is (fail-closed)", () => {
  assert.equal(normalizeTypeSpacing("foo : 'bar"), "foo:'bar");
});

test("collapseUnquotedWhitespace: collapses runs outside quotes only", () => {
  assert.equal(collapseUnquotedWhitespace("a   :   'x  y'  "), "a : 'x  y'");
  assert.notEqual(
    collapseUnquotedWhitespace("'a  b'"),
    collapseUnquotedWhitespace("'a b'"),
  );
});
