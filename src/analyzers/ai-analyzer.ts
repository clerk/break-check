/**
 * AI-powered change analyzer.
 *
 * Sends rule-based ApiChange[] plus a compact view of the baseline/current API
 * surface to Anthropic's Claude. The model returns:
 *   - a verdict per rule-based change (confirming or overriding the type)
 *   - any additional breaks the rule-based pass missed
 *
 * Failures are non-fatal: on any error the input changes are returned
 * unchanged and a warning is logged. The CLI's exit code must never depend on
 * AI availability.
 */

import * as fs from "node:fs";
import * as crypto from "node:crypto";
import {
  AiAnalysis,
  AiAnalysisSource,
  ApiChange,
  ChangeCategory,
  ChangeSeverity,
  ChangeType,
} from "../types.js";

/* ------------------------------------------------------------------ types -- */

export interface AiAnalyzerOptions {
  apiKey: string;
  model?: string;
  /** Max rule-based changes batched into a single AI call. Default 80. */
  maxChangesPerCall?: number;
  /** Per-call timeout in milliseconds. Default 60_000. */
  timeoutMs?: number;
  /** Print info/debug messages to stderr. */
  verbose?: boolean;
  /**
   * Optional structural Anthropic client for tests. When omitted the real
   * `@anthropic-ai/sdk` is lazily imported on first use.
   */
  client?: AiClient;
  /** Override the warning logger. Defaults to console.warn. */
  logger?: Pick<Console, "warn" | "log">;
}

export interface AiPackageContext {
  packageName: string;
  baselineApiJsonPath: string;
  currentApiJsonPath: string;
}

/**
 * Verdict shape returned by the model via the submit_review tool.
 */
export interface AiVerdict {
  verdicts: Array<{
    id: string;
    type: ChangeType;
    confidence: number;
    rationale: string;
    migration?: string;
  }>;
  missed: Array<{
    type: ChangeType;
    category: ChangeCategory;
    name: string;
    description: string;
    beforeSnippet?: string;
    afterSnippet?: string;
    rationale: string;
    migration?: string;
    confidence: number;
  }>;
}

/**
 * Minimal structural client matching the surface of @anthropic-ai/sdk we use.
 * Lets tests inject a fake without depending on the real SDK.
 */
export interface AiClient {
  messages: {
    create(params: AiMessagesCreateParams): Promise<AiMessagesResponse>;
  };
}

export interface AiMessagesCreateParams {
  model: string;
  max_tokens: number;
  system: Array<{ type: "text"; text: string; cache_control?: object }>;
  tools: Array<{
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
  }>;
  tool_choice: { type: "tool"; name: string };
  messages: Array<{
    role: "user" | "assistant";
    content: Array<{ type: "text"; text: string; cache_control?: object }>;
  }>;
}

export interface AiMessagesResponse {
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; name: string; input: unknown }
  >;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

/* ----------------------------------------------------------- prompt parts -- */

const SUBMIT_REVIEW_TOOL = {
  name: "submit_review",
  description:
    "Submit the final review verdict for a package's API changes. Always call this exactly once. Never reply with prose.",
  input_schema: {
    type: "object",
    properties: {
      verdicts: {
        type: "array",
        description:
          "For each rule-based change supplied, exactly one verdict object with the matching id.",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            type: {
              type: "string",
              enum: ["breaking", "non-breaking", "addition"],
            },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            rationale: { type: "string" },
            migration: {
              type: "string",
              description: "Only required when type is 'breaking'.",
            },
          },
          required: ["id", "type", "confidence", "rationale"],
        },
      },
      missed: {
        type: "array",
        description:
          "Additional changes the rule-based analyzer did not flag. Include only items with consumer-observable impact (typically breaking). Omit cosmetic / internal renames. Empty array if none.",
        items: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["breaking", "non-breaking", "addition"],
            },
            category: {
              type: "string",
              enum: [
                "export",
                "function",
                "interface",
                "type",
                "class",
                "enum",
                "variable",
              ],
            },
            name: { type: "string" },
            description: { type: "string" },
            beforeSnippet: { type: "string" },
            afterSnippet: { type: "string" },
            rationale: { type: "string" },
            migration: { type: "string" },
            confidence: { type: "number", minimum: 0, maximum: 1 },
          },
          required: [
            "type",
            "category",
            "name",
            "description",
            "rationale",
            "confidence",
          ],
        },
      },
    },
    required: ["verdicts", "missed"],
  },
} as const;

const SYSTEM_PROMPT = `You are a senior TypeScript API reviewer. You judge whether a change to a published TypeScript package's public API is a breaking change *for downstream consumers*.

Definitions:
- "breaking": existing well-typed consumer code may stop compiling, stop running correctly, or change observable behavior in a way that requires the caller to adapt. Examples: removed exports, narrowed return types, broadened parameter types where consumers pass values that no longer satisfy the new type, required parameter added, optional parameter made required.
- "non-breaking": the public type/shape changed but no well-typed consumer is affected. Examples: parameter type widening (input contravariance), return type narrowing (output covariance), optional parameter added, parameter made optional, internal alias renamed where the structural shape is identical, JSDoc-only changes.
- "addition": a brand new export that did not exist in the baseline. Never breaking.

Reasoning rules:
1. Variance matters. For function inputs, a wider type in the *current* version is safe for callers (non-breaking). For function outputs, a wider type in current is *breaking* (callers may rely on the narrower type). For inputs, narrowing is breaking; for outputs, narrowing is safe.
2. Structural equivalence overrides textual diff. If a type alias was renamed but the resolved shape is identical, the change is non-breaking. Use the full API surface block to resolve aliases.
3. Discriminated unions: changing a discriminator value is breaking. Adding a new variant is non-breaking. Removing or renaming a variant is breaking.
4. Optional fields: making an *output* field optional is breaking; making an *input* field optional is non-breaking.
5. Class member visibility going from public to protected/private is breaking. The other direction is non-breaking.
6. Generic constraint tightening is breaking; loosening is non-breaking.
7. When uncertain, prefer "breaking" but lower confidence to reflect the uncertainty.

Output protocol:
- Always respond by calling the submit_review tool. Never reply with plain text.
- Provide exactly one verdict object per supplied rule-based change, keyed by its id.
- In "missed", include only changes you can justify from the API surface. Do not invent changes. If unsure, leave it out.
- Keep rationales to 1-3 sentences. Be specific (cite the type/parameter name).
- For any verdict whose type is "breaking", include a one-sentence "migration" hint for consumers.`;

/* --------------------------------------------------------------- analyzer -- */

export class AiChangeAnalyzer {
  /** Resolved model identifier this analyzer will send to the API. */
  public readonly model: string;
  private readonly maxChangesPerCall: number;
  private readonly timeoutMs: number;
  private readonly verbose: boolean;
  private readonly apiKey: string;
  private readonly logger: Pick<Console, "warn" | "log">;
  private clientPromise: Promise<AiClient> | null = null;
  /** Cumulative count of changes reviewed across all .analyze() calls. */
  public reviewedCount = 0;
  /** Cumulative count of rule-based classifications the AI overrode. */
  public overriddenCount = 0;
  /** Cumulative count of breaks discovered by the AI (not in rule output). */
  public discoveredCount = 0;

  constructor(opts: AiAnalyzerOptions) {
    if (!opts.apiKey) {
      throw new Error("AiChangeAnalyzer requires an apiKey");
    }
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? "claude-sonnet-4-6";
    this.maxChangesPerCall = opts.maxChangesPerCall ?? 80;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.verbose = opts.verbose ?? false;
    this.logger = opts.logger ?? console;
    if (opts.client) {
      this.clientPromise = Promise.resolve(opts.client);
    }
  }

  /**
   * Enrich (and possibly extend) the supplied rule-based changes for one package.
   * Returns a new array; the input is not mutated.
   */
  async analyze(
    changes: ApiChange[],
    ctx: AiPackageContext,
  ): Promise<ApiChange[]> {
    let surface: string;
    try {
      surface = this.buildSurfaceBlock(ctx);
    } catch (error) {
      this.warn(
        `[ai] could not load API surface for ${ctx.packageName}: ${describe(error)}. Skipping AI review.`,
      );
      return changes;
    }

    let client: AiClient;
    try {
      client = await this.getClient();
    } catch (error) {
      this.warn(
        `[ai] @anthropic-ai/sdk is not available (${describe(error)}). Skipping AI review.`,
      );
      return changes;
    }

    // The rule-based "addition" entries don't need re-classification (they're
    // by definition non-breaking), but the model still benefits from seeing
    // the surface to scan for missed breaks. We strip additions from the
    // chunked verdict list but still issue at least one call for the scan.
    const reviewable = changes.filter((c) => c.type !== ChangeType.ADDITION);
    const passThrough = changes.filter((c) => c.type === ChangeType.ADDITION);

    // Keys that the rule-based pass already accounts for. Used both to brief
    // the model (so its "missed" scan can ignore them) and to defensively
    // de-dup if the model reports one anyway.
    const knownKeys = new Set(changes.map((c) => `${c.category}:${c.name}`));
    const knownSummary = formatKnownSummary(changes);

    const chunks: ApiChange[][] = [];
    if (reviewable.length === 0) {
      chunks.push([]);
    } else {
      for (let i = 0; i < reviewable.length; i += this.maxChangesPerCall) {
        chunks.push(reviewable.slice(i, i + this.maxChangesPerCall));
      }
    }

    const verdictMap = new Map<string, AiVerdict["verdicts"][number]>();
    const missedAggregate: AiVerdict["missed"] = [];

    for (let i = 0; i < chunks.length; i++) {
      const includeMissedScan = i === 0;
      const verdict = await this.runOneCall(
        client,
        chunks[i],
        surface,
        ctx,
        includeMissedScan,
        knownSummary,
      );
      if (!verdict) {
        // Hard fail-soft for this chunk; the affected changes will keep their
        // rule-based type. Continue to the next chunk in case it succeeds.
        continue;
      }
      for (const v of verdict.verdicts) verdictMap.set(v.id, v);
      if (includeMissedScan) missedAggregate.push(...verdict.missed);
    }

    const enriched: ApiChange[] = [];

    for (const change of reviewable) {
      const v = verdictMap.get(change.id);
      if (!v) {
        // No verdict received (chunk failed or model omitted it). Keep
        // rule-based classification; do not annotate.
        enriched.push(change);
        continue;
      }
      // `addition` is reserved for brand-new exports. The rule-based pass
      // already routes those around the AI (see `reviewable` filter above),
      // so any `addition` verdict here is a protocol violation: the model
      // meant "not breaking" for an in-place modification. Coerce to
      // non-breaking and note it.
      let verdictType = v.type;
      if (verdictType === ChangeType.ADDITION) {
        this.warn(
          `[ai] ${ctx.packageName}: model returned 'addition' for in-place change \`${change.name}\` (${change.category}); coercing to 'non-breaking'.`,
        );
        verdictType = ChangeType.NON_BREAKING;
      }
      this.reviewedCount += 1;
      const overrode = verdictType !== change.type;
      if (overrode) this.overriddenCount += 1;
      const aiAnalysis: AiAnalysis = {
        source: overrode ? "rule-overridden" : "rule-confirmed",
        confidence: clamp01(v.confidence),
        rationale: v.rationale,
        migration:
          verdictType === ChangeType.BREAKING ? v.migration : undefined,
        model: this.model,
      };
      enriched.push({
        ...change,
        type: verdictType,
        severity: severityForType(verdictType),
        ruleBasedType: overrode ? change.type : change.ruleBasedType,
        aiAnalysis,
      });
    }

    for (const m of missedAggregate) {
      // Defensive de-dup: ignore "missed" entries that duplicate something
      // the rule-based pass already produced (matched by category + name).
      if (knownKeys.has(`${m.category}:${m.name}`)) continue;
      const aiAnalysis: AiAnalysis = {
        source: "ai-discovered",
        confidence: clamp01(m.confidence),
        rationale: m.rationale,
        migration: m.type === ChangeType.BREAKING ? m.migration : undefined,
        model: this.model,
      };
      const partial: Omit<ApiChange, "id"> = {
        type: m.type,
        severity: severityForType(m.type),
        category: m.category,
        name: m.name,
        description: m.description,
        beforeSnippet: m.beforeSnippet,
        afterSnippet: m.afterSnippet,
        aiAnalysis,
      };
      const id = generateChangeId(partial);
      if (enriched.some((c) => c.id === id)) continue;
      this.discoveredCount += 1;
      enriched.push({ ...partial, id });
    }

    return [...enriched, ...passThrough];
  }

  /* --------------------------------------------------------- internals -- */

  private async runOneCall(
    client: AiClient,
    chunk: ApiChange[],
    surface: string,
    ctx: AiPackageContext,
    includeMissedScan: boolean,
    knownSummary: string,
  ): Promise<AiVerdict | null> {
    const ruleListPayload = chunk.map((c) => ({
      id: c.id,
      type: c.type,
      category: c.category,
      name: c.name,
      description: c.description,
      beforeSnippet: c.beforeSnippet,
      afterSnippet: c.afterSnippet,
    }));

    const userInstruction = [
      `Package: ${ctx.packageName}`,
      "",
      "Rule-based changes to review (JSON):",
      "```json",
      JSON.stringify(ruleListPayload, null, 2),
      "```",
      "",
      "All changes the rule-based pass already produced (do NOT re-report any of these under `missed`):",
      "```",
      knownSummary || "(none)",
      "```",
      "",
      includeMissedScan
        ? "Scan the API surface block above for any consumer-observable breaking changes that are NOT in the list above, and report them under `missed`. Be conservative: omit anything you are unsure about."
        : "Do not populate `missed` in this call; return an empty `missed` array.",
      "",
      `Return exactly ${chunk.length} verdict object(s), one per supplied id.`,
    ].join("\n");

    const params: AiMessagesCreateParams = {
      model: this.model,
      max_tokens: 8192,
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      tools: [
        {
          name: SUBMIT_REVIEW_TOOL.name,
          description: SUBMIT_REVIEW_TOOL.description,
          input_schema: SUBMIT_REVIEW_TOOL.input_schema as unknown as Record<
            string,
            unknown
          >,
        },
      ],
      tool_choice: { type: "tool", name: SUBMIT_REVIEW_TOOL.name },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: surface,
              cache_control: { type: "ephemeral" },
            },
            { type: "text", text: userInstruction },
          ],
        },
      ],
    };

    let response: AiMessagesResponse;
    try {
      response = await withTimeout(
        client.messages.create(params),
        this.timeoutMs,
      );
    } catch (error) {
      this.warn(
        `[ai] call failed for ${ctx.packageName}: ${describe(error)}. Falling back to rule-based for this chunk.`,
      );
      return null;
    }

    if (this.verbose && response.usage) {
      const u = response.usage;
      this.logger.log(
        `[ai] ${ctx.packageName}: input=${u.input_tokens ?? 0}, output=${u.output_tokens ?? 0}, cache_read=${u.cache_read_input_tokens ?? 0}, cache_create=${u.cache_creation_input_tokens ?? 0}`,
      );
    }

    const toolUse = response.content.find(
      (b): b is { type: "tool_use"; name: string; input: unknown } =>
        b.type === "tool_use" && b.name === SUBMIT_REVIEW_TOOL.name,
    );
    if (!toolUse) {
      this.warn(
        `[ai] ${ctx.packageName}: model did not call submit_review. Skipping.`,
      );
      return null;
    }

    const parsed = parseVerdict(toolUse.input);
    if (!parsed) {
      this.warn(
        `[ai] ${ctx.packageName}: malformed submit_review payload. Skipping.`,
      );
      return null;
    }
    return parsed;
  }

  private async getClient(): Promise<AiClient> {
    if (this.clientPromise) return this.clientPromise;
    this.clientPromise = (async () => {
      const mod = (await import("@anthropic-ai/sdk")) as unknown as {
        default: new (init: { apiKey: string }) => AiClient;
      };
      const Ctor = mod.default;
      return new Ctor({ apiKey: this.apiKey });
    })();
    return this.clientPromise;
  }

  private buildSurfaceBlock(ctx: AiPackageContext): string {
    const baseline = extractSurface(ctx.baselineApiJsonPath);
    const current = extractSurface(ctx.currentApiJsonPath);
    return [
      `# API surface for ${ctx.packageName}`,
      "",
      "## Baseline",
      "```ts",
      baseline,
      "```",
      "",
      "## Current",
      "```ts",
      current,
      "```",
    ].join("\n");
  }

  private warn(message: string): void {
    this.logger.warn(message);
  }
}

/* -------------------------------------------------------------- helpers -- */

interface ExcerptToken {
  text: string;
}

interface ApiJsonMember {
  kind: string;
  name: string;
  excerptTokens?: ExcerptToken[];
  members?: ApiJsonMember[];
}

interface ApiJsonRoot {
  kind: string;
  name: string;
  members: ApiJsonMember[];
}

/**
 * Produce a compact TS-like view of an api-extractor JSON: one signature per
 * line, sorted, with parent-qualified names for nested members.
 */
function extractSurface(apiJsonPath: string): string {
  const raw = fs.readFileSync(apiJsonPath, "utf-8");
  const json: ApiJsonRoot = JSON.parse(raw);
  const lines: string[] = [];
  const walk = (m: ApiJsonMember, parent?: string): void => {
    if (m.kind === "EntryPoint") {
      for (const child of m.members ?? []) walk(child, parent);
      return;
    }
    const qualified = parent ? `${parent}.${m.name}` : m.name;
    const text = (m.excerptTokens ?? [])
      .map((t) => t.text)
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    if (text) {
      lines.push(`${m.kind} ${qualified}: ${text}`);
    }
    for (const child of m.members ?? []) walk(child, qualified);
  };
  for (const m of json.members) walk(m);
  lines.sort();
  return lines.join("\n");
}

function parseVerdict(input: unknown): AiVerdict | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  const verdicts = obj.verdicts;
  const missed = obj.missed;
  if (!Array.isArray(verdicts) || !Array.isArray(missed)) return null;

  const okType = (v: unknown): v is ChangeType =>
    v === ChangeType.BREAKING ||
    v === ChangeType.NON_BREAKING ||
    v === ChangeType.ADDITION;

  const okCategory = (v: unknown): v is ChangeCategory =>
    v === "export" ||
    v === "function" ||
    v === "interface" ||
    v === "type" ||
    v === "class" ||
    v === "enum" ||
    v === "variable";

  const verdictItems: AiVerdict["verdicts"] = [];
  for (const item of verdicts) {
    if (!item || typeof item !== "object") continue;
    const v = item as Record<string, unknown>;
    if (typeof v.id !== "string") continue;
    if (!okType(v.type)) continue;
    if (typeof v.confidence !== "number") continue;
    if (typeof v.rationale !== "string") continue;
    verdictItems.push({
      id: v.id,
      type: v.type,
      confidence: v.confidence,
      rationale: v.rationale,
      migration: typeof v.migration === "string" ? v.migration : undefined,
    });
  }

  const missedItems: AiVerdict["missed"] = [];
  for (const item of missed) {
    if (!item || typeof item !== "object") continue;
    const m = item as Record<string, unknown>;
    if (!okType(m.type)) continue;
    if (!okCategory(m.category)) continue;
    if (typeof m.name !== "string") continue;
    if (typeof m.description !== "string") continue;
    if (typeof m.rationale !== "string") continue;
    if (typeof m.confidence !== "number") continue;
    missedItems.push({
      type: m.type,
      category: m.category,
      name: m.name,
      description: m.description,
      beforeSnippet:
        typeof m.beforeSnippet === "string" ? m.beforeSnippet : undefined,
      afterSnippet:
        typeof m.afterSnippet === "string" ? m.afterSnippet : undefined,
      rationale: m.rationale,
      migration: typeof m.migration === "string" ? m.migration : undefined,
      confidence: m.confidence,
    });
  }

  return { verdicts: verdictItems, missed: missedItems };
}

function formatKnownSummary(changes: ApiChange[]): string {
  return changes
    .map((c) => `- [${c.type}] ${c.category} ${c.name}`)
    .sort()
    .join("\n");
}

function severityForType(type: ChangeType): ChangeSeverity {
  return type === ChangeType.BREAKING
    ? ChangeSeverity.MAJOR
    : ChangeSeverity.MINOR;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

function generateChangeId(change: Omit<ApiChange, "id">): string {
  const content = [
    change.type,
    change.category,
    change.name,
    change.beforeSnippet ?? "",
    change.afterSnippet ?? "",
  ].join("|");
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 12);
}
