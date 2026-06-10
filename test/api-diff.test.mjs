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

test("detect: repairing a blocked chunk reference to an exported subpath is downgraded to non-breaking (end-to-end, #98)", () => {
  const workspace = mkdtempSync(join(tmpdir(), "break-check-repair-"));
  try {
    const pkgDir = join(workspace, "packages", "pkg");
    mkdirSync(join(pkgDir, "dist"), { recursive: true });

    // A dependency that blocks `_chunks` but exposes `./types` publicly,
    // mirroring @clerk/shared.
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
      "export interface Jwt { sub: string; }\n",
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
    // Same config with the repair downgrade opted out, sharing the baseline.
    writeFileSync(
      join(workspace, "break-check.no-repair.config.json"),
      JSON.stringify(
        {
          packages: ["packages/pkg"],
          snapshotDir: "current",
          mainBranch: "main",
          checkVersionBump: true,
          outputFormat: "json",
          downgradeRepairedReferences: false,
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

    // Baseline: the published signature references the export-blocked chunk
    // (the issue #60 regression). Current: the repair points it at the public
    // `./types` subpath; the signature is otherwise identical.
    writePkg(
      "1.0.0",
      'export declare function decodeJwt(token: string): import("dep/_chunks/index-DcO1-lAR").Jwt;\n',
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
      'export declare function decodeJwt(token: string): import("dep/types").Jwt;\n',
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
    assert.equal(change.type, "non-breaking", "repair should be downgraded");
    assert.equal(change.ruleBasedType, "breaking");
    assert.deepEqual(change.repairedReference, {
      from: ["dep/_chunks/index-DcO1-lAR"],
      to: ["dep/types"],
    });
    assert.deepEqual(change.referenceResolutions, [
      {
        specifier: "dep/_chunks/index-DcO1-lAR",
        side: "removed",
        verdict: "blocked",
      },
      { specifier: "dep/types", side: "introduced", verdict: "exported" },
    ]);
    assert.equal(change.unresolvableReference, undefined);
    assert.equal(result.packages[0].hasBreakingChanges, false);
    assert.equal(result.packages[0].recommendedVersionBump, "minor");

    // Maintainer opt-out: the same diff stays breaking, with the resolvability
    // facts still attached for the report/AI.
    const detectOff = runBreakCheck(
      [
        "detect",
        "-c",
        join(workspace, "break-check.no-repair.config.json"),
        "--baseline",
        "baseline",
        "--format",
        "json",
        "--no-ai",
      ],
      workspace,
    );
    // Breaking changes exit non-zero; only the report content matters here.
    const resultOff = JSON.parse(detectOff.stdout);
    const changeOff = (resultOff.packages[0]?.changes ?? []).find(
      (c) => c.name === "decodeJwt",
    );
    assert.ok(changeOff, "expected a decodeJwt change");
    assert.equal(changeOff.type, "breaking");
    assert.equal(changeOff.repairedReference, undefined);
    assert.equal(changeOff.referenceResolutions?.length, 2);
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

// Issue #85: TypeScript emits inferred union members in an order keyed off an
// unstable internal type-id table, so an unrelated edit rotates the order. A
// pure reorder of identical members must not read as a change.

test("reordering return-type union members is not a change (#85)", () => {
  const result = setup({
    baseline: {
      version: "1.0.0",
      dts: "export declare function go(): string | number;\n",
    },
    current: {
      version: "1.0.1",
      dts: "export declare function go(): number | string;\n",
    },
  });
  assert.deepEqual(counts(result), {
    breaking: 0,
    nonBreaking: 0,
    additions: 0,
  });
});

test("adding a return-type union member is still breaking (#85 guard)", () => {
  const result = setup({
    baseline: {
      version: "1.0.0",
      dts: "export declare function go(): string | number;\n",
    },
    current: {
      version: "2.0.0",
      dts: "export declare function go(): string | number | boolean;\n",
    },
  });
  assert.equal(counts(result).breaking, 1);
  assert.match(changesFor(result)[0].description, /Return type changed/);
});

test("reordering a parameter-type union is not a change (#85)", () => {
  const result = setup({
    baseline: {
      version: "1.0.0",
      dts: "export declare function go(x: string | number): void;\n",
    },
    current: {
      version: "1.0.1",
      dts: "export declare function go(x: number | string): void;\n",
    },
  });
  assert.deepEqual(counts(result), {
    breaking: 0,
    nonBreaking: 0,
    additions: 0,
  });
});

test("reordering a property-type union is not a change (#85)", () => {
  const result = setup({
    baseline: {
      version: "1.0.0",
      dts: "export interface User { id: string | number; }\n",
    },
    current: {
      version: "1.0.1",
      dts: "export interface User { id: number | string; }\n",
    },
  });
  assert.deepEqual(counts(result), {
    breaking: 0,
    nonBreaking: 0,
    additions: 0,
  });
});

test("reordering a union nested inside a generic is not a change (#85)", () => {
  const result = setup({
    baseline: {
      version: "1.0.0",
      dts: "export declare function go(): Array<string | number>;\n",
    },
    current: {
      version: "1.0.1",
      dts: "export declare function go(): Array<number | string>;\n",
    },
  });
  assert.deepEqual(counts(result), {
    breaking: 0,
    nonBreaking: 0,
    additions: 0,
  });
});

test("reordering intersection members is not a change (#85)", () => {
  const result = setup({
    baseline: {
      version: "1.0.0",
      dts: "export type T = { a: number } & { b: string };\n",
    },
    current: {
      version: "1.0.1",
      dts: "export type T = { b: string } & { a: number };\n",
    },
  });
  assert.deepEqual(counts(result), {
    breaking: 0,
    nonBreaking: 0,
    additions: 0,
  });
});

test("a string-literal member containing a pipe is not mis-split (#85)", () => {
  const result = setup({
    baseline: {
      version: "1.0.0",
      dts: 'export type T = "a|b" | "c";\n',
    },
    current: {
      version: "1.0.1",
      dts: 'export type T = "c" | "a|b";\n',
    },
  });
  assert.deepEqual(counts(result), {
    breaking: 0,
    nonBreaking: 0,
    additions: 0,
  });
});

test("a genuine string-literal union member change is still breaking (#85 guard)", () => {
  const result = setup({
    baseline: {
      version: "1.0.0",
      dts: 'export type T = "a" | "b";\n',
    },
    current: {
      version: "2.0.0",
      dts: 'export type T = "a" | "c";\n',
    },
  });
  assert.equal(counts(result).breaking, 1);
});

test("making a property optional while changing its type is breaking", () => {
  const result = setup({
    baseline: {
      version: "1.0.0",
      dts: "export interface User { name: string; }\n",
    },
    current: {
      version: "2.0.0",
      dts: "export interface User { name?: number; }\n",
    },
  });
  // The relaxing optional flip must not mask the simultaneous type change.
  assert.equal(counts(result).breaking, 1);
  assert.equal(counts(result).nonBreaking, 0);
  const change = changesFor(result).find((c) => c.name === "User.name");
  assert.match(change.description, /Member became optional/);
  assert.match(change.description, /Type changed/);
});

test("making a method optional while changing a parameter type is breaking", () => {
  const result = setup({
    baseline: {
      version: "1.0.0",
      dts: "export interface Api { go(x: string): void; }\n",
    },
    current: {
      version: "2.0.0",
      dts: "export interface Api { go?(x: number): void; }\n",
    },
  });
  assert.equal(counts(result).breaking, 1);
  assert.equal(counts(result).nonBreaking, 0);
});

test("a pure optionality relaxation stays non-breaking and says so", () => {
  const result = setup({
    baseline: {
      version: "1.0.0",
      dts: "export interface User { name: string; }\n",
    },
    current: {
      version: "1.1.0",
      dts: "export interface User { name?: string; }\n",
    },
  });
  assert.equal(counts(result).nonBreaking, 1);
  assert.equal(counts(result).breaking, 0);
  const change = changesFor(result).find((c) => c.name === "User.name");
  assert.match(change.description, /Member became optional/);
});

test("removing the last function overload is breaking", () => {
  const result = setup({
    baseline: {
      version: "1.0.0",
      dts:
        "export declare function go(x: string): string;\n" +
        "export declare function go(x: number): number;\n",
    },
    current: {
      version: "2.0.0",
      dts: "export declare function go(x: string): string;\n",
    },
  });
  assert.equal(counts(result).breaking, 1);
  assert.equal(counts(result).additions, 0);
  assert.match(changesFor(result)[0].description, /Removed function `go`/);
});

test("changing one overload's signature is breaking", () => {
  const result = setup({
    baseline: {
      version: "1.0.0",
      dts:
        "export declare function go(x: string): string;\n" +
        "export declare function go(x: number): number;\n",
    },
    current: {
      version: "2.0.0",
      dts:
        "export declare function go(x: string): Promise<string>;\n" +
        "export declare function go(x: number): number;\n",
    },
  });
  assert.equal(counts(result).breaking, 1);
  assert.match(changesFor(result)[0].description, /Return type changed/);
});

test("adding a trailing function overload is an addition", () => {
  const result = setup({
    baseline: {
      version: "1.0.0",
      dts: "export declare function go(x: string): string;\n",
    },
    current: {
      version: "1.1.0",
      dts:
        "export declare function go(x: string): string;\n" +
        "export declare function go(x: number): number;\n",
    },
  });
  assert.deepEqual(counts(result), {
    breaking: 0,
    nonBreaking: 0,
    additions: 1,
  });
});

test("removing a non-last overload is reported, pessimistically as positional changes", () => {
  const result = setup({
    baseline: {
      version: "1.0.0",
      dts:
        "export declare function go(x: string): string;\n" +
        "export declare function go(x: number): number;\n",
    },
    current: {
      version: "2.0.0",
      dts: "export declare function go(x: number): number;\n",
    },
  });
  // Overloads are matched positionally: slot 1 reads as a signature change and
  // slot 2 as a removal. Two breaks instead of one is pessimistic, but never
  // silent (this previously reported no change at all).
  assert.equal(counts(result).breaking, 2);
  assert.equal(counts(result).additions, 0);
});

test("two index signatures do not collide; changing one is breaking", () => {
  const result = setup({
    baseline: {
      version: "1.0.0",
      dts: "export interface M { [k: string]: number; [k: number]: number; }\n",
    },
    current: {
      version: "2.0.0",
      dts: "export interface M { [k: string]: string; [k: number]: number; }\n",
    },
  });
  assert.equal(counts(result).breaking, 1);
});

test("a method becoming static is breaking", () => {
  const result = setup({
    baseline: {
      version: "1.0.0",
      dts: "export declare class C { m(): void; }\n",
    },
    current: {
      version: "2.0.0",
      dts: "export declare class C { static m(): void; }\n",
    },
  });
  // The callable compare only sees parameters and return type, so without the
  // member-level flag compare this flip was invisible.
  assert.equal(counts(result).breaking, 1);
  assert.match(changesFor(result)[0].description, /Member became static/);
});

test("a class becoming abstract is breaking", () => {
  const result = setup({
    baseline: {
      version: "1.0.0",
      dts: "export declare class C { m(): void; }\n",
    },
    current: {
      version: "2.0.0",
      dts: "export declare abstract class C { m(): void; }\n",
    },
  });
  assert.equal(counts(result).breaking, 1);
  assert.match(changesFor(result)[0].description, /Member became abstract/);
});

test("a 0.x breaking change is satisfied by a minor bump", () => {
  const result = setup({
    baseline: {
      version: "0.2.0",
      dts: "export declare function go(x: string): void;\n",
    },
    current: {
      version: "0.3.0",
      dts: "export declare function go(x: number): void;\n",
    },
  });
  const pkg = result.packages[0];
  assert.equal(counts(result).breaking, 1);
  assert.equal(pkg.recommendedVersionBump, "major");
  assert.equal(pkg.actualVersionBump, "minor");
  assert.equal(pkg.isValidBump, true);
});

test("a 0.x breaking change still rejects a patch bump", () => {
  const result = setup({
    baseline: {
      version: "0.2.0",
      dts: "export declare function go(x: string): void;\n",
    },
    current: {
      version: "0.2.1",
      dts: "export declare function go(x: number): void;\n",
    },
  });
  assert.equal(result.packages[0].isValidBump, false);
});

test("a breaking change within one prerelease train is a valid bump", () => {
  const result = setup({
    baseline: {
      version: "1.0.0-beta.1",
      dts: "export declare function go(x: string): void;\n",
    },
    current: {
      version: "1.0.0-beta.2",
      dts: "export declare function go(x: number): void;\n",
    },
  });
  assert.equal(counts(result).breaking, 1);
  assert.equal(result.packages[0].isValidBump, true);
});

test("a stable-version breaking change with a patch bump stays insufficient", () => {
  const result = setup({
    baseline: {
      version: "1.0.0",
      dts: "export declare function go(x: string): void;\n",
    },
    current: {
      version: "1.0.1",
      dts: "export declare function go(x: number): void;\n",
    },
  });
  assert.equal(result.packages[0].isValidBump, false);
});
