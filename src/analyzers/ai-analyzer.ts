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
  AiReviewFailure,
  ApiChange,
  ChangeCategory,
  ChangeSeverity,
  ChangeType,
} from "../types.js";
import { canonicalizeType } from "../utils/canonicalize-type.js";

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
   * Apply the model's `breaking -> non-breaking` downgrades. A downgrade is the
   * only verdict that can clear a flagged break, so off by default it is
   * recorded as an `ai-suggested-downgrade` and the change stays breaking. When
   * true the verdict is applied. Does not change the prompt; the model reasons
   * the same either way.
   */
  applyDowngrades?: boolean;
  /**
   * Run the open-ended "what did the rule-based pass miss?" audit. When true the
   * prompt ships both the baseline and current surfaces (the audit must diff old
   * vs new to find an unflagged break) and the reviewer also runs on
   * additions-only diffs. Off by default: the verdict path ships only the
   * focused set of types each change references.
   */
  scanForMissed?: boolean;
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
  /**
   * Current `.api.json` paths for the package's OTHER subpaths. Used only to
   * resolve a changed type's *usage sites* (referrers), which determine whether
   * the type is consumer-input or read-only output. A type and the signatures
   * that establish its direction (`getX(): Promise<T>`) frequently live in
   * different subpath rollups, and the analyzer otherwise sees one subpath at a
   * time. Optional; absent means usage sites are resolved from the current
   * surface alone.
   */
  siblingCurrentApiJsonPaths?: string[];
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
8. Only relax a rule-based "breaking" verdict to "non-breaking" when you can fully resolve the relevant types from the current API surface or the change's before/after snippets. If a referenced type's definition is not available to you, keep "breaking".
9. Adding a *new optional* property to an object type is non-breaking, for both input and output types: existing consumers neither passed it nor relied on reading it. (This is distinct from rule 4, which is about flipping an *existing* output field to optional.)
10. \`Pick\`, \`Omit\`, \`Partial\`, \`Required\`, and other mapped types preserve each member's optionality from the source type. Resolve the member against the referenced source definition before judging; a property newly included by a \`Pick\` (or surviving an \`Omit\`) is optional in the result whenever the source declares it optional, so do not treat it as required unless the source does.
11. Adding a *required* property to a type is breaking only when consumers construct or assign values of that type (a parameter / input position, or an object literal they author against the type). For a type consumers only read (a return / response / output type, e.g. the resolved value of a \`Promise<T>\` return or a hook result field), adding a property is non-breaking. Determine the direction from the "Usage sites" block: a \`Promise<T>\` result, a function return, or a result field is output. If any usage is an input position, or no usage sites are shown, keep "breaking".
12. A reference whose module specifier is not a public, exported entry point of its package is breaking regardless of structural shape: the consumer cannot resolve the module, so the type degrades to \`any\` (skipLibCheck) or fails to compile (TS2307). Treat a specifier that contains a \`/_chunks/\` segment, ends in a content-hashed bundler chunk basename (a \`-<hash>\` suffix), or names a subpath a package blocks/omits in its \`exports\` as non-resolvable. Do NOT downgrade such a change on structural-equivalence grounds (rule 2 does not apply): "the shape is identical" is true but irrelevant when the consumer never receives the type. When a change carries a \`referenceResolutions\` list, entries with \`"deterministic": true\` were resolved against the dependency's actual \`exports\` map: \`blocked\` means consumers cannot resolve the specifier, \`exported\` means it is a public entry point. Trust those over any guess from the specifier's path shape. An \`"unknown"\` verdict verified nothing (dependency not installed, no \`exports\` map, or a relative/absolute specifier); fall back to the shape heuristics above for those.
13. The inverse swap is a repair, not a break: when a change's only difference is that a non-resolvable specifier (per rule 12) was replaced by one whose \`referenceResolutions\` verdict is \`exported\`, the old type was never consumable (it errored or degraded to \`any\`), so no well-typed consumer can be broken by the swap. Judge it "non-breaking" even though the imported alias name changed with the specifier (bundlers minify chunk-internal names, e.g. \`Xm\` for \`Without\`). A change carrying \`repairedReference\` was already verified this way deterministically; confirm it as non-breaking rather than escalating.
14. A union containing \`string & {}\` or \`string & Record<never, never>\` (or the \`number\` equivalents) accepts every value of that primitive; its literal and template-literal arms affect only editor autocomplete suggestions (the \`Autocomplete\`/\`LiteralUnion\` idiom). Changing, adding, or removing those arms while the absorbing arm remains unchanged is non-breaking: the assignable set is exactly the primitive both before and after, in both variance directions. Resolve aliases like \`Autocomplete<X>\` from the API surface to see the absorbing arm before judging. A change carrying \`absorbingArmUnion\` was already verified this way deterministically; confirm it as non-breaking rather than escalating.

Output protocol:
- Always respond by calling the submit_review tool. Never reply with plain text.
- Provide exactly one verdict object per supplied rule-based change, keyed by its id.
- Populate "missed" only when the user message explicitly asks you to scan for missed changes; otherwise return an empty array. Never invent changes; if unsure, leave it out.
- Keep each rationale to one short, specific sentence (cite the type/parameter name).
- Never leave a verdict's rationale conditional on a fact you can resolve from the provided surface or usage sites (whether a property is optional, whether a type is input or output). Resolve it first, then give a definite verdict.
- For any verdict whose type is "breaking", include a one-sentence "migration" hint for consumers.`;

/* --------------------------------------------------------------- analyzer -- */

export class AiChangeAnalyzer {
  /** Resolved model identifier this analyzer will send to the API. */
  public readonly model: string;
  private readonly maxChangesPerCall: number;
  private readonly timeoutMs: number;
  private readonly verbose: boolean;
  private readonly applyDowngrades: boolean;
  private readonly scanForMissed: boolean;
  private readonly apiKey: string;
  private readonly logger: Pick<Console, "warn" | "log">;
  private clientPromise: Promise<AiClient> | null = null;
  /** Cumulative count of changes reviewed across all .analyze() calls. */
  public reviewedCount = 0;
  /** Cumulative count of rule-based classifications the AI overrode. */
  public overriddenCount = 0;
  /** Cumulative count of breaks discovered by the AI (not in rule output). */
  public discoveredCount = 0;
  /**
   * (package, subpath) reviews that could not be completed even after
   * split-and-retry. The affected changes keep their rule-based verdict; the
   * detector drains this into the report so partial coverage is visible rather
   * than silently trusted. Cumulative across `.analyze()` calls.
   */
  public readonly incompleteReviews: AiReviewFailure[] = [];

  constructor(opts: AiAnalyzerOptions) {
    if (!opts.apiKey) {
      throw new Error("AiChangeAnalyzer requires an apiKey");
    }
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? "claude-sonnet-4-6";
    this.maxChangesPerCall = opts.maxChangesPerCall ?? 80;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.verbose = opts.verbose ?? false;
    this.applyDowngrades = opts.applyDowngrades ?? false;
    this.scanForMissed = opts.scanForMissed ?? false;
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
    // The rule-based "addition" entries don't need re-classification (they're
    // by definition non-breaking). They're stripped from the chunked verdict
    // list and re-appended untouched at the end.
    const reviewable = changes.filter((c) => c.type !== ChangeType.ADDITION);
    const passThrough = changes.filter((c) => c.type === ChangeType.ADDITION);

    // Lean path: nothing to re-classify and the caller didn't ask for the
    // open-ended missed-breaks audit, so there is no reason to spend a call.
    if (reviewable.length === 0 && !this.scanForMissed) {
      return changes;
    }

    let surface: string;
    // True when the audit surface had to be truncated to fit the size budget, so
    // a break beyond the cap could not be seen. Recorded as partial coverage
    // below if the audit otherwise ran.
    let auditTruncated = false;
    try {
      // The audit has to diff old against new to find an unflagged break, so it
      // gets both full surfaces. The verdict path instead gets a focused
      // context: only the definitions of the types each change references, which
      // is all the model needs to judge (and confidently relax) a verdict, at a
      // fraction of the tokens.
      if (this.scanForMissed) {
        const audit = buildAuditSurfaceBlock(ctx);
        surface = audit.text;
        auditTruncated = audit.truncated;
      } else {
        surface = buildFocusedSurfaceBlock(ctx, reviewable);
      }
    } catch (error) {
      this.warn(
        `[ai] could not load API surface for ${ctx.packageName}: ${describe(error)}. Skipping AI review.`,
      );
      this.recordIncomplete(
        ctx,
        reviewable.length,
        `could not load API surface: ${describe(error)}`,
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
      this.recordIncomplete(
        ctx,
        reviewable.length,
        `@anthropic-ai/sdk unavailable: ${describe(error)}`,
      );
      return changes;
    }

    // Keys the rule-based pass already accounts for. Used to defensively de-dup
    // if the model reports a "missed" entry that duplicates a known change.
    const knownKeys = new Set(changes.map((c) => `${c.category}:${c.name}`));

    const chunks: ApiChange[][] = [];
    if (reviewable.length === 0) {
      chunks.push([]);
    } else {
      for (let i = 0; i < reviewable.length; i += this.maxChangesPerCall) {
        chunks.push(reviewable.slice(i, i + this.maxChangesPerCall));
      }
    }

    // A cache breakpoint on the surface only pays off when more than one call
    // will read it; a lone call would eat the 1.25x cache-write with nothing
    // to amortize against, so the single-chunk path sends it as plain input.
    const cacheSurface = chunks.length > 1;

    const verdictMap = new Map<string, AiVerdict["verdicts"][number]>();
    const missedAggregate: AiVerdict["missed"] = [];

    // Changes left unreviewed because a call failed even after retries. Recorded
    // once per analyze() so the report can flag partial coverage.
    let unreviewed = 0;
    // The missed-breaks audit (when requested) rides on the first chunk. An
    // additions-only diff makes that chunk empty, so an audit failure adds 0 to
    // `unreviewed` and would otherwise leave no trace, letting the report claim a
    // complete AI review. Track it separately so the failure is still surfaced.
    let missedScanFailed = false;

    // Run one chunk, splitting and retrying on failure so a single oversized or
    // transient failure doesn't wipe out every verdict in the chunk. A1/A2 keep
    // the first attempt within size; this is the backstop for a transient error
    // or a verdict response overflowing max_tokens. We don't split a missed-scan
    // call: there the full audit surface (not the rule list) dominates the
    // payload, so a smaller chunk wouldn't help.
    const reviewChunk = async (
      chunk: ApiChange[],
      includeMissedScan: boolean,
      otherChangesSummary: string,
    ): Promise<AiVerdict | null> => {
      const verdict = await this.runOneCall(
        client,
        chunk,
        surface,
        ctx,
        includeMissedScan,
        otherChangesSummary,
        cacheSurface,
      );
      if (verdict) return verdict;
      if (chunk.length <= 1 || includeMissedScan) {
        unreviewed += chunk.length;
        return null;
      }
      this.warn(
        `[ai] ${ctx.packageName}: review of ${chunk.length} changes failed; retrying as two smaller batches.`,
      );
      const mid = Math.floor(chunk.length / 2);
      const left = await reviewChunk(chunk.slice(0, mid), false, "");
      const right = await reviewChunk(chunk.slice(mid), false, "");
      if (!left && !right) return null;
      return {
        verdicts: [...(left?.verdicts ?? []), ...(right?.verdicts ?? [])],
        missed: [...(left?.missed ?? []), ...(right?.missed ?? [])],
      };
    };

    for (let i = 0; i < chunks.length; i++) {
      const includeMissedScan = i === 0 && this.scanForMissed;
      // For the scan, brief the model on every OTHER change so it doesn't
      // re-report one under `missed`. The current chunk's changes are already
      // in this call's JSON payload, so they're excluded here, which means a
      // single-chunk package sends no redundant summary at all.
      let otherChangesSummary = "";
      if (includeMissedScan) {
        const chunkIds = new Set(chunks[i].map((c) => c.id));
        otherChangesSummary = formatKnownSummary(
          changes.filter((c) => !chunkIds.has(c.id)),
        );
      }
      const verdict = await reviewChunk(
        chunks[i],
        includeMissedScan,
        otherChangesSummary,
      );
      if (!verdict) {
        // Hard fail-soft for this chunk; the affected changes keep their
        // rule-based type (and were counted in `unreviewed`). Continue to the
        // next chunk in case it succeeds.
        if (includeMissedScan) missedScanFailed = true;
        continue;
      }
      for (const v of verdict.verdicts) verdictMap.set(v.id, v);
      if (includeMissedScan) missedAggregate.push(...verdict.missed);
    }

    this.recordIncomplete(
      ctx,
      unreviewed,
      "AI review did not complete (call failed, timed out, or returned an unusable response after retries)",
    );

    // When the audit failed but no verdicts were left unreviewed (the
    // additions-only case), the line above recorded nothing, so log the audit
    // gap explicitly. With reviewable changes, `unreviewed` already flagged this
    // subpath, so don't double-report it.
    if (missedScanFailed && unreviewed === 0) {
      this.incompleteReviews.push({
        packageName: ctx.packageName,
        reason:
          "missed-breaks audit did not complete (call failed, timed out, or returned an unusable response)",
        unreviewed: 0,
      });
    } else if (this.scanForMissed && auditTruncated && !missedScanFailed) {
      // The audit ran, but on a surface trimmed to fit the size budget, so a
      // break past the cap was never shown to the model. Record it as partial
      // coverage so the report doesn't imply a complete audit.
      this.incompleteReviews.push({
        packageName: ctx.packageName,
        reason:
          "missed-breaks audit surface was truncated to fit the size budget; any break past the cap was not scanned",
        unreviewed: 0,
      });
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

      // A downgrade (breaking -> non-breaking) is the only verdict that can
      // clear a flagged break, so it is the only risky one. Unless the caller
      // opted into applying downgrades, we do NOT apply it: the change stays
      // breaking and the model's opinion is recorded so a human can re-run with
      // --ai-apply-downgrades to relax it. Escalations (-> breaking) and
      // confirmations always apply. This makes the default path unable to hide
      // a real break.
      //
      // `unresolvableReference` is a deterministic, AI-proof guard: when the new
      // signature references a module specifier consumers can't resolve (an
      // export-blocked / internal-chunk dependency subpath), the change is
      // breaking regardless of structural shape, so the downgrade is refused
      // even under --ai-apply-downgrades. The model's suggestion is still
      // recorded; the reporter explains it can't be relaxed by that flag.
      const isDowngrade =
        change.type === ChangeType.BREAKING &&
        verdictType === ChangeType.NON_BREAKING;
      if (
        isDowngrade &&
        (!this.applyDowngrades || change.unresolvableReference)
      ) {
        enriched.push({
          ...change,
          aiAnalysis: {
            source: "ai-suggested-downgrade",
            confidence: clamp01(v.confidence),
            rationale: v.rationale,
            migration: undefined,
            model: this.model,
          },
        });
        continue;
      }

      // The mirror guard for deterministic downgrades: a repaired reference
      // (issue #98; every dropped specifier unconsumable, every introduced one
      // exported, signature otherwise identical) or an absorbing-arm union
      // (issue #114; the unchanged `string & {}`-style arm keeps the
      // assignable set identical) was verified mechanically, so a model
      // escalation cannot be adding information. Record the opinion without
      // applying it; the reporter explains why.
      const isEscalation =
        change.type === ChangeType.NON_BREAKING &&
        verdictType === ChangeType.BREAKING;
      if (
        isEscalation &&
        (change.repairedReference || change.absorbingArmUnion)
      ) {
        enriched.push({
          ...change,
          aiAnalysis: {
            source: "ai-suggested-escalation",
            confidence: clamp01(v.confidence),
            rationale: v.rationale,
            migration: undefined,
            model: this.model,
          },
        });
        continue;
      }

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
    otherChangesSummary: string,
    cacheSurface: boolean,
  ): Promise<AiVerdict | null> {
    const ruleListPayload = chunk.map((c) => ({
      id: c.id,
      type: c.type,
      category: c.category,
      name: c.name,
      description: c.description,
      // A change to a huge type (e.g. the 1907-line LocalizationResource) would
      // otherwise embed its full before AND after text here, dwarfing every
      // other call and blowing the request size. The model only needs the delta;
      // referenced type definitions ride in the surface block.
      beforeSnippet: capSnippet(c.beforeSnippet),
      afterSnippet: capSnippet(c.afterSnippet),
      // Deterministic exports-map verdicts for dropped/introduced specifiers
      // (rules 12/13), so the model never guesses resolvability from path
      // shapes. Only present when the specifier sets differ, so the common
      // change pays no tokens for them.
      ...(c.referenceResolutions
        ? { referenceResolutions: c.referenceResolutions }
        : {}),
      ...(c.repairedReference
        ? { repairedReference: c.repairedReference }
        : {}),
      ...(c.absorbingArmUnion
        ? { absorbingArmUnion: c.absorbingArmUnion }
        : {}),
    }));

    // Compact JSON (no indentation): this block is in the non-cached part of
    // the request, so every byte of pretty-print whitespace is paid on each
    // call.
    const parts: string[] = [
      `Package: ${ctx.packageName}`,
      "",
      "Rule-based changes to review (compact JSON, exactly one verdict required per id):",
      "```json",
      JSON.stringify(ruleListPayload),
      "```",
    ];

    if (includeMissedScan) {
      parts.push(
        "",
        "After verdicting those, compare the Baseline and Current API surfaces above and report under `missed` any consumer-observable breaking change the rule-based pass did NOT flag (a removed or renamed export, a changed signature, etc.). Be conservative: omit anything you are unsure about. Do not re-report a change already listed above" +
          (otherChangesSummary ? " or in the list below:" : "."),
      );
      if (otherChangesSummary) {
        parts.push("```", otherChangesSummary, "```");
      }
    } else {
      parts.push("", "Return an empty `missed` array.");
    }

    parts.push(
      "",
      `Return exactly ${chunk.length} verdict object(s), one per supplied id.`,
    );

    const userInstruction = parts.join("\n");

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
              // Only a cache breakpoint when more than one call reads it.
              ...(cacheSurface
                ? { cache_control: { type: "ephemeral" as const } }
                : {}),
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

  private warn(message: string): void {
    this.logger.warn(message);
  }

  /** Record a (package, subpath) review gap, unless nothing was left unreviewed. */
  private recordIncomplete(
    ctx: AiPackageContext,
    unreviewed: number,
    reason: string,
  ): void {
    if (unreviewed <= 0) return;
    this.incompleteReviews.push({
      packageName: ctx.packageName,
      reason,
      unreviewed,
    });
  }
}

/* -------------------------------------------------------------- helpers -- */

interface ExcerptToken {
  kind?: string;
  text: string;
  canonicalReference?: string;
}

interface ApiJsonMember {
  kind: string;
  name: string;
  canonicalReference?: string;
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
    // Canonicalize union/intersection order so the missed-breaks audit's own
    // surface diff does not re-flag a pure reorder (issue #85); applied to both
    // surfaces, so it is symmetric. Runs before the audit's size cap.
    const text = canonicalizeType(
      (m.excerptTokens ?? [])
        .map((t) => t.text)
        .join("")
        .replace(/\s+/g, " ")
        .trim(),
    );
    if (text) {
      lines.push(`${m.kind} ${qualified}: ${text}`);
    }
    for (const child of m.members ?? []) walk(child, qualified);
  };
  for (const m of json.members) walk(m);
  lines.sort();
  return lines.join("\n");
}

/**
 * Both full surfaces, used by the missed-breaks audit. To find a break the rule
 * pass didn't flag at all, the model has to diff old against new itself, so it
 * needs the baseline surface as well as the current one (the focused verdict
 * path, by contrast, gets each change's previous shape inline and only the
 * referenced type defs). The baseline is omitted only when there is none (a new
 * package), in which case the audit can inspect the current surface alone.
 */
function buildAuditSurfaceBlock(ctx: AiPackageContext): {
  text: string;
  truncated: boolean;
} {
  const rawCurrent = extractSurface(ctx.currentApiJsonPath);
  let rawBaseline = "";
  try {
    rawBaseline = extractSurface(ctx.baselineApiJsonPath);
  } catch {
    // No baseline (new package): the audit can only see the current surface.
  }
  // If either side overflowed the cap, the model couldn't see the whole surface,
  // so a break living past the cap is unscannable. Surface that as partial
  // coverage rather than letting the report imply a complete audit.
  const truncated =
    rawCurrent.length > MAX_AUDIT_SURFACE_CHARS ||
    rawBaseline.length > MAX_AUDIT_SURFACE_CHARS;
  const current = capSurfaceText(rawCurrent, MAX_AUDIT_SURFACE_CHARS);
  const baseline = rawBaseline
    ? capSurfaceText(rawBaseline, MAX_AUDIT_SURFACE_CHARS)
    : "";
  const parts = [`# API surface for ${ctx.packageName}`, ""];
  if (baseline) {
    parts.push("## Baseline", "```ts", baseline, "```", "");
  }
  parts.push("## Current", "```ts", current, "```");
  return { text: parts.join("\n"), truncated };
}

/**
 * Per-side character budget for the missed-breaks audit surfaces. Unlike the
 * focused verdict path (which only emits referenced type defs), the audit ships
 * whole baseline + current surfaces, so a large public API would otherwise
 * generate a multi-megabyte prompt and a request failure / cost spike. Capping
 * each side keeps the audit bounded; the elision marker tells the model the
 * surface is partial, and per system-prompt rule 8 unresolved surface fails safe
 * toward "breaking".
 */
const MAX_AUDIT_SURFACE_CHARS = 90_000;

/** Truncate a surface string to `max` chars on a line boundary, with a marker. */
function capSurfaceText(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const cut = head.lastIndexOf("\n");
  const kept = cut > 0 ? head.slice(0, cut) : head;
  const omitted = text.length - kept.length;
  return `${kept}\n/* ... surface truncated: ${omitted} more character${omitted === 1 ? "" : "s"} elided ... */`;
}

/** One node in the walked surface tree. */
interface SurfaceNode {
  qualified: string;
  kind: string;
  canonicalRef?: string;
  /** This member's own signature line ("" when it has no excerpt). */
  line: string;
  /** canonicalReferences named directly in this member's own excerpt. */
  ownRefs: string[];
  children: SurfaceNode[];
}

interface WalkedSurface {
  /** Every member keyed by its canonicalReference (resolves references). */
  byRef: Map<string, SurfaceNode>;
  /** Every member keyed by its parent-qualified name (seeds from changes). */
  byName: Map<string, SurfaceNode>;
  /** Every member, flat, for scanning referrers (includes ones without a ref). */
  allNodes: SurfaceNode[];
}

function normalizeExcerpt(tokens?: ExcerptToken[]): string {
  return canonicalizeType(
    (tokens ?? [])
      .map((t) => t.text)
      .join("")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

/**
 * Walk an api-extractor JSON into an indexed tree: each member carries its own
 * signature line, the canonicalReferences named in its excerpt, and its
 * children. Indexed by canonicalReference (to resolve a reference to its
 * definition) and by qualified name (to seed from a rule-based change).
 */
function walkSurface(apiJsonPath: string): WalkedSurface {
  const raw = fs.readFileSync(apiJsonPath, "utf-8");
  const json: ApiJsonRoot = JSON.parse(raw);
  const byRef = new Map<string, SurfaceNode>();
  const byName = new Map<string, SurfaceNode>();
  const allNodes: SurfaceNode[] = [];

  const build = (
    m: ApiJsonMember,
    parentQualified?: string,
    parentName?: string,
  ): SurfaceNode | null => {
    if (m.kind === "EntryPoint") {
      for (const child of m.members ?? [])
        build(child, parentQualified, parentName);
      return null;
    }
    const qualified = parentQualified ? `${parentQualified}.${m.name}` : m.name;
    const ownRefs: string[] = [];
    for (const t of m.excerptTokens ?? []) {
      if (t.kind === "Reference" && t.canonicalReference) {
        ownRefs.push(t.canonicalReference);
      }
    }
    const text = normalizeExcerpt(m.excerptTokens);
    const node: SurfaceNode = {
      qualified,
      kind: m.kind,
      canonicalRef: m.canonicalReference,
      line: text ? `${m.kind} ${qualified}: ${text}` : "",
      ownRefs,
      children: [],
    };
    allNodes.push(node);
    // The full-chain qualified name is authoritative, so it always wins. The
    // rule-based differ (api-diff.ts) names a member with its IMMEDIATE parent
    // only (`Inner.a`, not `Outer.Inner.a` for a namespace-nested member), so
    // also register that alias to seed the focused closure from such a change.
    // Don't let an alias clobber a real full-chain entry.
    byName.set(qualified, node);
    const diffName = parentName ? `${parentName}.${m.name}` : m.name;
    if (!byName.has(diffName)) byName.set(diffName, node);
    if (m.canonicalReference) byRef.set(m.canonicalReference, node);
    for (const child of m.members ?? []) {
      const c = build(child, qualified, m.name);
      if (c) node.children.push(c);
    }
    return node;
  };

  for (const m of json.members) build(m);
  return { byRef, byName, allNodes };
}

/**
 * Memoized `walkSurface`, keyed by path + mtime. The usage-site pass walks the
 * same sibling surfaces once per subpath under review, so without a cache a
 * package with N subpaths would parse each `.api.json` up to N times. Keying on
 * mtime keeps it correct if a path is rewritten (e.g. across test runs that
 * reuse a temp path).
 */
const walkCache = new Map<
  string,
  { mtimeMs: number; surface: WalkedSurface }
>();

function walkSurfaceCached(apiJsonPath: string): WalkedSurface {
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(apiJsonPath).mtimeMs;
  } catch {
    // Missing/unreadable: fall through so walkSurface throws a readable error
    // (callers that can tolerate it, like sibling scans, wrap this in try/catch).
  }
  const cached = walkCache.get(apiJsonPath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.surface;
  const surface = walkSurface(apiJsonPath);
  walkCache.set(apiJsonPath, { mtimeMs, surface });
  return surface;
}

function subtreeLines(node: SurfaceNode): string[] {
  const out: string[] = [];
  const visit = (n: SurfaceNode): void => {
    if (n.line) out.push(n.line);
    for (const c of n.children) visit(c);
  };
  visit(node);
  return out;
}

function collectSubtreeRefs(node: SurfaceNode, acc: Set<string>): void {
  for (const r of node.ownRefs) acc.add(r);
  for (const c of node.children) collectSubtreeRefs(c, acc);
}

/**
 * Cap the breadth of the referenced-type closure so a pathological change (a
 * type that transitively touches half the package) can't reinflate the prompt.
 * Hitting the cap just means the model sees fewer definitions and, per
 * system-prompt rule 8, keeps "breaking" where it can't resolve: the safe side.
 */
const MAX_FOCUSED_SYMBOLS = 200;

/**
 * Per-snippet and per-symbol line caps, plus an overall focused-surface char
 * budget. `MAX_FOCUSED_SYMBOLS` bounds the symbol *count*, which a single
 * enormous type (the 1907-line LocalizationResource) defeats, so the request
 * still needs a size bound. Hitting any cap just elides text and, per
 * system-prompt rule 8, the model keeps "breaking" where it can't resolve: the
 * safe side.
 */
const MAX_SNIPPET_LINES = 80;
const MAX_FOCUSED_SYMBOL_LINES = 200;
const MAX_FOCUSED_SURFACE_CHARS = 60_000;

/**
 * Keep a head and tail of a multi-line snippet/definition with an elision
 * marker when it exceeds `maxLines`. Used to bound both the before/after text in
 * the rule list and each referenced-type definition in the focused surface.
 */
function capSnippet(
  text: string | undefined,
  maxLines: number = MAX_SNIPPET_LINES,
): string | undefined {
  if (text === undefined) return undefined;
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  const half = Math.max(1, Math.floor(maxLines / 2));
  const head = lines.slice(0, half);
  const tail = lines.slice(lines.length - half);
  const elided = lines.length - head.length - tail.length;
  return [
    ...head,
    `/* ... ${elided} line${elided === 1 ? "" : "s"} elided ... */`,
    ...tail,
  ].join("\n");
}

/**
 * Focused verdict context: for the changes under review, the definitions of the
 * types their signatures reference (transitively), from the current surface,
 * plus the baseline definition of any referenced type that itself changed so a
 * downgrade can be judged against old-vs-new. Everything else is omitted. The
 * changed members are not re-emitted; their before/after signatures already
 * ride inline in the review list.
 */
function buildFocusedSurfaceBlock(
  ctx: AiPackageContext,
  changes: ApiChange[],
): string {
  const current = walkSurfaceCached(ctx.currentApiJsonPath);
  let baseline: WalkedSurface = {
    byRef: new Map(),
    byName: new Map(),
    allNodes: [],
  };
  try {
    baseline = walkSurfaceCached(ctx.baselineApiJsonPath);
  } catch {
    // New package or unreadable baseline: focus on the current side only.
  }

  // Seed with the references named directly in each changed member's signature,
  // on BOTH sides: a changed signature may reference a type in its old form
  // that the new form drops (and vice versa), and a downgrade needs to see both.
  const queue: string[] = [];
  for (const change of changes) {
    const cur = current.byName.get(change.name);
    const base = baseline.byName.get(change.name);
    if (cur) queue.push(...cur.ownRefs);
    if (base) queue.push(...base.ownRefs);
  }

  // BFS over referenced symbols, pulling in each one's transitive refs.
  const visited = new Set<string>();
  while (queue.length > 0 && visited.size < MAX_FOCUSED_SYMBOLS) {
    const ref = queue.shift() as string;
    if (visited.has(ref)) continue;
    const curNode = current.byRef.get(ref);
    const baseNode = baseline.byRef.get(ref);
    if (!curNode && !baseNode) continue; // external / unresolvable: skip
    visited.add(ref);
    const refs = new Set<string>();
    if (curNode) collectSubtreeRefs(curNode, refs);
    if (baseNode) collectSubtreeRefs(baseNode, refs);
    for (const r of refs) if (!visited.has(r)) queue.push(r);
  }
  const truncated = visited.size >= MAX_FOCUSED_SYMBOLS && queue.length > 0;

  // Emit each referenced type's current definition, and its baseline definition
  // when it changed (that delta is exactly what a downgrade hinges on).
  const blocks: { name: string; text: string }[] = [];
  for (const ref of visited) {
    const curNode = current.byRef.get(ref);
    const baseNode = baseline.byRef.get(ref);
    const curDef = curNode
      ? (capSnippet(
          subtreeLines(curNode).join("\n"),
          MAX_FOCUSED_SYMBOL_LINES,
        ) ?? "")
      : "";
    const baseDef = baseNode
      ? (capSnippet(
          subtreeLines(baseNode).join("\n"),
          MAX_FOCUSED_SYMBOL_LINES,
        ) ?? "")
      : "";
    const parts: string[] = [];
    if (curDef) parts.push(curDef);
    if (baseDef && baseDef !== curDef) parts.push(`// previously:\n${baseDef}`);
    if (parts.length > 0) {
      blocks.push({
        name: curNode?.qualified ?? baseNode?.qualified ?? ref,
        text: parts.join("\n"),
      });
    }
  }
  blocks.sort((a, b) => a.name.localeCompare(b.name));

  // Usage sites: where each changed NAMED type is referenced across the package.
  // Direction (input vs output) can't be read from a type's own definition, so
  // its referrers are surfaced from the current surface plus the sibling subpath
  // surfaces (the changed type and its usage sites often live in different
  // rollups). This only ever helps the model relax a verdict; it is told to keep
  // "breaking" when no usage sites are shown, so missing referrers fail safe.
  const usageSites = collectUsageSites(ctx, changes, current);

  const header = [
    `# Referenced type definitions for ${ctx.packageName}`,
    "(Only the types the changes under review reference. The previous signature of each change is in its beforeSnippet; `// previously:` shows a referenced type's baseline definition where it changed.)",
  ];
  if (blocks.length === 0 && usageSites.length === 0) {
    header.push(
      "(none: the changes reference no named package types; judge from the before/after snippets.)",
    );
    return header.join("\n");
  }

  const out = [...header];
  if (blocks.length > 0) {
    // Keep definitions until the overall char budget is reached so a handful of
    // large types can't reinflate the prompt past the per-symbol line cap.
    const kept: string[] = [];
    let used = 0;
    for (const b of blocks) {
      if (kept.length > 0 && used + b.text.length > MAX_FOCUSED_SURFACE_CHARS) {
        break;
      }
      kept.push(b.text);
      used += b.text.length + 2;
    }
    const droppedBlocks = blocks.length - kept.length;
    out.push("```ts", kept.join("\n\n"), "```");
    if (truncated || droppedBlocks > 0) {
      const reasons: string[] = [];
      if (truncated) reasons.push(`${MAX_FOCUSED_SYMBOLS} symbols`);
      if (droppedBlocks > 0) reasons.push(`${droppedBlocks} large definitions`);
      out.push(
        `(referenced-type context truncated at ${reasons.join(" and ")}.)`,
      );
    }
  }
  if (usageSites.length > 0) {
    out.push(
      "",
      "## Usage sites",
      "(Where each changed type is referenced in the current package surface, to judge input vs output direction. A `Promise<T>` result, a function return, or a result field is output; a parameter or input field is input.)",
      "```ts",
    );
    for (const group of usageSites) {
      out.push(`// ${group.typeName}:`);
      for (const line of group.lines) out.push(line);
      if (group.truncated) {
        out.push(`// ... more usage sites of ${group.typeName} elided ...`);
      }
    }
    out.push("```");
  }
  return out.join("\n");
}

/** Per-type usage-site listing for the focused context's "Usage sites" block. */
interface UsageGroup {
  typeName: string;
  lines: string[];
  truncated: boolean;
}

const MAX_USAGE_SITES_PER_TYPE = 25;
const MAX_USAGE_SITES_TOTAL = 60;

/**
 * For each changed type that resolves to a named symbol, collect the signature
 * lines of the members that reference it (its usage sites) across the current
 * surface and any sibling subpath surfaces. Matched by canonicalReference, which
 * is stable across a package's subpath rollups; an unresolvable/diverging ref
 * just yields fewer usage sites, which fails safe (the model keeps "breaking"
 * when direction is unclear). Bounded per-type and overall so a widely-used type
 * can't reinflate the prompt.
 */
function collectUsageSites(
  ctx: AiPackageContext,
  changes: ApiChange[],
  current: WalkedSurface,
): UsageGroup[] {
  // canonicalReference -> display name, for each changed symbol that has one.
  const targets = new Map<string, string>();
  for (const change of changes) {
    const node = current.byName.get(change.name);
    if (node?.canonicalRef && !targets.has(node.canonicalRef)) {
      targets.set(node.canonicalRef, node.qualified || change.name);
    }
  }
  if (targets.size === 0) return [];

  const surfaces: WalkedSurface[] = [current];
  for (const siblingPath of ctx.siblingCurrentApiJsonPaths ?? []) {
    try {
      surfaces.push(walkSurfaceCached(siblingPath));
    } catch {
      // Unreadable sibling: skip. Fewer usage sites just means more caution.
    }
  }

  const linesByTarget = new Map<string, Set<string>>();
  for (const ref of targets.keys()) linesByTarget.set(ref, new Set());
  for (const surface of surfaces) {
    for (const node of surface.allNodes) {
      if (!node.line) continue;
      for (const ref of node.ownRefs) {
        // A type referencing itself (recursive shape) is not a usage site.
        if (node.canonicalRef === ref) continue;
        linesByTarget.get(ref)?.add(node.line);
      }
    }
  }

  const groups: UsageGroup[] = [];
  let total = 0;
  for (const [ref, typeName] of targets) {
    if (total >= MAX_USAGE_SITES_TOTAL) break;
    const all = Array.from(linesByTarget.get(ref) ?? []).sort();
    if (all.length === 0) continue;
    const budget = Math.min(
      MAX_USAGE_SITES_PER_TYPE,
      MAX_USAGE_SITES_TOTAL - total,
    );
    const lines = all.slice(0, budget);
    total += lines.length;
    groups.push({ typeName, lines, truncated: lines.length < all.length });
  }
  return groups;
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
