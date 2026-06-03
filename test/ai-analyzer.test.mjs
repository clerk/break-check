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

test("ai-analyzer: applyDowngrades applies a BREAKING -> NON_BREAKING downgrade", async () => {
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
    applyDowngrades: true,
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

test("ai-analyzer: lean mode records a suggested downgrade but keeps it breaking", async () => {
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

    // The lean default must NOT clear a flagged break, even when the model
    // says non-breaking. The change stays breaking; the suggestion is recorded.
    assert.equal(result.type, ChangeType.BREAKING);
    assert.equal(result.severity, ChangeSeverity.MAJOR);
    assert.equal(result.aiAnalysis.source, "ai-suggested-downgrade");
    assert.equal(
      result.aiAnalysis.rationale,
      "Aliases resolve to the same shape.",
    );
    assert.equal(result.ruleBasedType, undefined);
    assert.equal(analyzer.reviewedCount, 1);
    assert.equal(analyzer.overriddenCount, 0);
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
  // The missed-breaks audit is opt-in (scanForMissed); without it an empty
  // change list makes no call at all (see the dedicated test below).
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
    // The gap is now recorded so the report can flag partial coverage.
    assert.equal(analyzer.incompleteReviews.length, 1);
    assert.equal(analyzer.incompleteReviews[0].unreviewed, 1);
    assert.equal(analyzer.incompleteReviews[0].packageName, "@demo/pkg");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ai-analyzer: oversized before/after snippets are capped before send", async () => {
  const { dir, baseline, current } = makeWorkspace();
  const huge = Array.from({ length: 1000 }, (_, i) => `  field${i}: string;`);
  const change = {
    ...ruleBasedBreakingChange(),
    beforeSnippet: `type Big = {\n${huge.join("\n")}\n};`,
    afterSnippet: `type Big = {\n${huge.join("\n")}\n  added?: string;\n};`,
  };
  const { client, calls } = stubClient({
    verdicts: [
      {
        id: change.id,
        type: ChangeType.BREAKING,
        confidence: 0.9,
        rationale: "x",
        migration: "y",
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
    // The rule list rides in the second user content block as compact JSON.
    const payloadText = calls[0].messages[0].content[1].text;
    assert.ok(
      payloadText.includes("lines elided"),
      "expected the huge snippet to be elided",
    );
    // The 1000-line wall must not be sent verbatim: the elided middle is gone.
    assert.ok(
      !payloadText.includes("field500"),
      "expected the middle of the huge snippet to be dropped",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ai-analyzer: a failed multi-change chunk splits and retries", async () => {
  const { dir, baseline, current } = makeWorkspace();
  const changeA = ruleBasedBreakingChange("id-a");
  const changeB = { ...ruleBasedBreakingChange("id-b"), name: "greet2" };
  const warnings = [];
  const calls = [];
  // Fails when more than one change is in the call; succeeds for a single one.
  const client = {
    messages: {
      async create(params) {
        calls.push(params);
        const text = params.messages[0].content[1].text;
        const ids = [...text.matchAll(/"id":"([^"]+)"/g)].map((m) => m[1]);
        if (ids.length > 1) throw new Error("request too large");
        return {
          content: [
            {
              type: "tool_use",
              name: "submit_review",
              input: {
                verdicts: ids.map((id) => ({
                  id,
                  type: ChangeType.NON_BREAKING,
                  confidence: 0.95,
                  rationale: "internal rename",
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
    applyDowngrades: true,
    logger: { warn: (m) => warnings.push(m), log: () => {} },
  });

  try {
    const result = await analyzer.analyze([changeA, changeB], {
      packageName: "@demo/pkg",
      baselineApiJsonPath: baseline,
      currentApiJsonPath: current,
    });

    // Both changes were reviewed via the retry split; nothing left unreviewed.
    assert.equal(result.length, 2);
    for (const c of result) {
      assert.equal(c.type, ChangeType.NON_BREAKING);
      assert.equal(c.aiAnalysis.source, "rule-overridden");
    }
    assert.equal(analyzer.incompleteReviews.length, 0);
    // One failed batch of 2, then two successful singles.
    assert.equal(calls.length, 3);
    assert.ok(warnings.some((w) => w.includes("retrying as two smaller")));
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

test("ai-analyzer: lean path ships the focused context, no missed scan", async () => {
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
    // Focused, not the full surface dump: the default ships only referenced
    // type defs (here none, since greet's signature is primitives only).
    assert.ok(surfaceBlock.text.includes("Referenced type definitions"));
    assert.ok(!surfaceBlock.text.includes("Current API surface"));
    // Single call: no cache breakpoint to amortize.
    assert.equal(surfaceBlock.cache_control, undefined);
    // Verdict-only: the model is told to return an empty missed array.
    assert.ok(instruction.text.includes("empty `missed`"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ai-analyzer: scanForMissed sends both surfaces and requests the audit", async () => {
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
    // The audit must diff old vs new, so it ships BOTH surfaces, not the
    // focused referenced-type set.
    assert.ok(surfaceBlock.text.includes("## Baseline"));
    assert.ok(surfaceBlock.text.includes("## Current"));
    // Both signatures are present so the model can spot an unflagged break.
    assert.ok(
      surfaceBlock.text.includes("string"),
      "baseline (old) signature must be present",
    );
    assert.ok(
      surfaceBlock.text.includes("number"),
      "current (new) signature must be present",
    );
    assert.ok(
      instruction.text.toLowerCase().includes("baseline and current"),
      "audit instruction should ask the model to compare both surfaces",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- focused-context resolution (needs real Reference tokens) ---

const C = (text) => ({ kind: "Content", text });
const R = (text, canonicalReference) => ({
  kind: "Reference",
  text,
  canonicalReference,
});
const iface = (name, props) => ({
  kind: "Interface",
  name,
  canonicalReference: `@demo/pkg!${name}:interface`,
  excerptTokens: [C(`export interface ${name} `)],
  members: props,
});
const prop = (parent, name, typeTokens) => ({
  kind: "PropertySignature",
  name,
  canonicalReference: `@demo/pkg!${parent}#${name}`,
  excerptTokens: [C(`${name}: `), ...typeTokens, C(";")],
});

// Capture the surface text the analyzer sends for a single function change.
async function focusedSurfaceFor(members, changeName) {
  const dir = mkdtempSync(join(tmpdir(), "break-check-focus-"));
  const baseline = join(dir, "baseline.api.json");
  const current = join(dir, "current.api.json");
  writeApiJson(baseline, members);
  writeApiJson(current, members);
  let surfaceText = "";
  const client = {
    messages: {
      async create(params) {
        surfaceText = params.messages[0].content[0].text;
        return {
          content: [
            {
              type: "tool_use",
              name: "submit_review",
              input: {
                verdicts: [
                  {
                    id: "c1",
                    type: "breaking",
                    confidence: 0.9,
                    rationale: "x",
                  },
                ],
                missed: [],
              },
            },
          ],
        };
      },
    },
  };
  const analyzer = new AiChangeAnalyzer({
    apiKey: "k",
    client,
    logger: SILENT_LOGGER,
  });
  try {
    await analyzer.analyze(
      [
        {
          id: "c1",
          type: ChangeType.BREAKING,
          severity: ChangeSeverity.MAJOR,
          category: "function",
          name: changeName,
          description: "changed",
          beforeSnippet: "x",
          afterSnippet: "y",
        },
      ],
      {
        packageName: "@demo/pkg",
        baselineApiJsonPath: baseline,
        currentApiJsonPath: current,
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return surfaceText;
}

// Like focusedSurfaceFor, but also writes a sibling subpath surface and threads
// it through as siblingCurrentApiJsonPaths so usage-site (referrer) resolution
// can reach across subpath rollups.
async function focusedSurfaceWithSiblings(members, changeName, siblingMembers) {
  const dir = mkdtempSync(join(tmpdir(), "break-check-usage-"));
  const baseline = join(dir, "baseline.api.json");
  const current = join(dir, "current.api.json");
  const sibling = join(dir, "sibling.api.json");
  writeApiJson(baseline, members);
  writeApiJson(current, members);
  writeApiJson(sibling, siblingMembers);
  let surfaceText = "";
  const client = {
    messages: {
      async create(params) {
        surfaceText = params.messages[0].content[0].text;
        return {
          content: [
            {
              type: "tool_use",
              name: "submit_review",
              input: {
                verdicts: [
                  {
                    id: "c1",
                    type: "breaking",
                    confidence: 0.9,
                    rationale: "x",
                  },
                ],
                missed: [],
              },
            },
          ],
        };
      },
    },
  };
  const analyzer = new AiChangeAnalyzer({
    apiKey: "k",
    client,
    logger: SILENT_LOGGER,
  });
  try {
    await analyzer.analyze(
      [
        {
          id: "c1",
          type: ChangeType.BREAKING,
          severity: ChangeSeverity.MAJOR,
          category: "type",
          name: changeName,
          description: "changed",
          beforeSnippet: "x",
          afterSnippet: "y",
        },
      ],
      {
        packageName: "@demo/pkg",
        baselineApiJsonPath: baseline,
        currentApiJsonPath: current,
        siblingCurrentApiJsonPaths: [sibling],
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return surfaceText;
}

test("ai-analyzer: focused context includes referenced types, excludes unrelated", async () => {
  const members = [
    iface("Opts", [prop("Opts", "a", [C("string")])]),
    {
      kind: "TypeAlias",
      name: "Id",
      canonicalReference: "@demo/pkg!Id:type",
      excerptTokens: [C("export type Id = string;")],
    },
    iface("Other", [prop("Other", "z", [C("number")])]),
    {
      kind: "Function",
      name: "make",
      canonicalReference: "@demo/pkg!make:function(1)",
      excerptTokens: [
        C("export declare function make(opts: "),
        R("Opts", "@demo/pkg!Opts:interface"),
        C("): "),
        R("Id", "@demo/pkg!Id:type"),
        C(";"),
      ],
    },
  ];

  const surface = await focusedSurfaceFor(members, "make");
  // The types `make` references are present...
  assert.ok(
    surface.includes("Opts"),
    "should include referenced interface Opts",
  );
  assert.ok(surface.includes("Opts.a"), "should include Opts members");
  assert.ok(surface.includes("Id"), "should include referenced type Id");
  // ...the unrelated export is not.
  assert.ok(!surface.includes("Other"), "must not include unrelated Other");
});

test("ai-analyzer: focused context resolves transitive references", async () => {
  const members = [
    iface("Inner", [prop("Inner", "deep", [C("string")])]),
    iface("Wrapper", [
      prop("Wrapper", "inner", [R("Inner", "@demo/pkg!Inner:interface")]),
    ]),
    iface("Unrelated", [prop("Unrelated", "q", [C("number")])]),
    {
      kind: "Function",
      name: "use",
      canonicalReference: "@demo/pkg!use:function(1)",
      excerptTokens: [
        C("export declare function use(w: "),
        R("Wrapper", "@demo/pkg!Wrapper:interface"),
        C("): void;"),
      ],
    },
  ];

  const surface = await focusedSurfaceFor(members, "use");
  assert.ok(surface.includes("Wrapper"), "direct reference Wrapper present");
  assert.ok(
    surface.includes("Inner"),
    "transitive reference Inner (via Wrapper.inner) present",
  );
  assert.ok(!surface.includes("Unrelated"), "unrelated type excluded");
});

test("ai-analyzer: focused context seeds from a namespace-nested change", async () => {
  // api-diff names a namespace-nested member by its immediate parent only
  // (`Inner.a`), while the surface walk qualifies it fully (`Outer.Inner.a`).
  // The closure must still resolve the change's referenced types.
  const members = [
    iface("Helper", [prop("Helper", "x", [C("string")])]),
    iface("Unrelated", [prop("Unrelated", "z", [C("number")])]),
    {
      kind: "Namespace",
      name: "Outer",
      canonicalReference: "@demo/pkg!Outer:namespace",
      excerptTokens: [C("export declare namespace Outer ")],
      members: [
        {
          kind: "Interface",
          name: "Inner",
          canonicalReference: "@demo/pkg!Outer.Inner:interface",
          excerptTokens: [C("interface Inner ")],
          members: [
            {
              kind: "PropertySignature",
              name: "a",
              canonicalReference: "@demo/pkg!Outer.Inner#a:member",
              excerptTokens: [
                C("a: "),
                R("Helper", "@demo/pkg!Helper:interface"),
                C(";"),
              ],
            },
          ],
        },
      ],
    },
  ];

  // The rule-based change for the nested property is named `Inner.a`.
  const surface = await focusedSurfaceFor(members, "Inner.a");
  assert.ok(
    surface.includes("Helper"),
    "nested change must still resolve its referenced type",
  );
  assert.ok(surface.includes("Helper.x"), "and that type's members");
  assert.ok(!surface.includes("Unrelated"), "unrelated type excluded");
});

test("ai-analyzer: usage sites from a sibling subpath surface inform direction", async () => {
  // The OAuthConsentInfo shape: the changed type lives in this subpath, but its
  // only output-position usage (`get(): Promise<Info>`) lives in a sibling
  // subpath rollup. The per-subpath analyzer would otherwise never see it.
  const members = [
    {
      kind: "TypeAlias",
      name: "Info",
      canonicalReference: "@demo/pkg!Info:type",
      excerptTokens: [C("export type Info = { a: string; };")],
    },
  ];
  const siblingMembers = [
    {
      kind: "Function",
      name: "get",
      canonicalReference: "@demo/pkg!get:function(1)",
      excerptTokens: [
        C("export declare function get(): Promise<"),
        R("Info", "@demo/pkg!Info:type"),
        C(">;"),
      ],
    },
  ];

  const surface = await focusedSurfaceWithSiblings(
    members,
    "Info",
    siblingMembers,
  );
  assert.ok(surface.includes("Usage sites"), "expected a Usage sites section");
  assert.ok(
    surface.includes("get"),
    "the sibling referrer `get` must be listed",
  );
  assert.ok(
    surface.includes("Promise<"),
    "the output-position signature must be shown so direction is judgeable",
  );
});

test("ai-analyzer: usage sites are also resolved within the same surface", async () => {
  const members = [
    {
      kind: "TypeAlias",
      name: "Info",
      canonicalReference: "@demo/pkg!Info:type",
      excerptTokens: [C("export type Info = { a: string; };")],
    },
    {
      kind: "Function",
      name: "get",
      canonicalReference: "@demo/pkg!get:function(1)",
      excerptTokens: [
        C("export declare function get(): "),
        R("Info", "@demo/pkg!Info:type"),
        C(";"),
      ],
    },
  ];

  const surface = await focusedSurfaceFor(members, "Info");
  assert.ok(
    surface.includes("Usage sites"),
    "same-surface referrers must be found",
  );
  assert.ok(surface.includes("get"), "the referrer `get` must be listed");
});

test("ai-analyzer: system prompt carries the new classification + protocol rules", async () => {
  const { dir, baseline, current } = makeWorkspace();
  const change = ruleBasedBreakingChange();
  const { client, calls } = stubClient({
    verdicts: [
      {
        id: change.id,
        type: ChangeType.BREAKING,
        confidence: 0.9,
        rationale: "x",
        migration: "y",
      },
    ],
    missed: [],
  });
  const analyzer = new AiChangeAnalyzer({
    apiKey: "k",
    client,
    logger: SILENT_LOGGER,
  });

  try {
    await analyzer.analyze([change], {
      packageName: "@demo/pkg",
      baselineApiJsonPath: baseline,
      currentApiJsonPath: current,
    });
    const systemText = calls[0].system[0].text;
    assert.match(systemText, /optional/i, "optional-property rule present");
    assert.match(systemText, /Pick/, "Pick/Omit optionality rule present");
    assert.match(
      systemText,
      /Usage sites/,
      "directionality rule references usage sites",
    );
    assert.match(
      systemText,
      /conditional/i,
      "output protocol forbids conditional verdicts",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ai-analyzer: applyDowngrades coerces a bogus ADDITION verdict to NON_BREAKING", async () => {
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
    applyDowngrades: true,
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
    // protocol on an in-place modification, so we coerce to NON_BREAKING. With
    // applyDowngrades on, that downgrade is then applied.
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

test("ai-analyzer: lean coerces a bogus ADDITION but keeps it breaking", async () => {
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

    // Coercion still flags the protocol violation, but the resulting
    // non-breaking is a downgrade, so the lean default does not apply it.
    assert.equal(result.type, ChangeType.BREAKING);
    assert.equal(result.aiAnalysis.source, "ai-suggested-downgrade");
    assert.ok(warnings.some((w) => w.includes("addition")));
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
