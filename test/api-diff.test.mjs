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

test("nested members under different parents are not collapsed by a key collision (#6)", () => {
  // `A.Inner.value` and `B.Inner.value` share an immediate parent (`Inner`) and
  // leaf name. When the map key used only the immediate parent, the two collided
  // and the later (unchanged) `B.Inner.value` masked the real change to
  // `A.Inner.value`, hiding a breaking change.
  const result = setup({
    baseline: {
      version: "1.0.0",
      dts:
        "export namespace A { export interface Inner { value: string; } }\n" +
        "export namespace B { export interface Inner { value: string; } }\n",
    },
    current: {
      version: "2.0.0",
      dts:
        "export namespace A { export interface Inner { value: number; } }\n" +
        "export namespace B { export interface Inner { value: string; } }\n",
    },
  });
  assert.equal(counts(result).breaking, 1);
  const ch = changesFor(result).find((c) => c.type === "breaking");
  assert.ok(ch, "the A.Inner.value change must not be masked by B.Inner.value");
  assert.equal(ch.name, "Inner.value");
  assert.match(ch.description, /Type changed/);
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

test("detect: a reference to an export-blocked dependency subpath is flagged unresolvable (end-to-end)", () => {
  const workspace = mkdtempSync(join(tmpdir(), "break-check-unres-"));
  try {
    const pkgDir = join(workspace, "packages", "pkg");
    mkdirSync(join(pkgDir, "dist"), { recursive: true });

    // Install a dependency that blocks its internal `_chunks` subpath, mirroring
    // @clerk/shared's `"./_chunks/*": null`.
    const depDir = join(pkgDir, "node_modules", "dep");
    mkdirSync(join(depDir, "dist", "_chunks"), { recursive: true });
    writeFileSync(
      join(depDir, "package.json"),
      JSON.stringify({
        name: "dep",
        version: "1.0.0",
        types: "dist/index.d.ts",
        exports: {
          ".": { types: "./dist/index.d.ts" },
          "./types": { types: "./dist/types.d.ts" },
          "./_chunks/*": null,
        },
      }),
    );
    writeFileSync(
      join(depDir, "dist", "_chunks", "index-DcO1-lAR.d.ts"),
      "export interface Jwt { sub: string; }\n",
    );
    writeFileSync(
      join(depDir, "dist", "types.d.ts"),
      'export type { Jwt } from "./_chunks/index-DcO1-lAR";\n',
    );
    writeFileSync(
      join(depDir, "dist", "index.d.ts"),
      'export * from "./types";\n',
    );

    writeFileSync(
      join(workspace, "break-check.config.json"),
      JSON.stringify(
        {
          packages: ["packages/pkg"],
          snapshotDir: "current",
          mainBranch: "main",
          checkVersionBump: true,
          outputFormat: "json",
        },
        null,
        2,
      ),
    );

    const writePkg = (version, dts) => {
      writeFileSync(
        join(pkgDir, "package.json"),
        JSON.stringify(
          { name: "@demo/pkg", version, types: "dist/index.d.ts" },
          null,
          2,
        ) + "\n",
      );
      writeFileSync(join(pkgDir, "dist", "index.d.ts"), dts);
    };

    writePkg(
      "1.0.0",
      "export declare function decodeJwt(token: string): string;\n",
    );
    const snap = runBreakCheck(
      [
        "snapshot",
        "-c",
        join(workspace, "break-check.config.json"),
        "-o",
        "baseline",
      ],
      workspace,
    );
    assert.equal(snap.status, 0, snap.stderr || snap.stdout);

    writePkg(
      "1.0.1",
      'export declare function decodeJwt(token: string): import("dep/_chunks/index-DcO1-lAR").Jwt;\n',
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
    const change = (result.packages[0]?.changes ?? []).find(
      (c) => c.name === "decodeJwt",
    );
    assert.ok(change, "expected a decodeJwt change");
    assert.equal(change.type, "breaking");
    assert.equal(change.unresolvableReference, true);
    assert.match(change.unresolvableSpecifier, /_chunks/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("detect: a non-breaking change is escalated to breaking when it adds an export-blocked reference (end-to-end)", () => {
  const workspace = mkdtempSync(join(tmpdir(), "break-check-unres-esc-"));
  try {
    const pkgDir = join(workspace, "packages", "pkg");
    mkdirSync(join(pkgDir, "dist"), { recursive: true });

    const depDir = join(pkgDir, "node_modules", "dep");
    mkdirSync(join(depDir, "dist", "_chunks"), { recursive: true });
    writeFileSync(
      join(depDir, "package.json"),
      JSON.stringify({
        name: "dep",
        version: "1.0.0",
        types: "dist/index.d.ts",
        exports: {
          ".": { types: "./dist/index.d.ts" },
          "./types": { types: "./dist/types.d.ts" },
          "./_chunks/*": null,
        },
      }),
    );
    writeFileSync(
      join(depDir, "dist", "_chunks", "index-DcO1-lAR.d.ts"),
      "export interface Opts { verbose: boolean; }\n",
    );
    writeFileSync(
      join(depDir, "dist", "types.d.ts"),
      'export type { Opts } from "./_chunks/index-DcO1-lAR";\n',
    );
    writeFileSync(
      join(depDir, "dist", "index.d.ts"),
      'export * from "./types";\n',
    );

    writeFileSync(
      join(workspace, "break-check.config.json"),
      JSON.stringify(
        {
          packages: ["packages/pkg"],
          snapshotDir: "current",
          mainBranch: "main",
          checkVersionBump: true,
          outputFormat: "json",
        },
        null,
        2,
      ),
    );

    const writePkg = (version, dts) => {
      writeFileSync(
        join(pkgDir, "package.json"),
        JSON.stringify(
          { name: "@demo/pkg", version, types: "dist/index.d.ts" },
          null,
          2,
        ) + "\n",
      );
      writeFileSync(join(pkgDir, "dist", "index.d.ts"), dts);
    };

    // Baseline: a plain function. Current: adds an OPTIONAL parameter whose type
    // lives in an export-blocked chunk. The rule pass calls "added optional
    // parameter" non-breaking; the deterministic guard escalates it.
    writePkg(
      "1.0.0",
      "export declare function decodeJwt(token: string): string;\n",
    );
    const snap = runBreakCheck(
      [
        "snapshot",
        "-c",
        join(workspace, "break-check.config.json"),
        "-o",
        "baseline",
      ],
      workspace,
    );
    assert.equal(snap.status, 0, snap.stderr || snap.stdout);

    writePkg(
      "1.1.0",
      'export declare function decodeJwt(token: string, opts?: import("dep/_chunks/index-DcO1-lAR").Opts): string;\n',
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
    const change = (result.packages[0]?.changes ?? []).find(
      (c) => c.name === "decodeJwt",
    );
    assert.ok(change, "expected a decodeJwt change");
    assert.equal(change.type, "breaking", "should be escalated to breaking");
    assert.equal(
      change.ruleBasedType,
      "non-breaking",
      "rule pass saw it as non-breaking",
    );
    assert.equal(change.unresolvableReference, true);
    assert.match(change.unresolvableSpecifier, /_chunks/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("changing an enum member value is breaking", () => {
  const result = setup({
    baseline: {
      version: "1.0.0",
      dts: "export declare enum Color {\n  Red = 1,\n  Green = 2,\n}\n",
    },
    current: {
      version: "1.0.1",
      dts: "export declare enum Color {\n  Red = 5,\n  Green = 2,\n}\n",
    },
  });
  assert.deepEqual(counts(result), {
    breaking: 1,
    nonBreaking: 0,
    additions: 0,
  });
  const change = changesFor(result).find((c) => c.name === "Color.Red");
  assert.ok(change, "expected a change on Color.Red");
  assert.equal(change.type, "breaking");
  assert.match(change.description, /Enum member value changed: `1` → `5`/);
});

test("adding readonly to a property is breaking", () => {
  const result = setup({
    baseline: {
      version: "1.0.0",
      dts: "export interface Box {\n  value: string;\n}\n",
    },
    current: {
      version: "1.0.1",
      dts: "export interface Box {\n  readonly value: string;\n}\n",
    },
  });
  assert.deepEqual(counts(result), {
    breaking: 1,
    nonBreaking: 0,
    additions: 0,
  });
  const change = changesFor(result).find((c) => c.name === "Box.value");
  assert.ok(change, "expected a change on Box.value");
  assert.equal(change.type, "breaking");
  assert.match(change.description, /Field became readonly/);
});

test("removing readonly from a property is breaking", () => {
  const result = setup({
    baseline: {
      version: "1.0.0",
      dts: "export interface Box {\n  readonly value: string;\n}\n",
    },
    current: {
      version: "1.0.1",
      dts: "export interface Box {\n  value: string;\n}\n",
    },
  });
  assert.deepEqual(counts(result), {
    breaking: 1,
    nonBreaking: 0,
    additions: 0,
  });
  const change = changesFor(result).find((c) => c.name === "Box.value");
  assert.ok(change, "expected a change on Box.value");
  assert.equal(change.type, "breaking");
  assert.match(change.description, /Field is no longer readonly/);
});

test("switching an export's declaration kind is breaking", () => {
  // A function becoming a const keys into different change categories
  // (function vs variable), so it surfaces as the old export removed plus a
  // new one added. The removal is the breaking signal: callers of the old
  // function break. (The same-key "Declaration kind changed" branch is
  // defensive; category keying routes differing shapes apart before it.)
  const result = setup({
    baseline: {
      version: "1.0.0",
      dts: "export declare function thing(): void;\n",
    },
    current: {
      version: "1.0.1",
      dts: "export declare const thing: string;\n",
    },
  });
  assert.deepEqual(counts(result), {
    breaking: 1,
    nonBreaking: 0,
    additions: 1,
  });
  const removed = changesFor(result).find((c) => c.type === "breaking");
  assert.ok(removed, "expected a breaking change for the removed function");
  assert.match(removed.description, /Removed function `thing`/);
});

test("turning a parameter into a rest parameter is breaking", () => {
  // API Extractor's .api.json omits an isRest flag, so this is recovered from
  // the excerpt. Without that, a rest-ness flip is invisible to the diff.
  const result = setup({
    baseline: {
      version: "1.0.0",
      dts: "export declare function go(items: string[]): void;\n",
    },
    current: {
      version: "1.0.1",
      dts: "export declare function go(...items: string[]): void;\n",
    },
  });
  assert.deepEqual(counts(result), {
    breaking: 1,
    nonBreaking: 0,
    additions: 0,
  });
  const change = changesFor(result).find((c) => c.name === "go");
  assert.ok(change, "expected a change on go");
  assert.equal(change.type, "breaking");
  assert.match(change.description, /Parameter `items` rest-ness changed/);
});

test("adding a rest parameter is non-breaking", () => {
  // A new `...rest` is back-compatible (existing calls still type-check), so it
  // must read as an optional add, not a required-parameter break.
  const result = setup({
    baseline: {
      version: "1.0.0",
      dts: "export declare function go(): void;\n",
    },
    current: {
      version: "1.1.0",
      dts: "export declare function go(...items: string[]): void;\n",
    },
  });
  assert.deepEqual(counts(result), {
    breaking: 0,
    nonBreaking: 1,
    additions: 0,
  });
  const change = changesFor(result).find((c) => c.name === "go");
  assert.ok(change, "expected a change on go");
  assert.equal(change.type, "non-breaking");
  assert.match(change.description, /Optional parameter `items` was added/);
});
