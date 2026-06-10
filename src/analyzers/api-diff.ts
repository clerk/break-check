/**
 * API Diff Analyzer - Compares two API snapshots to detect changes
 */

import * as fs from "node:fs";
import * as crypto from "node:crypto";
import {
  ApiChange,
  ChangeType,
  ChangeSeverity,
  ChangeCategory,
} from "../types.js";
import { canonicalizeType } from "../utils/canonicalize-type.js";

interface ExcerptToken {
  kind: string;
  text: string;
  canonicalReference?: string;
}

interface TokenRange {
  startIndex: number;
  endIndex: number;
}

interface ApiJsonParameter {
  parameterName: string;
  parameterTypeTokenRange: TokenRange;
  isOptional?: boolean;
  isRest?: boolean;
}

interface ApiJsonMember {
  kind: string;
  name: string;
  excerptTokens?: ExcerptToken[];
  members?: ApiJsonMember[];
  parameters?: ApiJsonParameter[];
  returnTypeTokenRange?: TokenRange;
  /** Type range as serialized by TypeAlias. */
  typeTokenRange?: TokenRange;
  /** Type range as serialized by Property / PropertySignature. */
  propertyTypeTokenRange?: TokenRange;
  /** Type range as serialized by Variable. */
  variableTypeTokenRange?: TokenRange;
  initializerTokenRange?: TokenRange;
  /** 1-based declaration-order index distinguishing overload signatures. */
  overloadIndex?: number;
  isOptional?: boolean;
  isReadonly?: boolean;
  isStatic?: boolean;
  isProtected?: boolean;
  isAbstract?: boolean;
}

interface ApiJsonFile {
  metadata: { toolPackage: string; toolVersion: string };
  kind: string;
  name: string;
  members: ApiJsonMember[];
}

interface ParsedParam {
  name: string;
  type: string;
  isOptional: boolean;
  isRest: boolean;
}

type ParsedShape =
  | { kind: "callable"; params: ParsedParam[]; returnType: string }
  | { kind: "typed"; type: string; isReadonly: boolean }
  | { kind: "enumMember"; initializer: string }
  | { kind: "container" }
  | { kind: "opaque"; signature: string };

type CallableShape = Extract<ParsedShape, { kind: "callable" }>;
type TypedShape = Extract<ParsedShape, { kind: "typed" }>;

/** Classification plus human-readable detail for one compared aspect of an item. */
interface ShapeVerdict {
  type: ChangeType;
  detail?: string;
}

interface ParsedApiItem {
  key: string;
  category: ChangeCategory;
  originalKind: string;
  name: string;
  parentName?: string;
  shape: ParsedShape;
  /** Raw snippet for diff display */
  snippet: string;
  isOptional: boolean;
  isStatic: boolean;
  isProtected: boolean;
  isAbstract: boolean;
}

const CALLABLE_KINDS = new Set([
  "Function",
  "Method",
  "MethodSignature",
  "Constructor",
  "ConstructSignature",
  "CallSignature",
]);

const TYPED_KINDS = new Set([
  "Property",
  "PropertySignature",
  "Variable",
  "IndexSignature",
]);

const CONTAINER_KINDS = new Set([
  "Interface",
  "Class",
  "Enum",
  "TypeAlias",
  "Namespace",
]);

/**
 * Analyzer for comparing API snapshots
 */
export class ApiDiffAnalyzer {
  /**
   * Compare a baseline snapshot against a current snapshot. Pass `null` for
   * the baseline to diff a brand-new surface against an empty one (every
   * current item becomes an addition).
   */
  analyze(baselinePath: string | null, currentPath: string): ApiChange[] {
    const baselineItems =
      baselinePath === null
        ? new Map<string, ParsedApiItem>()
        : this.parseApiJson(baselinePath);
    const currentItems = this.parseApiJson(currentPath);

    const changes: ApiChange[] = [];

    for (const [key, baselineItem] of baselineItems) {
      const currentItem = currentItems.get(key);

      if (!currentItem) {
        changes.push(this.createRemovalChange(baselineItem));
        continue;
      }

      const modification = this.compareItems(baselineItem, currentItem);
      if (modification) {
        changes.push(modification);
      }
    }

    for (const [key, currentItem] of currentItems) {
      if (!baselineItems.has(key)) {
        changes.push(this.createAdditionChange(currentItem));
      }
    }

    return changes;
  }

  private parseApiJson(filePath: string): Map<string, ParsedApiItem> {
    const content = fs.readFileSync(filePath, "utf-8");
    let raw: unknown;
    try {
      raw = JSON.parse(content);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to parse API JSON at ${filePath}: ${message}`);
    }

    const apiJson = raw as Partial<ApiJsonFile> | null;
    const toolPackage = apiJson?.metadata?.toolPackage;
    const toolVersion = apiJson?.metadata?.toolVersion ?? "unknown";

    if (toolPackage !== "@microsoft/api-extractor") {
      throw new Error(
        `Unrecognized API JSON at ${filePath}: expected metadata.toolPackage ` +
          `"@microsoft/api-extractor", got ${JSON.stringify(toolPackage)}. ` +
          `The file may be corrupt or produced by an incompatible tool.`,
      );
    }
    if (!Array.isArray(apiJson?.members)) {
      throw new Error(
        `Unrecognized API JSON at ${filePath} (toolVersion ${toolVersion}): ` +
          `\`members\` array is missing. The schema may have changed across ` +
          `an API Extractor upgrade; regenerate the snapshot.`,
      );
    }

    const items = new Map<string, ParsedApiItem>();
    const members = (apiJson as ApiJsonFile).members;

    for (const member of members) {
      if (member.kind === "EntryPoint" && member.members) {
        for (const exportedMember of member.members) {
          this.processApiMember(exportedMember, items);
        }
      } else {
        this.processApiMember(member, items);
      }
    }

    return items;
  }

  private processApiMember(
    member: ApiJsonMember,
    items: Map<string, ParsedApiItem>,
    parentName?: string,
    parentChain?: string,
  ): void {
    const category = this.mapCategory(member.kind);
    // The map key uses the FULL parent chain (`A.Inner`), not just the immediate
    // parent, so two distinct nested members that share an immediate parent and
    // leaf name (`A.Inner.value` and `B.Inner.value`) don't collide and silently
    // overwrite each other. The stored `parentName` stays the immediate parent so
    // the human-facing display name (and the AI walkSurface alias) are unchanged.
    const key = this.buildKey(
      member.kind,
      member.name,
      parentChain,
      member.overloadIndex,
    );
    const shape = this.parseShape(member);
    const snippet = this.tokensToText(member.excerptTokens);

    items.set(key, {
      key,
      category,
      originalKind: member.kind,
      name: member.name,
      parentName,
      shape,
      snippet,
      isOptional: Boolean(member.isOptional),
      isStatic: Boolean(member.isStatic),
      isProtected: Boolean(member.isProtected),
      isAbstract: Boolean(member.isAbstract),
    });

    if (member.members && member.members.length > 0) {
      const childChain = parentChain
        ? `${parentChain}.${member.name}`
        : member.name;
      for (const nested of member.members) {
        this.processApiMember(nested, items, member.name, childChain);
      }
    }
  }

  private parseShape(member: ApiJsonMember): ParsedShape {
    if (CALLABLE_KINDS.has(member.kind)) {
      return {
        kind: "callable",
        params: (member.parameters ?? []).map((p) => ({
          name: p.parameterName,
          type: this.canonicalType(
            member.excerptTokens,
            p.parameterTypeTokenRange,
          ),
          isOptional: Boolean(p.isOptional),
          isRest: this.parameterIsRest(member.excerptTokens, p),
        })),
        returnType: member.returnTypeTokenRange
          ? this.canonicalType(
              member.excerptTokens,
              member.returnTypeTokenRange,
            )
          : "",
      };
    }

    if (TYPED_KINDS.has(member.kind)) {
      // Property/PropertySignature serialize their type as
      // propertyTypeTokenRange and Variable as variableTypeTokenRange; the
      // generic typeTokenRange exists only on TypeAlias. Without the
      // kind-specific ranges this falls back to the full declaration text,
      // which embeds the name and the `?` optionality marker, so an
      // optionality flip would double-report as a type change. IndexSignature
      // has no single type range; its full text (key and value types) is the
      // right comparison unit, and it carries no optionality marker.
      const range =
        member.propertyTypeTokenRange ??
        member.variableTypeTokenRange ??
        member.typeTokenRange;
      return {
        kind: "typed",
        type: range
          ? this.canonicalType(member.excerptTokens, range)
          : this.canonicalType(member.excerptTokens),
        isReadonly: Boolean(member.isReadonly),
      };
    }

    if (member.kind === "EnumMember") {
      return {
        kind: "enumMember",
        initializer: member.initializerTokenRange
          ? this.canonicalType(
              member.excerptTokens,
              member.initializerTokenRange,
            )
          : "",
      };
    }

    if (member.kind === "TypeAlias") {
      return {
        kind: "typed",
        type: member.typeTokenRange
          ? this.canonicalType(member.excerptTokens, member.typeTokenRange)
          : this.canonicalType(member.excerptTokens),
        isReadonly: false,
      };
    }

    if (CONTAINER_KINDS.has(member.kind)) {
      return { kind: "container" };
    }

    return {
      kind: "opaque",
      signature: this.canonicalType(member.excerptTokens),
    };
  }

  /**
   * Whether a parameter is a rest parameter (`...args`).
   *
   * API Extractor's `.api.json` (at the pinned version) does not emit an
   * `isRest` flag on parameters, only `parameterName`/`isOptional`. Without
   * recovering it, a rest-ness flip (`x: T[]` ↔ `...x: T[]`) is invisible to the
   * callable diff, and adding a `...rest` param is misreported as a new required
   * parameter. Recover it from the excerpt: the `...` lives in the Content token
   * immediately before the parameter's type range, e.g. `"(...items: "` or
   * `", ...rest: "`. Honor a real `isRest` flag first in case a future API
   * Extractor starts emitting one.
   */
  private parameterIsRest(
    excerptTokens: ExcerptToken[] | undefined,
    p: ApiJsonParameter,
  ): boolean {
    if (p.isRest) return true;
    const start = p.parameterTypeTokenRange?.startIndex;
    if (!excerptTokens || typeof start !== "number" || start <= 0) {
      return false;
    }
    const preceding = excerptTokens[start - 1]?.text;
    if (!preceding) return false;
    const name = p.parameterName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // `...name` optionally followed by `?`, then the `:` that introduces the
    // type, anchored to the end of the token that precedes the type range.
    return new RegExp(`\\.\\.\\.\\s*${name}\\s*\\??\\s*:\\s*$`).test(preceding);
  }

  /**
   * Compare two items and produce a change if they differ meaningfully.
   * Returns null when the difference is cosmetic (whitespace, param renames).
   */
  private compareItems(
    baseline: ParsedApiItem,
    current: ParsedApiItem,
  ): ApiChange | null {
    // Member-level flag flips (optionality, static, protected, abstract) are
    // folded into the overall verdict rather than short-circuiting: the same
    // edit can also change the member's shape (`a: string` -> `a?: number`),
    // and an early return on the relaxing required -> optional flip would read
    // non-breaking while hiding the breaking type change. The modifier flags
    // are compared here, not in the shape compare, so they are caught on
    // callables too (the signature compare never sees the excerpt text).
    const verdicts: ShapeVerdict[] = [];
    if (baseline.isOptional !== current.isOptional) {
      verdicts.push(
        baseline.isOptional
          ? {
              type: ChangeType.BREAKING,
              detail: "Member is no longer optional",
            }
          : {
              type: ChangeType.NON_BREAKING,
              detail: "Member became optional",
            },
      );
    }
    // Any modifier flip can break a consumer (a static member moves off
    // instances; a public member going protected disappears for callers;
    // protected -> public breaks subclasses that re-declare it protected; an
    // abstract member forces subclasses to implement it), so all directions
    // are pessimistically breaking. The AI reviewer may downgrade the safe
    // ones.
    if (baseline.isStatic !== current.isStatic) {
      verdicts.push({
        type: ChangeType.BREAKING,
        detail: current.isStatic
          ? "Member became static"
          : "Member is no longer static",
      });
    }
    if (baseline.isProtected !== current.isProtected) {
      verdicts.push({
        type: ChangeType.BREAKING,
        detail: current.isProtected
          ? "Member became protected"
          : "Member became public",
      });
    }
    if (baseline.isAbstract !== current.isAbstract) {
      verdicts.push({
        type: ChangeType.BREAKING,
        detail: current.isAbstract
          ? "Member became abstract"
          : "Member is no longer abstract",
      });
    }

    const shape = this.compareShapes(baseline, current);
    if (shape) {
      verdicts.push(shape);
    }
    if (verdicts.length === 0) {
      return null;
    }

    const type = verdicts.some((v) => v.type === ChangeType.BREAKING)
      ? ChangeType.BREAKING
      : ChangeType.NON_BREAKING;
    const detail =
      verdicts
        .map((v) => v.detail)
        .filter(Boolean)
        .join("; ") || undefined;
    return this.buildModification(baseline, current, type, detail);
  }

  /**
   * Compare the two items' shapes. Returns null when they match; otherwise a
   * classification with a human-readable detail.
   */
  private compareShapes(
    baseline: ParsedApiItem,
    current: ParsedApiItem,
  ): ShapeVerdict | null {
    // Container bodies are diffed via their members; skip the container itself.
    if (
      baseline.shape.kind === "container" &&
      current.shape.kind === "container"
    ) {
      return null;
    }

    if (
      baseline.shape.kind === "callable" &&
      current.shape.kind === "callable"
    ) {
      return this.compareCallable(baseline.shape, current.shape);
    }

    if (baseline.shape.kind === "typed" && current.shape.kind === "typed") {
      return this.compareTyped(baseline.shape, current.shape);
    }

    if (
      baseline.shape.kind === "enumMember" &&
      current.shape.kind === "enumMember"
    ) {
      if (baseline.shape.initializer === current.shape.initializer) {
        return null;
      }
      return {
        type: ChangeType.BREAKING,
        detail: `Enum member value changed: \`${baseline.shape.initializer || "(implicit)"}\` → \`${current.shape.initializer || "(implicit)"}\``,
      };
    }

    // Kind mismatch (e.g., became a different shape); treat as breaking.
    if (baseline.shape.kind !== current.shape.kind) {
      return {
        type: ChangeType.BREAKING,
        detail: `Declaration kind changed from \`${baseline.originalKind}\` to \`${current.originalKind}\``,
      };
    }

    // Opaque fallback: canonical signature compare. The opaque shape already
    // carries an import-reference-canonicalized signature; fall back to the
    // raw snippet for any shape that does not.
    const a =
      baseline.shape.kind === "opaque"
        ? baseline.shape.signature
        : this.normalizeType(baseline.snippet);
    const b =
      current.shape.kind === "opaque"
        ? current.shape.signature
        : this.normalizeType(current.snippet);
    if (a === b) {
      return null;
    }
    return { type: ChangeType.BREAKING };
  }

  private compareCallable(
    before: CallableShape,
    after: CallableShape,
  ): ShapeVerdict | null {
    const notes: string[] = [];
    let severity: ChangeType | null = null;

    const upgrade = (next: ChangeType, note: string): void => {
      notes.push(note);
      if (severity === ChangeType.BREAKING) return;
      if (next === ChangeType.BREAKING) {
        severity = ChangeType.BREAKING;
      } else if (severity === null) {
        severity = next;
      }
    };

    // Return type
    if (before.returnType !== after.returnType) {
      upgrade(
        ChangeType.BREAKING,
        `Return type changed: \`${before.returnType || "void"}\` → \`${after.returnType || "void"}\``,
      );
    }

    // Parameter alignment by position
    const maxLen = Math.max(before.params.length, after.params.length);
    for (let i = 0; i < maxLen; i++) {
      const a = before.params[i];
      const b = after.params[i];

      if (a && !b) {
        upgrade(ChangeType.BREAKING, `Parameter \`${a.name}\` was removed`);
        continue;
      }

      if (!a && b) {
        if (b.isOptional || b.isRest) {
          upgrade(
            ChangeType.NON_BREAKING,
            `Optional parameter \`${b.name}\` was added`,
          );
        } else {
          upgrade(
            ChangeType.BREAKING,
            `Required parameter \`${b.name}\` was added`,
          );
        }
        continue;
      }

      if (!a || !b) continue;

      if (a.isOptional && !b.isOptional) {
        upgrade(
          ChangeType.BREAKING,
          `Parameter \`${a.name}\` is no longer optional`,
        );
      } else if (!a.isOptional && b.isOptional) {
        upgrade(
          ChangeType.NON_BREAKING,
          `Parameter \`${a.name}\` became optional`,
        );
      }

      if (a.isRest !== b.isRest) {
        upgrade(
          ChangeType.BREAKING,
          `Parameter \`${a.name}\` rest-ness changed`,
        );
      }

      if (a.type !== b.type) {
        upgrade(
          ChangeType.BREAKING,
          `Parameter \`${a.name}\` type changed: \`${a.type}\` → \`${b.type}\``,
        );
      }

      // Parameter rename only (no type/optionality change) is NOT breaking;
      // TypeScript callers use positional args. We skip the note entirely.
    }

    if (severity === null) {
      return null;
    }

    return { type: severity, detail: notes.join("; ") };
  }

  private compareTyped(
    before: TypedShape,
    after: TypedShape,
  ): ShapeVerdict | null {
    if (before.type === after.type && before.isReadonly === after.isReadonly) {
      return null;
    }

    const notes: string[] = [];
    if (before.type !== after.type) {
      notes.push(
        `Type changed: \`${summarizeType(before.type)}\` → \`${summarizeType(after.type)}\``,
      );
    }
    if (before.isReadonly !== after.isReadonly) {
      notes.push(
        before.isReadonly
          ? "Field is no longer readonly"
          : "Field became readonly",
      );
    }

    return { type: ChangeType.BREAKING, detail: notes.join("; ") };
  }

  private buildModification(
    baseline: ParsedApiItem,
    current: ParsedApiItem,
    type: ChangeType,
    detail: string | undefined,
  ): ApiChange {
    const fullName = baseline.parentName
      ? `${baseline.parentName}.${baseline.name}`
      : baseline.name;
    const kindName = this.kindDisplayName(baseline.originalKind);
    const verb = this.verbFor(type);
    const description = detail
      ? `${verb} ${kindName} \`${fullName}\`: ${detail}`
      : `${verb} ${kindName} \`${fullName}\``;

    const change: Omit<ApiChange, "id"> = {
      type,
      severity:
        type === ChangeType.BREAKING
          ? ChangeSeverity.MAJOR
          : ChangeSeverity.MINOR,
      category: baseline.category,
      name: fullName,
      description,
      beforeSnippet: baseline.snippet,
      afterSnippet: current.snippet,
    };

    return { ...change, id: this.generateChangeId(change) };
  }

  private createRemovalChange(item: ParsedApiItem): ApiChange {
    const fullName = item.parentName
      ? `${item.parentName}.${item.name}`
      : item.name;
    const change: Omit<ApiChange, "id"> = {
      type: ChangeType.BREAKING,
      severity: ChangeSeverity.MAJOR,
      category: item.category,
      name: fullName,
      description: `Removed ${this.kindDisplayName(item.originalKind)} \`${fullName}\``,
      beforeSnippet: item.snippet,
      afterSnippet: undefined,
    };
    return { ...change, id: this.generateChangeId(change) };
  }

  private createAdditionChange(item: ParsedApiItem): ApiChange {
    const fullName = item.parentName
      ? `${item.parentName}.${item.name}`
      : item.name;
    const change: Omit<ApiChange, "id"> = {
      type: ChangeType.ADDITION,
      severity: ChangeSeverity.MINOR,
      category: item.category,
      name: fullName,
      description: `Added ${this.kindDisplayName(item.originalKind)} \`${fullName}\``,
      beforeSnippet: undefined,
      afterSnippet: item.snippet,
    };
    return { ...change, id: this.generateChangeId(change) };
  }

  private buildKey(
    kind: string,
    name: string,
    parentChain?: string,
    overloadIndex?: number,
  ): string {
    const k = this.mapCategory(kind);
    // API Extractor emits one member per overload signature, all sharing a
    // name and disambiguated only by `overloadIndex` (also distinguishing
    // multiple call/construct/index signatures on one container). Without it
    // in the key, every overload after the first overwrites its predecessor in
    // the item map, so removing or editing a non-last overload is a silent
    // false negative. Overloads are matched positionally; the suffix is
    // computed identically on both sides of the diff, so committed baselines
    // need no regeneration.
    const overload =
      typeof overloadIndex === "number" ? `#${overloadIndex}` : "";
    return parentChain
      ? `${k}:${parentChain}:${name}${overload}`
      : `${k}:${name}${overload}`;
  }

  private mapCategory(kind: string): ChangeCategory {
    switch (kind) {
      case "Function":
        return "function";
      case "Interface":
        return "interface";
      case "TypeAlias":
        return "type";
      case "Class":
        return "class";
      case "Enum":
      case "EnumMember":
        return "enum";
      case "Variable":
        return "variable";
      case "Property":
      case "PropertySignature":
      case "IndexSignature":
        return "interface";
      case "Method":
      case "MethodSignature":
      case "Constructor":
      case "ConstructSignature":
      case "CallSignature":
        return "function";
      default:
        return "export";
    }
  }

  private kindDisplayName(kind: string): string {
    const map: Record<string, string> = {
      Function: "function",
      Interface: "interface",
      TypeAlias: "type alias",
      Class: "class",
      Enum: "enum",
      Variable: "variable",
      Property: "property",
      PropertySignature: "property",
      MethodSignature: "method",
      Method: "method",
      EnumMember: "enum member",
      Constructor: "constructor",
      ConstructSignature: "construct signature",
      CallSignature: "call signature",
      IndexSignature: "index signature",
      Namespace: "namespace",
    };
    return map[kind] ?? kind.toLowerCase();
  }

  private verbFor(type: ChangeType): string {
    switch (type) {
      case ChangeType.BREAKING:
        return "Breaking change in";
      case ChangeType.NON_BREAKING:
        return "Modified";
      case ChangeType.ADDITION:
        return "Added";
    }
  }

  private tokensToText(tokens?: ExcerptToken[]): string {
    if (!tokens || tokens.length === 0) return "";
    return tokens.map((t) => t.text).join("");
  }

  /**
   * Build a comparison string for a type excerpt, canonicalizing import
   * references so equivalent notations compare equal. API Extractor resolves a
   * namespace-import alias (`_ns.Foo`) and an inline import type
   * (`import("pkg").Foo`) to the same canonical reference; both spellings show
   * up depending on how the package built its `.d.ts`. Without this, a package
   * that switches its declaration-build strategy surfaces every imported type
   * as a spurious breaking change (see issue #44). We rewrite each resolved
   * reference token to a single `import("pkg").Name` spelling and drop API
   * Extractor's redundant `import("pkg").` content prefix that precedes it.
   */
  private canonicalType(
    tokens: ExcerptToken[] | undefined,
    range?: TokenRange,
  ): string {
    if (!tokens) return "";
    const slice = range
      ? tokens.slice(range.startIndex, range.endIndex)
      : tokens;
    const text = slice
      .map((t) =>
        t.kind === "Reference" && t.canonicalReference
          ? this.canonicalizeReference(t.canonicalReference)
          : t.text,
      )
      .join("");
    return this.normalizeType(this.collapseImportQualifiers(text));
  }

  /**
   * Convert an API Extractor canonical reference (`pkg!Symbol:meaning`) into a
   * stable `import("pkg").Symbol` spelling. The trailing `:meaning` is dropped;
   * package + symbol is the identity that distinguishes one reference from
   * another. Returns the raw reference unchanged when it is not in the expected
   * shape (e.g. a reference with no package component).
   */
  private canonicalizeReference(ref: string): string {
    const bang = ref.indexOf("!");
    if (bang === -1) return ref;
    const pkg = ref.slice(0, bang);
    let symbol = ref.slice(bang + 1);
    const colon = symbol.lastIndexOf(":");
    if (colon !== -1) symbol = symbol.slice(0, colon);
    if (!pkg || !symbol) return ref;
    return `import("${pkg}").${symbol}`;
  }

  /**
   * After a reference token is rewritten to `import("pkg").Name`, API
   * Extractor's own `import("pkg").` content prefix (emitted for the inline
   * spelling) is left dangling in front of it. Drop a leading import qualifier
   * that immediately precedes another one so the inline spelling collapses to
   * the same string as the namespace-alias spelling, which carries no prefix.
   */
  private collapseImportQualifiers(text: string): string {
    return text.replace(/import\((["'])[^"']*\1\)\.(?=import\(["'])/g, "");
  }

  /**
   * Collapse whitespace and strip trailing punctuation so cosmetic
   * differences don't show up as breaking changes, then canonicalize the order
   * of union/intersection members so a pure reorder (unstable TS emit order,
   * issue #85) is not a change. Runs on both baseline and current reads, so the
   * normalization is symmetric.
   */
  private normalizeType(text: string): string {
    const collapsed = text
      .replace(/\s+/g, " ")
      .replace(/\s*([,;:()<>[\]{}|&])\s*/g, "$1")
      .trim();
    return canonicalizeType(collapsed);
  }

  private generateChangeId(change: Omit<ApiChange, "id">): string {
    const content = [
      change.type,
      change.category,
      change.name,
      change.beforeSnippet ?? "",
      change.afterSnippet ?? "",
    ].join("|");
    return crypto
      .createHash("sha256")
      .update(content)
      .digest("hex")
      .slice(0, 12);
  }
}

/**
 * Cap a type literal used in human-readable descriptions. The full type is
 * already visible in the change's before/after snippet, so the description
 * only needs enough characters to be useful at a glance. Large object-literal
 * types otherwise produce ~tens-of-KB descriptions that push PR comments past
 * GitHub's 65 KB limit.
 */
function summarizeType(text: string, maxLen = 120): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 1).trimEnd()}…`;
}
