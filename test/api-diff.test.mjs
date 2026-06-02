import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(repoRoot, "dist", "cli.js");

function runBreakCheck(args, cwd) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: cwd ?? repoRoot,
    encoding: "utf-8",
  });
}

function setup({ baseline, current, acknowledgedChanges }) {
  const workspace = mkdtempSync(join(tmpdir(), "break-check-diff-"));
  const pkgDir = join(workspace, "packages", "pkg");
  mkdirSync(join(pkgDir, "dist"), { recursive: true });

  writeFileSync(
    join(workspace, "break-check.config.json"),
    JSON.stringify(
      {
        packages: ["packages/pkg"],
        snapshotDir: "current",
        mainBranch: "main",
        checkVersionBump: true,
        outputFormat: "json",
        ...(acknowledgedChanges ? { acknowledgedChanges } : {}),
      },
      null,
      2,
    ),
  );

  writePackage(pkgDir, baseline);
  let snapshot = runBreakCheck(
    [
      "snapshot",
      "-c",
      join(workspace, "break-check.config.json"),
      "-o",
      "baseline",
    ],
    workspace,
  );
  assert.equal(snapshot.status, 0, snapshot.stderr || snapshot.stdout);

  writePackage(pkgDir, current);
  const detect = runBreakCheck(
    [
      "detect",
      "-c",
      join(workspace, "break-check.config.json"),
      "--baseline",
      "baseline",
      "--format",
      "json",
      // These tests assert rule-based behavior. Pin --no-ai so the suite stays
      // deterministic when BREAK_CHECK_ANTHROPIC_API_KEY happens to be set.
      "--no-ai",
    ],
    workspace,
  );
  if (detect.status !== 0) {
    rmSync(workspace, { recursive: true, force: true });
    throw new Error(`detect exited ${detect.status}: ${detect.stderr}`);
  }

  const result = JSON.parse(detect.stdout);
  rmSync(workspace, { recursive: true, force: true });
  return result;
}

function writePackage(pkgDir, { version, dts }) {
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify(
      { name: "@demo/pkg", version, types: "dist/index.d.ts" },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(join(pkgDir, "dist", "index.d.ts"), dts);
}

function changesFor(result) {
  return result.packages[0]?.changes ?? [];
}

function counts(result) {
  return {
    breaking: result.summary.breakingChanges,
    nonBreaking: result.summary.nonBreakingChanges,
    additions: result.summary.additions,
  };
}

test("whitespace-only signature change is ignored", () => {
  const result = setup({
    baseline: {
      version: "1.0.0",
      dts: "export declare function go(name: string): void;\n",
    },
    current: {
      version: "1.0.1",
      dts: "export declare function go(name:    string ): void;\n",
    },
  });
  assert.deepEqual(counts(result), {
    breaking: 0,
    nonBreaking: 0,
    additions: 0,
  });
});

test("parameter rename is not a breaking change", () => {
  const result = setup({
    baseline: {
      version: "1.0.0",
      dts: "export declare function go(first: string): void;\n",
    },
    current: {
      version: "1.0.1",
      dts: "export declare function go(name: string): void;\n",
    },
  });
  assert.deepEqual(counts(result), {
    breaking: 0,
    nonBreaking: 0,
    additions: 0,
  });
});

test("adding an optional parameter is non-breaking", () => {
  const result = setup({
    baseline: {
      version: "1.0.0",
      dts: "export declare function go(name: string): void;\n",
    },
    current: {
      version: "1.1.0",
      dts: "export declare function go(name: string, count?: number): void;\n",
    },
  });
  assert.equal(counts(result).breaking, 0);
  assert.equal(counts(result).nonBreaking, 1);
});

test("adding a required parameter is breaking", () => {
  const result = setup({
    baseline: {
      version: "1.0.0",
      dts: "export declare function go(name: string): void;\n",
    },
    current: {
      version: "2.0.0",
      dts: "export declare function go(name: string, count: number): void;\n",
    },
  });
  assert.equal(counts(result).breaking, 1);
  const desc = changesFor(result)[0].description;
  assert.match(desc, /Required parameter `count` was added/);
});

test("making a required parameter optional is non-breaking", () => {
  const result = setup({
    baseline: {
      version: "1.0.0",
      dts: "export declare function go(name: string): void;\n",
    },
    current: {
      version: "1.1.0",
      dts: "export declare function go(name?: string): void;\n",
    },
  });
  assert.equal(counts(result).breaking, 0);
  assert.equal(counts(result).nonBreaking, 1);
});

test("making an optional parameter required is breaking", () => {
  const result = setup({
    baseline: {
      version: "1.0.0",
      dts: "export declare function go(name?: string): void;\n",
    },
    current: {
      version: "2.0.0",
      dts: "export declare function go(name: string): void;\n",
    },
  });
  assert.equal(counts(result).breaking, 1);
});

test("changing a return type is breaking", () => {
  const result = setup({
    baseline: {
      version: "1.0.0",
      dts: "export declare function go(): string;\n",
    },
    current: {
      version: "2.0.0",
      dts: "export declare function go(): number;\n",
    },
  });
  assert.equal(counts(result).breaking, 1);
  assert.match(changesFor(result)[0].description, /Return type changed/);
});

test("removing an interface property is breaking", () => {
  const result = setup({
    baseline: {
      version: "1.0.0",
      dts: "export interface User { id: string; name: string; }\n",
    },
    current: {
      version: "2.0.0",
      dts: "export interface User { id: string; }\n",
    },
  });
  // Removing User.name → 1 breaking. The interface itself shouldn't be flagged again.
  assert.equal(counts(result).breaking, 1);
  const ch = changesFor(result)[0];
  assert.equal(ch.name, "User.name");
});

test("interface body change is not double-counted at the container level", () => {
  const result = setup({
    baseline: {
      version: "1.0.0",
      dts: "export interface User { id: string; }\n",
    },
    current: {
      version: "1.1.0",
      dts: "export interface User { id: string; name?: string; }\n",
    },
  });
  // Only the addition of User.name should show up, NOT a separate User change.
  assert.equal(counts(result).additions, 1);
  assert.equal(counts(result).breaking, 0);
  assert.equal(counts(result).nonBreaking, 0);
});

test("making a property optional is non-breaking", () => {
  const result = setup({
    baseline: {
      version: "1.0.0",
      dts: "export interface User { id: string; name: string; }\n",
    },
    current: {
      version: "1.1.0",
      dts: "export interface User { id: string; name?: string; }\n",
    },
  });
  assert.equal(counts(result).nonBreaking, 1);
  assert.equal(counts(result).breaking, 0);
});

test("making a property required is breaking", () => {
  const result = setup({
    baseline: {
      version: "1.0.0",
      dts: "export interface User { id: string; name?: string; }\n",
    },
    current: {
      version: "2.0.0",
      dts: "export interface User { id: string; name: string; }\n",
    },
  });
  assert.equal(counts(result).breaking, 1);
});

test("removing an exported function is breaking", () => {
  const result = setup({
    baseline: {
      version: "1.0.0",
      dts:
        "export declare function go(): void;\n" +
        "export declare function stop(): void;\n",
    },
    current: {
      version: "2.0.0",
      dts: "export declare function go(): void;\n",
    },
  });
  assert.equal(counts(result).breaking, 1);
});

test("adding a new exported function is an addition", () => {
  const result = setup({
    baseline: {
      version: "1.0.0",
      dts: "export declare function go(): void;\n",
    },
    current: {
      version: "1.1.0",
      dts:
        "export declare function go(): void;\n" +
        "export declare function stop(): void;\n",
    },
  });
  assert.equal(counts(result).additions, 1);
  assert.equal(counts(result).breaking, 0);
});

test("type alias description summarizes large type literals", () => {
  // Build a 200-key object type. Without summarization, the description
  // would include both copies of this literal (~10KB+) and push the
  // generated PR comment past GitHub's 65KB limit.
  const baselineKeys = Array.from(
    { length: 200 },
    (_, i) => `key${i}: string;`,
  ).join(" ");
  const currentKeys = Array.from(
    { length: 201 },
    (_, i) => `key${i}: string;`,
  ).join(" ");
  const result = setup({
    baseline: {
      version: "1.0.0",
      dts: `export type Big = { ${baselineKeys} };\n`,
    },
    current: {
      version: "2.0.0",
      dts: `export type Big = { ${currentKeys} };\n`,
    },
  });

  assert.equal(counts(result).breaking, 1);
  const ch = changesFor(result)[0];
  assert.match(ch.description, /Type changed/);
  // Description must remain compact; the diff snippet shows the full bodies.
  assert.ok(
    ch.description.length < 500,
    `description should be summarized, got ${ch.description.length} chars`,
  );
  assert.ok(
    ch.description.includes("…"),
    "expected ellipsis marking a truncated type literal",
  );
});

test("acknowledgedChanges greens a breaking change by bare name", () => {
  const result = setup({
    baseline: { version: "1.0.0", dts: "export type R = { a: string };\n" },
    current: {
      version: "1.0.1",
      dts: "export type R = { a: string; b: number };\n",
    },
    acknowledgedChanges: ["R"],
  });
  assert.equal(counts(result).breaking, 0);
  assert.equal(counts(result).nonBreaking, 1);
  const ch = changesFor(result)[0];
  assert.equal(ch.type, "non-breaking");
  assert.equal(ch.acknowledged, true);
  assert.equal(ch.ruleBasedType, "breaking");
});

test("acknowledgedChanges matches the package#name form", () => {
  const result = setup({
    baseline: { version: "1.0.0", dts: "export type R = { a: string };\n" },
    current: {
      version: "1.0.1",
      dts: "export type R = { a: string; b: number };\n",
    },
    acknowledgedChanges: ["@demo/pkg#R"],
  });
  assert.equal(counts(result).breaking, 0);
  assert.equal(changesFor(result)[0].acknowledged, true);
});

test("acknowledgedChanges does not match an unrelated name", () => {
  const result = setup({
    baseline: { version: "1.0.0", dts: "export type R = { a: string };\n" },
    current: {
      version: "2.0.0",
      dts: "export type R = { a: string; b: number };\n",
    },
    acknowledgedChanges: ["SomethingElse"],
  });
  assert.equal(counts(result).breaking, 1);
  assert.ok(!changesFor(result)[0].acknowledged);
});

test("changing a property type is breaking", () => {
  const result = setup({
    baseline: {
      version: "1.0.0",
      dts: "export interface User { id: string; }\n",
    },
    current: {
      version: "2.0.0",
      dts: "export interface User { id: number; }\n",
    },
  });
  assert.equal(counts(result).breaking, 1);
  assert.match(changesFor(result)[0].description, /Type changed/);
});

test("equivalent import notation is not a breaking change", () => {
  // Regression for #44. API Extractor resolves a namespace-import alias
  // (`_dep.Foo`) and an inline import type (`import("@demo/dep").Foo`) to the
  // same canonical reference; only the spelling differs, and which spelling
  // appears depends on how a package builds its `.d.ts`. The static differ
  // must treat the two as identical rather than leaning on the AI reviewer.
  const workspace = mkdtempSync(join(tmpdir(), "break-check-notation-"));
  try {
    const pkgDir = join(workspace, "packages", "pkg");
    const depDir = join(workspace, "node_modules", "@demo", "dep");
    mkdirSync(join(pkgDir, "dist"), { recursive: true });
    mkdirSync(depDir, { recursive: true });

    // A resolvable dependency so API Extractor attaches a canonicalReference
    // to the imported type (the field the differ canonicalizes against).
    writeFileSync(
      join(depDir, "package.json"),
      JSON.stringify({
        name: "@demo/dep",
        version: "1.0.0",
        types: "index.d.ts",
      }),
    );
    writeFileSync(
      join(depDir, "index.d.ts"),
      "export interface Foo { id: string; }\n",
    );

    writeFileSync(
      join(workspace, "break-check.config.json"),
      JSON.stringify({
        packages: ["packages/pkg"],
        snapshotDir: "current",
        mainBranch: "main",
      }),
    );
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "@demo/pkg",
        version: "1.0.0",
        types: "dist/index.d.ts",
      }),
    );

    // Baseline: namespace-import alias spelling.
    writeFileSync(
      join(pkgDir, "dist", "index.d.ts"),
      'import * as _dep from "@demo/dep";\n' +
        "export declare const a: _dep.Foo;\n" +
        "export declare function make(): _dep.Foo;\n" +
        "export declare function use(opt: _dep.Foo): void;\n",
    );
    const snapshot = runBreakCheck(
      [
        "snapshot",
        "-c",
        join(workspace, "break-check.config.json"),
        "-o",
        "baseline",
      ],
      workspace,
    );
    assert.equal(snapshot.status, 0, snapshot.stderr || snapshot.stdout);

    // Current: inline import type spelling for the same, unchanged types.
    writeFileSync(
      join(pkgDir, "dist", "index.d.ts"),
      'export declare const a: import("@demo/dep").Foo;\n' +
        'export declare function make(): import("@demo/dep").Foo;\n' +
        'export declare function use(opt: import("@demo/dep").Foo): void;\n',
    );
    const detect = runBreakCheck(
      [
        "detect",
        "-c",
        join(workspace, "break-check.config.json"),
        "--baseline",
        "baseline",
        "--format",
        "json",
        "--no-ai",
      ],
      workspace,
    );
    assert.equal(detect.status, 0, detect.stderr || detect.stdout);
    const result = JSON.parse(detect.stdout);
    assert.deepEqual(counts(result), {
      breaking: 0,
      nonBreaking: 0,
      additions: 0,
    });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
