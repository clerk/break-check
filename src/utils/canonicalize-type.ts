/**
 * Canonicalize the member order of unions and intersections inside a type
 * string, so a pure reorder of identical members is not seen as a change.
 *
 * TypeScript emits the members of an *inferred* union in an order derived from
 * its internal type-id table, which is not stable across builds: an unrelated
 * edit elsewhere rotates the order. The differ compares serialized type strings
 * with `!==`, so `"a" | "b"` vs `"b" | "a"` reads as a breaking change even
 * though the members are identical (issue #85). Sorting the members before
 * comparing collapses the reorder to a no-op while a genuine add/remove still
 * changes the member multiset and is reported.
 *
 * This is a *comparison-key-only* transform. It runs on both the baseline and
 * the current read through the same path, so it is symmetric and needs no
 * snapshot/schema bump; an older baseline that recorded the "wrong" order
 * reconciles automatically. The human-readable before/after snippets keep their
 * original spelling.
 *
 * Design constraints that make this safe:
 *
 * - It is parser-light, not a TypeScript AST: `typescript` is not a runtime
 *   dependency of the published package. It tracks nesting depth across
 *   `() [] {} <>` and skips quoted/template regions, so it only ever splits at
 *   the top level of a type and never inside a string literal, generic, object,
 *   or tuple.
 * - It is **fail-closed**: anything it cannot confidently parse as a flat list
 *   of union/intersection peers (a function type `=>`, a conditional
 *   `T extends U ? X : Y`, or a structurally malformed string) is returned
 *   unchanged. A bug here can at worst leave a phantom breaking change (the
 *   status quo), never hide a real one.
 * - It only reorders and exact-dedups members. It does not attempt semantic
 *   normalization (`A | never`, `true | false` -> `boolean`, distributivity);
 *   the differ's type variance is intentionally pessimistic and only the AI
 *   reviewer downgrades.
 */

interface TopScan {
  /** False when the string is structurally malformed (unbalanced / unterminated). */
  ok: boolean;
  /** Depth-0 indices of each delimiter / boundary character. */
  pipes: number[];
  amps: number[];
  semis: number[];
  commas: number[];
  colons: number[];
  /** Depth-0 `=` that is an alias/default sign, never the `=` of `=>`. */
  eqs: number[];
  /**
   * A depth-0 construct we refuse to reorder around: a function type (`=>`), a
   * conditional type (`?` not used as the optional `?:`), or a conditional
   * `extends`. Its presence disables top-level member sorting for the segment.
   */
  gated: boolean;
  /** Depth-0 bracket groups, as [openIndex, closeIndex] inclusive of both. */
  groups: Array<{ open: number; close: number }>;
  /** Depth-0 conditional `?` (never the optional-property `?:`). */
  questions: number[];
  /** Depth-0 start indices of the `extends` keyword (a conditional check). */
  extendsKw: number[];
}

/** Advance past a quoted region; return the index just after the close quote, or -1 if unterminated. */
function skipQuote(s: string, start: number): number {
  const quote = s[start];
  let i = start + 1;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === quote) return i + 1;
    i++;
  }
  return -1;
}

function isWordChar(c: string | undefined): boolean {
  return c !== undefined && /[A-Za-z0-9_$]/.test(c);
}

function matchesWordAt(s: string, i: number, word: string): boolean {
  if (!s.startsWith(word, i)) return false;
  if (isWordChar(s[i - 1])) return false;
  if (isWordChar(s[i + word.length])) return false;
  return true;
}

function nextNonSpace(s: string, i: number): string | undefined {
  let j = i;
  while (j < s.length && s[j] === " ") j++;
  return s[j];
}

/** Single left-to-right pass collecting depth-0 structure for one string. */
function scanTop(s: string): TopScan {
  const res: TopScan = {
    ok: true,
    pipes: [],
    amps: [],
    semis: [],
    commas: [],
    colons: [],
    eqs: [],
    gated: false,
    groups: [],
    questions: [],
    extendsKw: [],
  };
  let depth = 0;
  let groupStart = -1;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'" || c === "`") {
      const close = skipQuote(s, i);
      if (close < 0) {
        res.ok = false;
        return res;
      }
      i = close;
      continue;
    }
    // The `>` of `=>` is not a closing angle bracket; consume the arrow whole so
    // it does not corrupt depth tracking, and gate it at the top level.
    if (c === "=" && s[i + 1] === ">") {
      if (depth === 0) res.gated = true;
      i += 2;
      continue;
    }
    if (c === "<" || c === "(" || c === "[" || c === "{") {
      if (depth === 0) groupStart = i;
      depth++;
      i++;
      continue;
    }
    if (c === ">" || c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth < 0) {
        res.ok = false;
        return res;
      }
      if (depth === 0 && groupStart >= 0) {
        res.groups.push({ open: groupStart, close: i });
        groupStart = -1;
      }
      i++;
      continue;
    }
    if (depth === 0) {
      if (c === "|") res.pipes.push(i);
      else if (c === "&") res.amps.push(i);
      else if (c === ";") res.semis.push(i);
      else if (c === ",") res.commas.push(i);
      else if (c === ":") res.colons.push(i);
      else if (c === "=") res.eqs.push(i);
      else if (c === "?") {
        // `?:` is an optional-property marker, not a conditional type.
        if (nextNonSpace(s, i + 1) !== ":") {
          res.gated = true;
          res.questions.push(i);
        }
      } else if (matchesWordAt(s, i, "extends")) {
        res.gated = true;
        res.extendsKw.push(i);
        i += "extends".length;
        continue;
      }
    }
    i++;
  }
  if (depth !== 0) res.ok = false;
  return res;
}

/** Split `s` at the given (single-character) delimiter indices. */
function splitAt(s: string, positions: number[]): string[] {
  const parts: string[] = [];
  let prev = 0;
  for (const p of positions) {
    parts.push(s.slice(prev, p));
    prev = p + 1;
  }
  parts.push(s.slice(prev));
  return parts;
}

/** Stable code-unit sort (locale-independent) then drop exact-equal neighbours. */
function sortUnique(members: string[]): string[] {
  const sorted = [...members].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const out: string[] = [];
  for (const m of sorted) {
    if (out.length === 0 || out[out.length - 1] !== m) out.push(m);
  }
  return out;
}

/**
 * Apply `fn` to every unquoted span of `s`, leaving string/template literal
 * contents byte-for-byte intact. An unterminated quote appends the remainder
 * raw, so downstream compares see the malformed text as-is (fail-closed).
 */
function mapUnquoted(s: string, fn: (span: string) => string): string {
  let out = "";
  let span = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'" || c === "`") {
      out += fn(span);
      span = "";
      const close = skipQuote(s, i);
      if (close < 0) {
        out += s.slice(i);
        return out;
      }
      out += s.slice(i, close);
      i = close;
      continue;
    }
    span += c;
    i++;
  }
  return out + fn(span);
}

/**
 * Collapse whitespace runs to single spaces outside quoted regions, and trim.
 * A string or template literal's interior is significant type content
 * (`'a  b'` and `'a b'` are different types), so it is never touched.
 */
export function collapseUnquotedWhitespace(text: string): string {
  return mapUnquoted(text, (span) => span.replace(/\s+/g, " ")).trim();
}

/**
 * Comparison-key spacing normalization for a type string: collapse whitespace
 * runs and drop spaces around punctuation, outside quoted regions only. A
 * quote-blind version of this conflates two literals that differ only in
 * internal spacing (`'a | b'` vs `'a|b'`), silently hiding a real change.
 */
export function normalizeTypeSpacing(text: string): string {
  return mapUnquoted(text, (span) =>
    span.replace(/\s+/g, " ").replace(/\s*([,;:()<>[\]{}|&])\s*/g, "$1"),
  ).trim();
}

/**
 * Canonicalize a bare type expression: sort its top-level union members, or
 * (when there is no top-level union) its top-level intersection members. `&`
 * binds tighter than `|`, so unions are handled first and each union member's
 * intersection is sorted within it, preserving precedence. Nested members are
 * assumed to already have had their brackets canonicalized by `canonClause`.
 */
function canonTypeRegion(region: string): string {
  const r = region.trim();
  const scan = scanTop(r);
  if (!scan.ok || scan.gated) return r;
  if (scan.pipes.length > 0) {
    const members = splitAt(r, scan.pipes)
      .map((m) => canonTypeRegion(m))
      .filter((m) => m.length > 0);
    return sortUnique(members).join("|");
  }
  if (scan.amps.length > 0) {
    const members = splitAt(r, scan.amps)
      .map((m) => canonTypeRegion(m))
      .filter((m) => m.length > 0);
    return sortUnique(members).join("&");
  }
  return r;
}

/**
 * Canonicalize one clause (a single property, parameter, or declaration). First
 * recurse into every depth-0 bracket group so nested unions are normalized, then
 * isolate the clause's type region (the part after the last depth-0 `:` or the
 * first depth-0 `=`) and sort its top-level members. The prefix (a `name:`,
 * `export ... =`, etc.) is preserved verbatim so members are never glommed onto
 * it.
 */
function canonClause(piece: string): string {
  const scan = scanTop(piece);
  if (!scan.ok) return piece;

  // Step 1: canonicalize the interior of each top-level bracket group.
  let rebuilt = "";
  let prev = 0;
  for (const g of scan.groups) {
    rebuilt += piece.slice(prev, g.open + 1);
    rebuilt += canon(piece.slice(g.open + 1, g.close));
    prev = g.close;
  }
  rebuilt += piece.slice(prev);

  // Interior canonicalization shifts indices, so re-scan before step 2.
  const s2 = scanTop(rebuilt);
  if (!s2.ok || s2.gated) return rebuilt;

  // Step 2: sort the top-level union/intersection of the clause's type region.
  let boundary = -1;
  if (s2.colons.length > 0) boundary = s2.colons[s2.colons.length - 1];
  else if (s2.eqs.length > 0) boundary = s2.eqs[0];
  const prefix = boundary >= 0 ? rebuilt.slice(0, boundary + 1) : "";
  const region = boundary >= 0 ? rebuilt.slice(boundary + 1) : rebuilt;
  return prefix + canonTypeRegion(region);
}

/**
 * Canonicalize a string that may hold several `;`/`,`-separated clauses (an
 * object-type body, a parameter list, a tuple). Clause order is preserved
 * (tuple-element and generic-argument order are significant); only union and
 * intersection members within a clause are reordered.
 */
function canon(s: string): string {
  const scan = scanTop(s);
  if (!scan.ok) return s;
  const seps = [
    ...scan.semis.map((i) => ({ i, c: ";" })),
    ...scan.commas.map((i) => ({ i, c: "," })),
  ].sort((a, b) => a.i - b.i);
  if (seps.length === 0) return canonClause(s);
  let out = "";
  let prev = 0;
  for (const { i, c } of seps) {
    out += canonClause(s.slice(prev, i)) + c;
    prev = i + 1;
  }
  out += canonClause(s.slice(prev));
  return out;
}

/**
 * Public entry point. Returns `text` unchanged when there is nothing to reorder
 * or when anything cannot be parsed confidently (fail-closed).
 */
export function canonicalizeType(text: string): string {
  if (!text.includes("|") && !text.includes("&")) return text;
  try {
    return canon(text);
  } catch {
    return text;
  }
}

/**
 * Split a bare type expression into its top-level union arms. Returns null when
 * the string cannot be confidently parsed as a flat union (malformed, or gated
 * by a depth-0 function type / conditional), so callers stay fail-closed. A
 * type with no top-level `|` returns a single-element array.
 */
export function splitTopLevelUnion(text: string): string[] | null {
  const r = text.trim();
  const scan = scanTop(r);
  if (!scan.ok || scan.gated) return null;
  if (scan.pipes.length === 0) return [r];
  return splitAt(r, scan.pipes)
    .map((m) => m.trim())
    .filter((m) => m.length > 0);
}

/**
 * Split a bare type expression into its top-level intersection members, with
 * the same fail-closed contract as `splitTopLevelUnion`. A top-level `|` means
 * the expression is a union, not an intersection, so it also returns null.
 */
export function splitTopLevelIntersection(text: string): string[] | null {
  const r = text.trim();
  const scan = scanTop(r);
  if (!scan.ok || scan.gated || scan.pipes.length > 0) return null;
  if (scan.amps.length === 0) return [r];
  return splitAt(r, scan.amps)
    .map((m) => m.trim())
    .filter((m) => m.length > 0);
}

/**
 * Split a depth-0 conditional type (`C extends E ? T : F`) into its true and
 * false branches. Conditionals are right-associative, so the matching `:` for
 * the first `?` is found by counting subsequent depth-0 `?`/`:` pairs (a nested
 * conditional in the true branch adds one of each). Returns null when the
 * expression is not confidently a depth-0 conditional.
 */
export function splitTopLevelConditional(
  text: string,
): { trueType: string; falseType: string } | null {
  const r = text.trim();
  const scan = scanTop(r);
  if (!scan.ok) return null;
  if (scan.extendsKw.length === 0 || scan.questions.length === 0) return null;
  const firstExtends = scan.extendsKw[0];
  const firstQ = scan.questions.find((q) => q > firstExtends);
  if (firstQ === undefined) return null;
  const events = [
    ...scan.questions.filter((i) => i > firstQ).map((i) => ({ i, open: true })),
    ...scan.colons.filter((i) => i > firstQ).map((i) => ({ i, open: false })),
  ].sort((a, b) => a.i - b.i);
  let depth = 1;
  for (const e of events) {
    depth += e.open ? 1 : -1;
    if (depth === 0) {
      const trueType = r.slice(firstQ + 1, e.i).trim();
      const falseType = r.slice(e.i + 1).trim();
      if (!trueType || !falseType) return null;
      return { trueType, falseType };
    }
  }
  return null;
}
