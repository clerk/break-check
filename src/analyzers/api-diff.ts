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
  typeTokenRange?: TokenRange;
  initializerTokenRange?: TokenRange;
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
    const key = this.buildKey(member.kind, member.name, parentChain);
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
          isRest: Boolean(p.isRest),
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
      return {
        kind: "typed",
        type: member.typeTokenRange
          ? this.canonicalType(member.excerptTokens, member.typeTokenRange)
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
   * Compare two items and produce a change if they differ meaningfully.
   * Returns null when the difference is cosmetic (whitespace, param renames).
   */
  private compareItems(
    baseline: ParsedApiItem,
    current: ParsedApiItem,
  ): ApiChange | null {
    // Optionality flip on the member itself (property/method optional marker)
    if (baseline.isOptional !== current.isOptional) {
      const type = baseline.isOptional
        ? ChangeType.BREAKING
        : ChangeType.NON_BREAKING;
      return this.buildModification(baseline, current, type, undefined);
    }

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
      return this.compareCallable(baseline, current);
    }

    if (baseline.shape.kind === "typed" && current.shape.kind === "typed") {
      return this.compareTyped(baseline, current);
    }

    if (
      baseline.shape.kind === "enumMember" &&
      current.shape.kind === "enumMember"
    ) {
      if (baseline.shape.initializer === current.shape.initializer) {
        return null;
      }
      return this.buildModification(
        baseline,
        current,
        ChangeType.BREAKING,
        `Enum member value changed: \`${baseline.shape.initializer || "(implicit)"}\` → \`${current.shape.initializer || "(implicit)"}\``,
      );
    }

    // Kind mismatch (e.g., became a different shape); treat as breaking.
    if (baseline.shape.kind !== current.shape.kind) {
      return this.buildModification(
        baseline,
        current,
        ChangeType.BREAKING,
        `Declaration kind changed from \`${baseline.originalKind}\` to \`${current.originalKind}\``,
      );
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
    return this.buildModification(
      baseline,
      current,
      ChangeType.BREAKING,
      undefined,
    );
  }

  private compareCallable(
    baseline: ParsedApiItem,
    current: ParsedApiItem,
  ): ApiChange | null {
    if (
      baseline.shape.kind !== "callable" ||
      current.shape.kind !== "callable"
    ) {
      return null;
    }

    const before = baseline.shape;
    const after = current.shape;

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

    return this.buildModification(
      baseline,
      current,
      severity,
      notes.join("; "),
    );
  }

  private compareTyped(
    baseline: ParsedApiItem,
    current: ParsedApiItem,
  ): ApiChange | null {
    if (baseline.shape.kind !== "typed" || current.shape.kind !== "typed") {
      return null;
    }

    const before = baseline.shape;
    const after = current.shape;

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

    return this.buildModification(
      baseline,
      current,
      ChangeType.BREAKING,
      notes.join("; "),
    );
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

  private buildKey(kind: string, name: string, parentChain?: string): string {
    const k = this.mapCategory(kind);
    return parentChain ? `${k}:${parentChain}:${name}` : `${k}:${name}`;
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
   * differences don't show up as breaking changes.
   */
  private normalizeType(text: string): string {
    return text
      .replace(/\s+/g, " ")
      .replace(/\s*([,;:()<>[\]{}|&])\s*/g, "$1")
      .trim();
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
