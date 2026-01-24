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

/**
 * Represents a parsed API item from .api.json
 */
interface ParsedApiItem {
  /** Unique key for comparison */
  key: string;
  /** Kind of API element */
  kind: ChangeCategory;
  /** Name of the item */
  name: string;
  /** Parent name for nested items */
  parentName?: string;
  /** Full type signature */
  signature: string;
  /** Whether the item is optional (for members) */
  isOptional?: boolean;
  /** Raw excerpt tokens for snippet generation */
  excerptTokens?: ExcerptToken[];
  /** Nested members (for interfaces, classes, enums) */
  members?: ParsedApiItem[];
  /** Original kind from API Extractor */
  originalKind: string;
}

/**
 * Excerpt token from API Extractor .api.json
 */
interface ExcerptToken {
  kind: string;
  text: string;
  canonicalReference?: string;
}

/**
 * API Extractor .api.json structure (simplified)
 */
interface ApiJsonFile {
  metadata: {
    toolPackage: string;
    toolVersion: string;
  };
  kind: string;
  name: string;
  members: ApiJsonMember[];
}

/**
 * Member in API Extractor .api.json
 */
interface ApiJsonMember {
  kind: string;
  name: string;
  excerptTokens?: ExcerptToken[];
  members?: ApiJsonMember[];
  parameters?: Array<{
    parameterName: string;
    parameterTypeTokenRange: { startIndex: number; endIndex: number };
    isOptional?: boolean;
  }>;
  returnTypeTokenRange?: { startIndex: number; endIndex: number };
  typeTokenRange?: { startIndex: number; endIndex: number };
  isOptional?: boolean;
  isReadonly?: boolean;
  isStatic?: boolean;
  releaseTag?: string;
}

/**
 * Analyzer for comparing API snapshots
 */
export class ApiDiffAnalyzer {
  /**
   * Compare two API snapshots and return list of changes
   * @param baselinePath - Path to baseline .api.json
   * @param currentPath - Path to current .api.json
   * @returns Array of detected changes
   */
  analyze(baselinePath: string, currentPath: string): ApiChange[] {
    const baselineItems = this.parseApiJson(baselinePath);
    const currentItems = this.parseApiJson(currentPath);

    const changes: ApiChange[] = [];

    // Detect removals and modifications
    for (const [key, baselineItem] of baselineItems) {
      const currentItem = currentItems.get(key);

      if (!currentItem) {
        // Item was removed - breaking change
        changes.push(this.createRemovalChange(baselineItem));
      } else if (baselineItem.signature !== currentItem.signature) {
        // Item was modified - determine severity
        const modification = this.createModificationChange(
          baselineItem,
          currentItem,
        );
        if (modification) {
          changes.push(modification);
        }
      }
    }

    // Detect additions
    for (const [key, currentItem] of currentItems) {
      if (!baselineItems.has(key)) {
        changes.push(this.createAdditionChange(currentItem));
      }
    }

    return changes;
  }

  /**
   * Parse .api.json file into a map of API items
   */
  private parseApiJson(filePath: string): Map<string, ParsedApiItem> {
    const content = fs.readFileSync(filePath, "utf-8");
    const apiJson: ApiJsonFile = JSON.parse(content);

    const items = new Map<string, ParsedApiItem>();

    // Process all top-level members (EntryPoint contains the actual exports)
    for (const member of apiJson.members) {
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

  /**
   * Process an API member and add it to the items map
   */
  private processApiMember(
    member: ApiJsonMember,
    items: Map<string, ParsedApiItem>,
    parentName?: string,
  ): void {
    const kind = this.mapKind(member.kind);
    const key = this.buildKey(kind, member.name, parentName);
    const signature = this.extractSignature(member);

    const item: ParsedApiItem = {
      key,
      kind,
      name: member.name,
      parentName,
      signature,
      isOptional: member.isOptional,
      excerptTokens: member.excerptTokens,
      originalKind: member.kind,
    };

    items.set(key, item);

    // Process nested members for interfaces, classes, enums
    if (member.members && member.members.length > 0) {
      for (const nestedMember of member.members) {
        this.processApiMember(nestedMember, items, member.name);
      }
    }
  }

  /**
   * Map API Extractor kind to ChangeCategory
   */
  private mapKind(kind: string): ChangeCategory {
    const kindMap: Record<string, ChangeCategory> = {
      Function: "function",
      Interface: "interface",
      TypeAlias: "type",
      Class: "class",
      Enum: "enum",
      Variable: "variable",
      Property: "interface", // Interface properties
      PropertySignature: "interface",
      MethodSignature: "function",
      Method: "function",
      EnumMember: "enum",
      Constructor: "function",
    };

    return kindMap[kind] || "export";
  }

  /**
   * Build a unique key for an API item
   */
  private buildKey(
    kind: ChangeCategory,
    name: string,
    parentName?: string,
  ): string {
    return parentName ? `${kind}:${parentName}:${name}` : `${kind}:${name}`;
  }

  /**
   * Extract a comparable signature from an API member
   */
  private extractSignature(member: ApiJsonMember): string {
    if (!member.excerptTokens || member.excerptTokens.length === 0) {
      return member.name;
    }

    // Concatenate all excerpt tokens to form the full signature
    return member.excerptTokens.map((t) => t.text).join("");
  }

  /**
   * Extract a code snippet from an API item
   */
  private extractSnippet(item: ParsedApiItem): string {
    if (!item.excerptTokens || item.excerptTokens.length === 0) {
      return item.signature;
    }

    return item.excerptTokens.map((t) => t.text).join("");
  }

  /**
   * Create a removal change (breaking)
   */
  private createRemovalChange(item: ParsedApiItem): ApiChange {
    const change: Omit<ApiChange, "id"> = {
      type: ChangeType.BREAKING,
      severity: ChangeSeverity.MAJOR,
      category: item.kind,
      name: item.parentName ? `${item.parentName}.${item.name}` : item.name,
      description: this.createRemovalDescription(item),
      beforeSnippet: this.extractSnippet(item),
      afterSnippet: undefined,
    };

    return {
      ...change,
      id: this.generateChangeId(change),
    };
  }

  /**
   * Create an addition change (minor)
   */
  private createAdditionChange(item: ParsedApiItem): ApiChange {
    const change: Omit<ApiChange, "id"> = {
      type: ChangeType.ADDITION,
      severity: ChangeSeverity.MINOR,
      category: item.kind,
      name: item.parentName ? `${item.parentName}.${item.name}` : item.name,
      description: this.createAdditionDescription(item),
      beforeSnippet: undefined,
      afterSnippet: this.extractSnippet(item),
    };

    return {
      ...change,
      id: this.generateChangeId(change),
    };
  }

  /**
   * Create a modification change and determine severity
   */
  private createModificationChange(
    baseline: ParsedApiItem,
    current: ParsedApiItem,
  ): ApiChange | null {
    const { type, severity } = this.determineModificationSeverity(
      baseline,
      current,
    );

    const change: Omit<ApiChange, "id"> = {
      type,
      severity,
      category: baseline.kind,
      name: baseline.parentName
        ? `${baseline.parentName}.${baseline.name}`
        : baseline.name,
      description: this.createModificationDescription(baseline, current, type),
      beforeSnippet: this.extractSnippet(baseline),
      afterSnippet: this.extractSnippet(current),
    };

    return {
      ...change,
      id: this.generateChangeId(change),
    };
  }

  /**
   * Determine the severity of a modification
   */
  private determineModificationSeverity(
    baseline: ParsedApiItem,
    current: ParsedApiItem,
  ): { type: ChangeType; severity: ChangeSeverity } {
    // If an optional member became required, it's breaking
    if (baseline.isOptional && !current.isOptional) {
      return { type: ChangeType.BREAKING, severity: ChangeSeverity.MAJOR };
    }

    // If a required member became optional, it's non-breaking
    if (!baseline.isOptional && current.isOptional) {
      return { type: ChangeType.NON_BREAKING, severity: ChangeSeverity.MINOR };
    }

    // For signature changes, we need to analyze more carefully
    // For now, treat all signature changes as potentially breaking
    // A more sophisticated implementation would parse the signatures
    // and determine if it's widening (safe) or narrowing (breaking)

    const baselineSig = baseline.signature.trim();
    const currentSig = current.signature.trim();

    // Simple heuristic: if the current signature is longer (more types),
    // it might be widening, otherwise it might be narrowing
    // This is a simplification - proper analysis would require type parsing

    // Default to breaking for safety
    return { type: ChangeType.BREAKING, severity: ChangeSeverity.MAJOR };
  }

  /**
   * Create a human-readable description for a removal
   */
  private createRemovalDescription(item: ParsedApiItem): string {
    const kindName = this.getKindDisplayName(item.originalKind);
    const fullName = item.parentName
      ? `${item.parentName}.${item.name}`
      : item.name;

    return `Removed ${kindName} \`${fullName}\``;
  }

  /**
   * Create a human-readable description for an addition
   */
  private createAdditionDescription(item: ParsedApiItem): string {
    const kindName = this.getKindDisplayName(item.originalKind);
    const fullName = item.parentName
      ? `${item.parentName}.${item.name}`
      : item.name;

    return `Added ${kindName} \`${fullName}\``;
  }

  /**
   * Create a human-readable description for a modification
   */
  private createModificationDescription(
    baseline: ParsedApiItem,
    current: ParsedApiItem,
    changeType: ChangeType,
  ): string {
    const kindName = this.getKindDisplayName(baseline.originalKind);
    const fullName = baseline.parentName
      ? `${baseline.parentName}.${baseline.name}`
      : baseline.name;

    if (baseline.isOptional && !current.isOptional) {
      return `Changed ${kindName} \`${fullName}\` from optional to required`;
    }

    if (!baseline.isOptional && current.isOptional) {
      return `Changed ${kindName} \`${fullName}\` from required to optional`;
    }

    const changeTypeName =
      changeType === ChangeType.BREAKING ? "Breaking change" : "Modified";
    return `${changeTypeName} in ${kindName} \`${fullName}\``;
  }

  /**
   * Get display name for API kind
   */
  private getKindDisplayName(kind: string): string {
    const displayNames: Record<string, string> = {
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
    };

    return displayNames[kind] || kind.toLowerCase();
  }

  /**
   * Generate a unique, stable ID for a change
   */
  private generateChangeId(change: Omit<ApiChange, "id">): string {
    const content = [
      change.type,
      change.category,
      change.name,
      change.beforeSnippet || "",
      change.afterSnippet || "",
    ].join("|");

    return crypto
      .createHash("sha256")
      .update(content)
      .digest("hex")
      .slice(0, 12);
  }
}
