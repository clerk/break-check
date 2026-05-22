import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(repoRoot, "dist", "cli.js");

function runSnapi(args, cwd) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: cwd ?? repoRoot,
    encoding: "utf-8",
  });
}

function setup({ baseline, current }) {
  const workspace = mkdtempSync(join(tmpdir(), "snapi-diff-"));
  const pkgDir = join(workspace, "packages", "pkg");
  mkdirSync(join(pkgDir, "dist"), { recursive: true });

  writeFileSync(
    join(workspace, "snapi.config.json"),
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

  writePackage(pkgDir, baseline);
  let snapshot = runSnapi(
    ["snapshot", "-c", join(workspace, "snapi.config.json"), "-o", "baseline"],
    workspace,
  );
  assert.equal(snapshot.status, 0, snapshot.stderr || snapshot.stdout);

  writePackage(pkgDir, current);
  const detect = runSnapi(
    [
      "detect",
      "-c",
      join(workspace, "snapi.config.json"),
      "--baseline",
      "baseline",
      "--format",
      "json",
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
