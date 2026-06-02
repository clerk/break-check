import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { AiChangeAnalyzer } from "../dist/analyzers/ai-analyzer.js";
import { ChangeSeverity, ChangeType } from "../dist/types.js";

const SILENT_LOGGER = { warn: () => {}, log: () => {} };

function writeApiJson(filePath, members) {
  const apiJson = {
    metadata: { toolPackage: "test", toolVersion: "0" },
    kind: "Package",
    name: "@demo/pkg",
    members: [
      {
        kind: "EntryPoint",
        name: "",
        members,
      },
    ],
  };
  writeFileSync(filePath, JSON.stringify(apiJson));
}

function makeWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), "break-check-ai-"));
  mkdirSync(dir, { recursive: true });
  const baseline = join(dir, "baseline.api.json");
  const current = join(dir, "current.api.json");
  writeApiJson(baseline, [
    {
      kind: "Function",
      name: "greet",
      excerptTokens: [
        { text: "export declare function greet(name: string): string;" },
      ],
    },
  ]);
  writeApiJson(current, [
    {
      kind: "Function",
      name: "greet",
      excerptTokens: [
        { text: "export declare function greet(name: string): number;" },
      ],
    },
  ]);
  return { dir, baseline, current };
}

function ruleBasedBreakingChange(id = "abc123") {
  return {
    id,
    type: ChangeType.BREAKING,
    severity: ChangeSeverity.MAJOR,
    category: "function",
    name: "greet",
    description: "Return type changed: `string` -> `number`",
    beforeSnippet: "export declare function greet(name: string): string;",
    afterSnippet: "export declare function greet(name: string): number;",
  };
}

function stubClient(verdict) {
  const calls = [];
  const client = {
    messages: {
      async create(params) {
        calls.push(params);
        return {
          content: [
            { type: "tool_use", name: "submit_review", input: verdict },
          ],
          usage: {
            input_tokens: 100,
            output_tokens: 50,
          },
        };
      },
    },
  };
  return { client, calls };
}

test("ai-analyzer: AI confirms rule-based verdict", async () => {
  const { dir, baseline, current } = makeWorkspace();
  const change = ruleBasedBreakingChange();
  const { client, calls } = stubClient({
    verdicts: [
      {
        id: change.id,
        type: ChangeType.BREAKING,
        confidence: 0.9,
        rationale: "Return type narrowed.",
        migration: "Cast or update callers.",
      },
    ],
    missed: [],
  });
  const analyzer = new AiChangeAnalyzer({
    apiKey: "test-key",
    client,
    logger: SILENT_LOGGER,
  });

  try {
    const result = await analyzer.analyze([change], {
      packageName: "@demo/pkg",
      baselineApiJsonPath: baseline,
      currentApiJsonPath: current,
    });

    assert.equal(result.length, 1);
    assert.equal(result[0].type, ChangeType.BREAKING);
    assert.equal(result[0].ruleBasedType, undefined);
    assert.equal(result[0].aiAnalysis.source, "rule-confirmed");
    assert.equal(result[0].aiAnalysis.confidence, 0.9);
    assert.equal(result[0].aiAnalysis.migration, "Cast or update callers.");
    assert.equal(analyzer.reviewedCount, 1);
    assert.equal(analyzer.overriddenCount, 0);
    assert.equal(analyzer.discoveredCount, 0);
    assert.equal(calls.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ai-analyzer: AI overrides BREAKING -> NON_BREAKING", async () => {
  const { dir, baseline, current } = makeWorkspace();
  const change = ruleBasedBreakingChange();
  const { client } = stubClient({
    verdicts: [
      {
        id: change.id,
        type: ChangeType.NON_BREAKING,
        confidence: 0.85,
        rationale: "Aliases resolve to the same shape.",
      },
    ],
    missed: [],
  });
  const analyzer = new AiChangeAnalyzer({
    apiKey: "test-key",
    client,
    logger: SILENT_LOGGER,
  });

  try {
    const [result] = await analyzer.analyze([change], {
      packageName: "@demo/pkg",
      baselineApiJsonPath: baseline,
      currentApiJsonPath: current,
    });

    assert.equal(result.type, ChangeType.NON_BREAKING);
    assert.equal(result.severity, ChangeSeverity.MINOR);
    assert.equal(result.ruleBasedType, ChangeType.BREAKING);
    assert.equal(result.aiAnalysis.source, "rule-overridden");
    assert.equal(result.aiAnalysis.migration, undefined);
    assert.equal(analyzer.overriddenCount, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ai-analyzer: AI escalates NON_BREAKING -> BREAKING", async () => {
  const { dir, baseline, current } = makeWorkspace();
  const change = {
    ...ruleBasedBreakingChange("nb1"),
    type: ChangeType.NON_BREAKING,
    severity: ChangeSeverity.MINOR,
  };
  const { client } = stubClient({
    verdicts: [
      {
        id: change.id,
        type: ChangeType.BREAKING,
        confidence: 0.7,
        rationale: "Discriminator value changed.",
        migration: "Update switch cases.",
      },
    ],
    missed: [],
  });
  const analyzer = new AiChangeAnalyzer({
    apiKey: "test-key",
    client,
    logger: SILENT_LOGGER,
  });

  try {
    const [result] = await analyzer.analyze([change], {
      packageName: "@demo/pkg",
      baselineApiJsonPath: baseline,
      currentApiJsonPath: current,
    });

    assert.equal(result.type, ChangeType.BREAKING);
    assert.equal(result.severity, ChangeSeverity.MAJOR);
    assert.equal(result.ruleBasedType, ChangeType.NON_BREAKING);
    assert.equal(result.aiAnalysis.source, "rule-overridden");
    assert.equal(result.aiAnalysis.migration, "Update switch cases.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ai-analyzer: AI discovers a missed break (scanForMissed)", async () => {
  const { dir, baseline, current } = makeWorkspace();
  const { client } = stubClient({
    verdicts: [],
    missed: [
      {
        type: ChangeType.BREAKING,
        category: "interface",
        name: "Config.timeout",
        description: "Required field added to Config.",
        rationale: "New required input field breaks callers.",
        migration: "Pass `timeout` when constructing Config.",
        confidence: 0.95,
        afterSnippet: "interface Config { timeout: number; }",
      },
    ],
  });
  // The missed-breaks scan is opt-in; without it an empty change list makes no
  // call at all (see the dedicated test below).
  const analyzer = new AiChangeAnalyzer({
    apiKey: "test-key",
    client,
    scanForMissed: true,
    logger: SILENT_LOGGER,
  });

  try {
    const result = await analyzer.analyze([], {
      packageName: "@demo/pkg",
      baselineApiJsonPath: baseline,
      currentApiJsonPath: current,
    });

    assert.equal(result.length, 1);
    const [discovered] = result;
    assert.equal(discovered.type, ChangeType.BREAKING);
    assert.equal(discovered.aiAnalysis.source, "ai-discovered");
    assert.equal(discovered.name, "Config.timeout");
    assert.ok(discovered.id, "AI-discovered change should have an id");
    assert.equal(analyzer.discoveredCount, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ai-analyzer: SDK failure falls back to rule-based", async () => {
  const { dir, baseline, current } = makeWorkspace();
  const change = ruleBasedBreakingChange();
  const warnings = [];
  const client = {
    messages: {
      async create() {
        throw new Error("boom");
      },
    },
  };
  const analyzer = new AiChangeAnalyzer({
    apiKey: "test-key",
    client,
    logger: {
      warn: (m) => warnings.push(m),
      log: () => {},
    },
  });

  try {
    const result = await analyzer.analyze([change], {
      packageName: "@demo/pkg",
      baselineApiJsonPath: baseline,
      currentApiJsonPath: current,
    });

    assert.equal(result.length, 1);
    assert.equal(result[0].type, ChangeType.BREAKING);
    assert.equal(result[0].aiAnalysis, undefined);
    assert.equal(result[0].ruleBasedType, undefined);
    assert.ok(warnings.some((w) => w.includes("boom")));
    assert.equal(analyzer.reviewedCount, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ai-analyzer: verdict for unknown id is ignored", async () => {
  const { dir, baseline, current } = makeWorkspace();
  const change = ruleBasedBreakingChange("real");
  const { client } = stubClient({
    verdicts: [
      {
        id: "ghost",
        type: ChangeType.NON_BREAKING,
        confidence: 0.5,
        rationale: "made up",
      },
    ],
    missed: [],
  });
  const analyzer = new AiChangeAnalyzer({
    apiKey: "test-key",
    client,
    logger: SILENT_LOGGER,
  });

  try {
    const [result] = await analyzer.analyze([change], {
      packageName: "@demo/pkg",
      baselineApiJsonPath: baseline,
      currentApiJsonPath: current,
    });

    assert.equal(result.type, ChangeType.BREAKING);
    assert.equal(result.aiAnalysis, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ai-analyzer: ADDITION changes pass through without a verdict needed", async () => {
  const { dir, baseline, current } = makeWorkspace();
  const change = {
    id: "add1",
    type: ChangeType.ADDITION,
    severity: ChangeSeverity.MINOR,
    category: "function",
    name: "newThing",
    description: "Added function newThing",
    afterSnippet: "export declare function newThing(): void;",
  };
  const { client, calls } = stubClient({ verdicts: [], missed: [] });
  const analyzer = new AiChangeAnalyzer({
    apiKey: "test-key",
    client,
    logger: SILENT_LOGGER,
  });

  try {
    const result = await analyzer.analyze([change], {
      packageName: "@demo/pkg",
      baselineApiJsonPath: baseline,
      currentApiJsonPath: current,
    });

    assert.equal(result.length, 1);
    assert.equal(result[0].type, ChangeType.ADDITION);
    assert.equal(result[0].aiAnalysis, undefined);
    // Lean default: nothing to re-classify and no scan requested, so we spend
    // zero API calls on an additions-only diff.
    assert.equal(calls.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ai-analyzer: additions-only still calls once under scanForMissed", async () => {
  const { dir, baseline, current } = makeWorkspace();
  const change = {
    id: "add1",
    type: ChangeType.ADDITION,
    severity: ChangeSeverity.MINOR,
    category: "function",
    name: "newThing",
    description: "Added function newThing",
    afterSnippet: "export declare function newThing(): void;",
  };
  const { client, calls } = stubClient({ verdicts: [], missed: [] });
  const analyzer = new AiChangeAnalyzer({
    apiKey: "test-key",
    client,
    scanForMissed: true,
    logger: SILENT_LOGGER,
  });

  try {
    const result = await analyzer.analyze([change], {
      packageName: "@demo/pkg",
      baselineApiJsonPath: baseline,
      currentApiJsonPath: current,
    });

    assert.equal(result.length, 1);
    assert.equal(result[0].type, ChangeType.ADDITION);
    // Thorough mode issues the scan call even with nothing to re-classify.
    assert.equal(calls.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ai-analyzer: lean path ships the current surface only, no missed scan", async () => {
  const { dir, baseline, current } = makeWorkspace();
  const change = ruleBasedBreakingChange();
  const { client, calls } = stubClient({
    verdicts: [
      {
        id: change.id,
        type: ChangeType.BREAKING,
        confidence: 0.9,
        rationale: "Return type narrowed.",
        migration: "Update callers.",
      },
    ],
    missed: [],
  });
  const analyzer = new AiChangeAnalyzer({
    apiKey: "test-key",
    client,
    logger: SILENT_LOGGER,
  });

  try {
    await analyzer.analyze([change], {
      packageName: "@demo/pkg",
      baselineApiJsonPath: baseline,
      currentApiJsonPath: current,
    });

    assert.equal(calls.length, 1);
    const [surfaceBlock, instruction] = calls[0].messages[0].content;
    // No baseline dump: the previous shape rides along in beforeSnippet.
    assert.ok(
      !surfaceBlock.text.includes("## Baseline"),
      "lean path must not ship the baseline surface dump",
    );
    assert.ok(surfaceBlock.text.includes("Current API surface"));
    // Single call: no cache breakpoint to amortize.
    assert.equal(surfaceBlock.cache_control, undefined);
    // Verdict-only: the model is told to return an empty missed array.
    assert.ok(instruction.text.includes("empty `missed`"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ai-analyzer: scanForMissed ships both surfaces and requests the scan", async () => {
  const { dir, baseline, current } = makeWorkspace();
  const change = ruleBasedBreakingChange();
  const { client, calls } = stubClient({
    verdicts: [
      {
        id: change.id,
        type: ChangeType.BREAKING,
        confidence: 0.9,
        rationale: "Return type narrowed.",
        migration: "Update callers.",
      },
    ],
    missed: [],
  });
  const analyzer = new AiChangeAnalyzer({
    apiKey: "test-key",
    client,
    scanForMissed: true,
    logger: SILENT_LOGGER,
  });

  try {
    await analyzer.analyze([change], {
      packageName: "@demo/pkg",
      baselineApiJsonPath: baseline,
      currentApiJsonPath: current,
    });

    const [surfaceBlock, instruction] = calls[0].messages[0].content;
    assert.ok(surfaceBlock.text.includes("## Baseline"));
    assert.ok(surfaceBlock.text.includes("## Current"));
    assert.ok(instruction.text.toLowerCase().includes("scan the current api"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ai-analyzer: coerces bogus ADDITION verdict on an in-place change to NON_BREAKING", async () => {
  const { dir, baseline, current } = makeWorkspace();
  const change = ruleBasedBreakingChange();
  const warnings = [];
  const { client } = stubClient({
    verdicts: [
      {
        id: change.id,
        type: ChangeType.ADDITION,
        confidence: 0.6,
        rationale: "Type widened, treating as additive.",
      },
    ],
    missed: [],
  });
  const analyzer = new AiChangeAnalyzer({
    apiKey: "test-key",
    client,
    logger: {
      warn: (m) => warnings.push(m),
      log: () => {},
    },
  });

  try {
    const [result] = await analyzer.analyze([change], {
      packageName: "@demo/pkg",
      baselineApiJsonPath: baseline,
      currentApiJsonPath: current,
    });

    // ADDITION is reserved for brand-new exports; the model violated the
    // protocol on an in-place modification, so we coerce to NON_BREAKING.
    assert.equal(result.type, ChangeType.NON_BREAKING);
    assert.equal(result.severity, ChangeSeverity.MINOR);
    assert.equal(result.ruleBasedType, ChangeType.BREAKING);
    assert.equal(result.aiAnalysis.source, "rule-overridden");
    assert.ok(
      warnings.some((w) => w.includes("addition")),
      `expected warning about bogus 'addition' verdict, got: ${warnings.join(" | ")}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ai-analyzer: chunks large change lists across multiple calls", async () => {
  const { dir, baseline, current } = makeWorkspace();
  const changes = Array.from({ length: 5 }, (_, i) => ({
    ...ruleBasedBreakingChange(`id${i}`),
  }));

  const calls = [];
  const client = {
    messages: {
      async create(params) {
        calls.push(params);
        // Echo back a "rule-confirmed" verdict for each id in the chunk.
        const userText = params.messages[0].content[1].text;
        const matches = [...userText.matchAll(/"id":\s*"(id\d)"/g)].map(
          (m) => m[1],
        );
        return {
          content: [
            {
              type: "tool_use",
              name: "submit_review",
              input: {
                verdicts: matches.map((id) => ({
                  id,
                  type: ChangeType.BREAKING,
                  confidence: 0.9,
                  rationale: "ok",
                  migration: "update callers",
                })),
                missed: [],
              },
            },
          ],
        };
      },
    },
  };

  const analyzer = new AiChangeAnalyzer({
    apiKey: "test-key",
    client,
    maxChangesPerCall: 2,
    logger: SILENT_LOGGER,
  });

  try {
    const result = await analyzer.analyze(changes, {
      packageName: "@demo/pkg",
      baselineApiJsonPath: baseline,
      currentApiJsonPath: current,
    });

    assert.equal(result.length, 5);
    assert.ok(result.every((c) => c.aiAnalysis?.source === "rule-confirmed"));
    // ceil(5/2) = 3 calls
    assert.equal(calls.length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
