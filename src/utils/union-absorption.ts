/**
 * Deterministic detection that a type-alias change is suggestion-only: both the
 * baseline and current right-hand sides are unions carrying the same unchanged
 * "absorbing" arm (`string & {}` / `string & Record<never, never>`, or the
 * `number` equivalents), and every other arm is provably a subtype of that
 * primitive (or byte-identical and reference-free on both sides). The
 * absorbing arm is mutually assignable with the bare primitive, so it absorbs
 * every such arm: the assignable set is identical before and after, and no
 * well-typed consumer can be affected in either variance direction. The
 * literal / template-literal arms exist only to drive editor autocomplete (the
 * `Autocomplete` / `LiteralUnion` idiom from type-fest, ts-essentials,
 * `@clerk/shared`). Without this check the rule differ flags any alias text
 * change as breaking and the AI reviewer tends to *confirm* it, which
 * `--ai-apply-downgrades` cannot relax (issue #114).
 *
 * The changed alias's RHS is usually the UNEXPANDED application
 * (`Autocomplete<WithPathPatternWildcard>`), and the referenced aliases are
 * usually NOT exported, so they are absent from the `.api.json` doc model
 * (API Extractor only walks the exported surface). Their declarations DO
 * appear, verbatim, in the `.api.md` API report ("forgotten exports"), which
 * every snapshot stores alongside the doc model; that report is what this
 * file parses. Each side resolves against its own report, so a changed
 * `Autocomplete` definition diverges the expansions and fails the match.
 *
 * Everything here is fail-closed in the same spirit as `canonicalize-type.ts`:
 * any spelling, resolution, or substitution this file cannot confidently
 * reason about returns null and the change stays breaking. A bug can at worst
 * leave a phantom break, never hide a real one.
 */

import * as fs from "node:fs";
import {
  canonicalizeType,
  splitTopLevelConditional,
  splitTopLevelIntersection,
  splitTopLevelUnion,
} from "./canonicalize-type.js";

/* -------------------------------------------------------------- surface -- */

interface AliasDecl {
  name: string;
  /** Normalized RHS text (the alias body). */
  bodyText: string;
  /** Type parameters in declaration order; `defaultText` is null when absent. */
  typeParameters: Array<{ name: string; defaultText: string | null }>;
}

export interface AliasSurface {
  /** Module-scope (brace-depth-0) type aliases in the report, by name. */
  byName: Map<string, AliasDecl>;
}

/** Result of a successful equivalence proof, recorded on the change. */
export interface AbsorbingArmEquivalence {
  /** The primitive the absorbing arm is mutually assignable with. */
  primitive: "string" | "number";
  /** Canonical text of the unchanged absorbing arm. */
  arm: string;
  /** Canonical texts of the arms only the baseline union carried. */
  removed: string[];
  /** Canonical texts of the arms only the current union carries. */
  added: string[];
}

const MAX_RESOLVE_DEPTH = 4;

/**
 * Identifiers that may never be locally re-bound (as a type parameter, a
 * declaration, or an import) for the matching here to stay sound: the
 * primitives and keywords the subtype prover pattern-matches, plus `Record`,
 * which the absorbing-arm shape matches by name. The keywords cannot be
 * shadowed in TypeScript anyway; `Record` (and other identifier-shaped
 * entries) can, so a surface or parameter list that binds one is refused.
 */
const RESERVED_NAMES = new Set([
  "string",
  "number",
  "boolean",
  "bigint",
  "symbol",
  "object",
  "any",
  "unknown",
  "never",
  "undefined",
  "null",
  "void",
  "Record",
]);

/**
 * Identifier-shaped words a REFERENCE-FREE arm may consist of: keywords whose
 * meaning cannot be re-bound, so byte-identity across the two sides implies
 * type identity. Anything else (including any backtick, whose interpolations
 * this file's quote-blind scans cannot see into) disqualifies the arm.
 */
const REFERENCE_FREE_WORDS = new Set([
  "string",
  "number",
  "boolean",
  "bigint",
  "symbol",
  "object",
  "any",
  "unknown",
  "never",
  "undefined",
  "null",
  "void",
  "true",
  "false",
  "readonly",
]);

/**
 * Parse a snapshot's `.api.md` API report into a lookup of the module-scope
 * type aliases it declares (exported and forgotten alike). Returns null when
 * the file cannot be read, has no fenced code block, or re-binds a reserved
 * name (an import or local declaration of `Record` would make the absorbing-
 * arm shape ambiguous), so callers fail closed.
 */
export function loadAliasSurface(apiReportPath: string): AliasSurface | null {
  let raw: string;
  try {
    raw = fs.readFileSync(apiReportPath, "utf8");
  } catch {
    return null;
  }
  const fence = raw.match(/```ts\r?\n([\s\S]*?)```/);
  if (!fence) return null;
  const block = fence[1];

  const depths = depthAtEachIndex(block);
  if (!depths) return null;

  // An import that binds `Record` (or any reserved name) poisons the surface.
  const importRe = /(?:^|\n)\s*import\b[^;]*;/g;
  let im: RegExpExecArray | null;
  while ((im = importRe.exec(block)) !== null) {
    const idents = im[0].match(/[A-Za-z_$][\w$]*/g) ?? [];
    if (idents.some((w) => RESERVED_NAMES.has(w))) return null;
  }

  const byName = new Map<string, AliasDecl>();
  const declRe =
    /(?:^|\n)[ \t]*(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)/g;
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(block)) !== null) {
    const name = m[1];
    const afterName = m.index + m[0].length;
    // Only module-scope declarations; a `type` inside `declare namespace {}`
    // would otherwise collide with a same-named top-level alias.
    if (depths[m.index === 0 ? 0 : m.index + 1] !== 0) continue;
    if (RESERVED_NAMES.has(name)) return null;
    const decl = parseDeclTail(block, afterName, depths);
    if (!decl) return null;
    if (byName.has(name)) return null;
    byName.set(name, { name, ...decl });
  }
  return { byName };
}

/**
 * Bracket depth at each index of `text`, treating quoted/template regions as
 * part of the enclosing depth and consuming `=>` whole. Null when malformed.
 */
function depthAtEachIndex(text: string): Int32Array | null {
  const depths = new Int32Array(text.length);
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      const close = skipQuote(text, i);
      if (close < 0) return null;
      depths.fill(depth, i, close);
      i = close;
      continue;
    }
    if (c === "=" && text[i + 1] === ">") {
      depths[i] = depth;
      depths[i + 1] = depth;
      i += 2;
      continue;
    }
    if (c === "(" || c === "[" || c === "{" || c === "<") {
      depths[i] = depth;
      depth++;
      i++;
      continue;
    }
    if (c === ")" || c === "]" || c === "}" || c === ">") {
      depth--;
      if (depth < 0) return null;
      depths[i] = depth;
      i++;
      continue;
    }
    depths[i] = depth;
    i++;
  }
  return depth === 0 ? depths : null;
}

/**
 * Parse the tail of a `type Name` declaration: an optional `<params>` list,
 * `=`, and the RHS up to the depth-0 `;`.
 */
function parseDeclTail(
  block: string,
  afterName: number,
  depths: Int32Array,
): Omit<AliasDecl, "name"> | null {
  let i = afterName;
  while (i < block.length && /\s/.test(block[i])) i++;
  const typeParameters: AliasDecl["typeParameters"] = [];
  if (block[i] === "<") {
    let end = i + 1;
    while (
      end < block.length &&
      !(block[end] === ">" && depths[end] === depths[i])
    ) {
      end++;
    }
    if (end >= block.length) return null;
    const params = splitTopLevelArguments(block.slice(i + 1, end));
    if (!params) return null;
    for (const p of params) {
      const parsed = parseTypeParameter(p);
      if (!parsed) return null;
      typeParameters.push(parsed);
    }
    i = end + 1;
    while (i < block.length && /\s/.test(block[i])) i++;
  }
  if (block[i] !== "=") return null;
  i++;
  let semi = i;
  while (
    semi < block.length &&
    !(block[semi] === ";" && depths[semi] === depths[i - 1])
  ) {
    semi++;
  }
  if (semi >= block.length) return null;
  const bodyText = normalizeTypeText(block.slice(i, semi));
  return bodyText.length > 0 ? { bodyText, typeParameters } : null;
}

/** Parse one `Name`, `Name extends C`, or `Name extends C = D` segment. */
function parseTypeParameter(
  segment: string,
): { name: string; defaultText: string | null } | null {
  const s = segment.trim();
  const nameMatch = s.match(/^[A-Za-z_$][\w$]*/);
  if (!nameMatch) return null;
  const name = nameMatch[0];
  const eq = topLevelDefaultEquals(s);
  const defaultText =
    eq === -1 ? null : normalizeTypeText(s.slice(eq + 1)) || null;
  return { name, defaultText };
}

/** Index of the depth-0 `=` introducing a parameter default; -1 when absent. */
function topLevelDefaultEquals(s: string): number {
  let depth = 0;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'" || c === "`") {
      const close = skipQuote(s, i);
      if (close < 0) return -1;
      i = close;
      continue;
    }
    if (c === "=" && s[i + 1] === ">") {
      i += 2;
      continue;
    }
    if (c === "(" || c === "[" || c === "{" || c === "<") depth++;
    else if (c === ")" || c === "]" || c === "}" || c === ">") depth--;
    else if (c === "=" && depth === 0) return i;
    i++;
  }
  return -1;
}

/* ------------------------------------------------------------ rendering -- */

/** Advance past a quoted region; -1 when unterminated. */
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

/**
 * Apply `fn` to every unquoted span of `s`, leaving string/template literal
 * contents byte-for-byte intact. An unterminated quote appends the remainder
 * raw; downstream parsing then fails closed on the malformed text.
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

/** The unquoted text of `s`, for structural guards that must ignore literals. */
function unquotedText(s: string): string {
  let out = "";
  mapUnquoted(s, (span) => {
    out += span;
    return span;
  });
  return out;
}

/**
 * Collapse whitespace and strip spaces around punctuation, but never inside a
 * string or template literal (the differ's `normalizeType` is quote-blind; two
 * literals differing only in internal spacing must not conflate here, where a
 * conflation could hide a change instead of just missing one).
 */
function normalizeTypeText(text: string): string {
  return mapUnquoted(text, (span) =>
    span.replace(/\s+/g, " ").replace(/\s*([,;:()<>[\]{}|&])\s*/g, "$1"),
  ).trim();
}

/** Strip redundant outer parens (`(X)` -> `X`) as long as they span the whole text. */
function stripOuterParens(text: string): string {
  let t = text.trim();
  while (t.startsWith("(") && t.endsWith(")")) {
    // Only strip when the opening paren closes at the very end.
    const inner = t.slice(1, -1);
    let depth = 0;
    let balanced = true;
    let i = 0;
    while (i < inner.length) {
      const c = inner[i];
      if (c === '"' || c === "'" || c === "`") {
        const close = skipQuote(inner, i);
        if (close < 0) {
          balanced = false;
          break;
        }
        i = close;
        continue;
      }
      if (c === "(" || c === "[" || c === "{" || c === "<") depth++;
      else if (c === ")" || c === "]" || c === "}" || c === ">") {
        depth--;
        if (depth < 0) {
          balanced = false;
          break;
        }
      }
      i++;
    }
    if (!balanced || depth !== 0) return t;
    t = inner.trim();
  }
  return t;
}

/** Final canonical form used to compare arms across the two sides. */
function canonicalizeArmText(text: string): string {
  return canonicalizeType(stripOuterParens(normalizeTypeText(text)));
}

/* ------------------------------------------------------------ expansion -- */

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsWord(text: string, word: string): boolean {
  const re = new RegExp(`(?<![\\w$])${escapeRegExp(word)}(?![\\w$])`);
  return re.test(unquotedText(text));
}

function replaceWord(text: string, word: string, replacement: string): string {
  const re = new RegExp(`(?<![\\w$])${escapeRegExp(word)}(?![\\w$])`, "g");
  return mapUnquoted(text, (span) => span.replace(re, replacement));
}

/**
 * Parse `Head<Args>` (or a bare `Head`) where Head is a plain identifier.
 * Returns null unless the argument list is the balanced tail of the text.
 */
function parseApplication(
  text: string,
): { head: string; args: string[] } | null {
  const lt = indexOfUnquoted(text, "<");
  if (lt === -1) {
    return isIdentifier(text) ? { head: text, args: [] } : null;
  }
  if (!text.endsWith(">")) return null;
  const head = text.slice(0, lt);
  if (!isIdentifier(head)) return null;
  const inner = text.slice(lt + 1, -1);
  const args = splitTopLevelArguments(inner);
  if (!args || args.length === 0) return null;
  return { head, args };
}

function isIdentifier(text: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(text);
}

function indexOfUnquoted(s: string, ch: string): number {
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'" || c === "`") {
      const close = skipQuote(s, i);
      if (close < 0) return -1;
      i = close;
      continue;
    }
    if (c === ch) return i;
    i++;
  }
  return -1;
}

/** Split a generic argument/parameter list at depth-0 commas; null when malformed. */
function splitTopLevelArguments(inner: string): string[] | null {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < inner.length) {
    const c = inner[i];
    if (c === '"' || c === "'" || c === "`") {
      const close = skipQuote(inner, i);
      if (close < 0) return null;
      i = close;
      continue;
    }
    if (c === "=" && inner[i + 1] === ">") {
      i += 2;
      continue;
    }
    if (c === "<" || c === "(" || c === "[" || c === "{") depth++;
    else if (c === ">" || c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth < 0) return null;
    } else if (c === "," && depth === 0) {
      parts.push(inner.slice(start, i).trim());
      start = i + 1;
    }
    i++;
  }
  if (depth !== 0) return null;
  parts.push(inner.slice(start).trim());
  return parts.every((p) => p.length > 0) ? parts : null;
}

/**
 * Expand a single alias application into the top-level union arms of its body,
 * substituting type arguments (and declared defaults) for the parameters.
 * Substitution is deliberately narrow, since a wrong splice could conflate two
 * different types and clear a real break:
 *
 * - An arm that IS a bare parameter takes the argument text wholesale, so the
 *   argument's own precedence survives intact.
 * - Any other arm is spliced only when it has no unquoted `:`, `=>`, or brace
 *   beyond the literal `{}` (a colon/brace/arrow means the parameter name
 *   could occur as a property, tuple-label, or function-argument NAME, which
 *   substitution must never rewrite), and only with argument text that has no
 *   depth-0 `|`/`&` (which would change precedence when spliced).
 * - Parameter names may not collide with each other or with the identifiers
 *   the prover / absorbing-arm matcher pattern-match (`RESERVED_NAMES`).
 *
 * Anything outside those bounds returns null (fail-closed).
 */
function expandApplication(
  armText: string,
  surface: AliasSurface,
): string[] | null {
  const app = parseApplication(armText);
  if (!app) return null;
  const node = surface.byName.get(app.head);
  if (!node) return null;
  const params = node.typeParameters;
  if (app.args.length > params.length) return null;
  const seen = new Set<string>();
  for (const p of params) {
    if (RESERVED_NAMES.has(p.name) || seen.has(p.name)) return null;
    seen.add(p.name);
  }
  const bindings: Array<{ name: string; text: string }> = [];
  for (let i = 0; i < params.length; i++) {
    const text = app.args[i] ?? params[i].defaultText;
    if (text === null || text === undefined) return null;
    bindings.push({ name: params[i].name, text });
  }
  const bodyArms = splitTopLevelUnion(stripOuterParens(node.bodyText));
  if (!bodyArms || bodyArms.length < 2) return null;
  const out: string[] = [];
  for (const bodyArm of bodyArms) {
    const substituted = substituteParams(bodyArm, bindings);
    if (substituted === null) return null;
    out.push(substituted);
  }
  return out;
}

function substituteParams(
  armText: string,
  bindings: Array<{ name: string; text: string }>,
): string | null {
  const stripped = stripOuterParens(armText);
  for (const b of bindings) {
    if (stripped === b.name) return b.text;
  }
  const present = bindings.filter((b) => containsWord(stripped, b.name));
  if (present.length === 0) return stripped;
  // Structural guard: see `expandApplication`.
  const structure = unquotedText(stripped).replace(/\{\}/g, "");
  if (
    structure.includes(":") ||
    structure.includes("=>") ||
    structure.includes("{")
  ) {
    return null;
  }
  let out = stripped;
  for (const b of present) {
    const bindingUnion = splitTopLevelUnion(b.text);
    const bindingInter = splitTopLevelIntersection(b.text);
    // A binding with depth-0 `|`/`&` may only replace a bare-parameter arm.
    if (
      !bindingUnion ||
      bindingUnion.length > 1 ||
      !bindingInter ||
      bindingInter.length > 1
    ) {
      return null;
    }
    out = replaceWord(out, b.name, b.text);
  }
  return out;
}

/* ----------------------------------------------------------- absorption -- */

/**
 * Recognize the absorbing-arm shape: exactly a two-member intersection of a
 * primitive and an empty-shape brand (`{}` or the global `Record<never,
 * never>`; a surface that re-binds `Record` was already refused). Returns the
 * absorbed primitive, or null.
 */
function absorbingArmPrimitive(armText: string): "string" | "number" | null {
  const members = splitTopLevelIntersection(stripOuterParens(armText));
  if (!members || members.length !== 2) return null;
  const brands = new Set(["{}", "Record<never,never>"]);
  for (const prim of ["string", "number"] as const) {
    const other = members.find((m) => m !== prim);
    if (members.includes(prim) && other !== undefined && brands.has(other)) {
      return prim;
    }
  }
  return null;
}

function isQuotedLiteral(text: string, allowTemplate: boolean): boolean {
  const q = text[0];
  if (q !== '"' && q !== "'" && q !== "`") return false;
  if (q === "`" && !allowTemplate) return false;
  return skipQuote(text, 0) === text.length;
}

function isNumericLiteral(text: string): boolean {
  return (
    /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text) ||
    /^-?0[xX][0-9a-fA-F]+$/.test(text) ||
    /^-?0[bB][01]+$/.test(text) ||
    /^-?0[oO][0-7]+$/.test(text)
  );
}

/**
 * True when the arm consists solely of keywords whose meaning cannot be
 * re-bound, so byte-identity across the two sides implies type identity. Any
 * backtick disqualifies: a template literal's interpolations are invisible to
 * this file's quote-blind scans, so they could smuggle a reference.
 */
function isReferenceFree(armText: string): boolean {
  if (armText.includes("`")) return false;
  const words = unquotedText(armText).match(/[A-Za-z_$][\w$]*/g) ?? [];
  return words.every((w) => REFERENCE_FREE_WORDS.has(w));
}

/**
 * Structurally prove `text` is a subtype of the primitive. Every rule here is
 * parametric (it never depends on what a type parameter is bound to), so
 * recursing into an UNSUBSTITUTED alias body is sound: a bare parameter simply
 * fails the proof. Unprovable is not "not a subtype"; it just stays breaking.
 */
function provesSubtypeOf(
  text: string,
  prim: "string" | "number",
  surface: AliasSurface,
  depth: number,
  visited: Set<string>,
): boolean {
  if (depth > MAX_RESOLVE_DEPTH) return false;
  const t = stripOuterParens(text);
  if (t.length === 0) return false;
  if (t === prim || t === "never") return true;
  if (prim === "string" && isQuotedLiteral(t, true)) return true;
  if (prim === "number" && isNumericLiteral(t)) return true;

  // A conditional's value is always an instantiation of one of its branches,
  // so proving both branches proves the whole (distributivity included).
  const cond = splitTopLevelConditional(t);
  if (cond) {
    return (
      provesSubtypeOf(cond.trueType, prim, surface, depth + 1, visited) &&
      provesSubtypeOf(cond.falseType, prim, surface, depth + 1, visited)
    );
  }

  const unionArms = splitTopLevelUnion(t);
  if (unionArms && unionArms.length > 1) {
    return unionArms.every((a) =>
      provesSubtypeOf(a, prim, surface, depth + 1, visited),
    );
  }

  const interMembers = splitTopLevelIntersection(t);
  if (interMembers && interMembers.length > 1) {
    return interMembers.some((m) =>
      provesSubtypeOf(m, prim, surface, depth + 1, visited),
    );
  }

  // A (possibly generic) reference to another alias in the same report.
  const app = parseApplication(t);
  if (app) {
    const node = surface.byName.get(app.head);
    if (!node) return false;
    if (visited.has(node.name)) return false;
    visited.add(node.name);
    return provesSubtypeOf(node.bodyText, prim, surface, depth + 1, visited);
  }
  return false;
}

/* --------------------------------------------------------------- entry -- */

function multisetCounts(items: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  return counts;
}

/**
 * The top-level union arms of an alias's RHS in canonical text form: the RHS's
 * own arms when it is a union, or the substituted arms of its body when it is
 * a single same-report alias application. Null when neither reading holds, or
 * when the alias declares a type parameter that shadows a reserved name (a
 * parameter named `Record` would make the absorbing-arm shape ambiguous).
 */
function aliasUnionArms(
  node: AliasDecl,
  surface: AliasSurface,
): string[] | null {
  if (node.typeParameters.some((p) => RESERVED_NAMES.has(p.name))) return null;
  let arms = splitTopLevelUnion(stripOuterParens(node.bodyText));
  if (!arms) return null;
  if (arms.length === 1) {
    arms = expandApplication(stripOuterParens(arms[0]), surface);
    if (!arms) return null;
  }
  return arms.map(canonicalizeArmText);
}

/**
 * Decide whether the change to type alias `aliasName` is suggestion-only:
 * both sides are unions with an identical absorbing arm, every changed arm is
 * a proven subtype of the absorbed primitive on its own side, and every
 * unchanged arm is the absorber, proven on both sides, or reference-free
 * (byte-identity of an arm that references a local or imported name proves
 * nothing, since the name could re-bind between versions). Each side resolves
 * against its own report, so the check is symmetric by construction. Returns
 * the evidence to record on the change, or null (fail-closed).
 */
export function findAbsorbingArmEquivalence(
  aliasName: string,
  baselineSurface: AliasSurface,
  currentSurface: AliasSurface,
): AbsorbingArmEquivalence | null {
  const before = baselineSurface.byName.get(aliasName);
  const after = currentSurface.byName.get(aliasName);
  if (!before || !after) return null;
  const beforeArms = aliasUnionArms(before, baselineSurface);
  const afterArms = aliasUnionArms(after, currentSurface);
  if (!beforeArms || !afterArms) return null;

  const beforeCounts = multisetCounts(beforeArms);
  const afterCounts = multisetCounts(afterArms);
  const removed: string[] = [];
  const added: string[] = [];
  const unchanged: string[] = [];
  for (const [arm, count] of beforeCounts) {
    const other = afterCounts.get(arm) ?? 0;
    for (let i = 0; i < count - other; i++) removed.push(arm);
    if (other > 0) unchanged.push(arm);
  }
  for (const [arm, count] of afterCounts) {
    const other = beforeCounts.get(arm) ?? 0;
    for (let i = 0; i < count - other; i++) added.push(arm);
  }
  if (removed.length === 0 && added.length === 0) return null;

  const absorbers = unchanged
    .map((arm) => ({ arm, prim: absorbingArmPrimitive(arm) }))
    .filter((a): a is { arm: string; prim: "string" | "number" } =>
      Boolean(a.prim),
    );
  if (absorbers.length === 0) return null;

  const proves = (arm: string, prim: "string" | "number", side: AliasSurface) =>
    provesSubtypeOf(arm, prim, side, 0, new Set());

  const matched = absorbers.find(
    ({ arm: absorber, prim }) =>
      removed.every((arm) => proves(arm, prim, baselineSurface)) &&
      added.every((arm) => proves(arm, prim, currentSurface)) &&
      unchanged.every(
        (arm) =>
          arm === absorber ||
          isReferenceFree(arm) ||
          (proves(arm, prim, baselineSurface) &&
            proves(arm, prim, currentSurface)),
      ),
  );
  if (!matched) return null;
  return { primitive: matched.prim, arm: matched.arm, removed, added };
}
