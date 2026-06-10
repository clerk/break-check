import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../dist/config.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(repoRoot, "dist", "cli.js");

function runBreakCheck(args, cwd) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: cwd ?? repoRoot,
    encoding: "utf-8",
  });
}

function createWorkspace() {
  return mkdtempSync(join(tmpdir(), "break-check-test-"));
}

function writeJson(filePath, value) {
  writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n");
}

function writePackage(workspace, { version, declarations, withTypes = true }) {
  const packageDir = join(workspace, "packages", "pkg");
  mkdirSync(join(packageDir, "dist"), { recursive: true });

  writeJson(join(packageDir, "package.json"), {
    name: "@demo/pkg",
    version,
    ...(withTypes ? { types: "dist/index.d.ts" } : {}),
  });

  if (declarations !== undefined) {
    writeFileSync(join(packageDir, "dist", "index.d.ts"), declarations);
  }
}

function writeConfig(workspace) {
  const configPath = join(workspace, "break-check.config.json");
  writeJson(configPath, {
    packages: ["packages/pkg"],
    snapshotDir: "snapshots",
    mainBranch: "main",
    checkVersionBump: true,
    outputFormat: "markdown",
  });
  return configPath;
}

test("detect resolves relative baseline paths from the config directory", () => {
  const workspace = createWorkspace();

  try {
    const configPath = writeConfig(workspace);

    writePackage(workspace, {
      version: "1.0.0",
      declarations:
        "export interface User {\n  id: string;\n  name: string;\n}\nexport declare function getUser(id: string): User;\n",
    });

    const snapshot = runBreakCheck([
      "snapshot",
      "-c",
      configPath,
      "-o",
      "baseline",
    ]);
    assert.equal(snapshot.status, 0, snapshot.stderr);
    assert.ok(
      existsSync(
        join(workspace, "baseline", "demo__pkg", "break-check.snapshot.json"),
      ),
    );

    writePackage(workspace, {
      version: "1.1.0",
      declarations:
        "export interface User {\n  id: string;\n}\nexport declare function getUser(id: string): User;\nexport declare function listUsers(): User[];\n",
    });

    const detect = runBreakCheck([
      "detect",
      "-c",
      configPath,
      "--baseline",
      "baseline",
      "--format",
      "json",
      // Pin --no-ai: this test asserts rule-based behavior and must stay
      // deterministic when BREAK_CHECK_ANTHROPIC_API_KEY is set.
      "--no-ai",
      "--fail-on-breaking",
    ]);

    assert.equal(detect.status, 1, detect.stderr);
    const result = JSON.parse(detect.stdout);
    assert.equal(result.summary.totalPackages, 1);
    assert.equal(result.summary.breakingChanges, 1);
    assert.equal(result.summary.additions, 1);
    assert.equal(result.packages[0].version.previous, "1.0.0");
    assert.equal(result.packages[0].version.current, "1.1.0");
    assert.equal(result.packages[0].isValidBump, false);
    assert.match(detect.stderr, /Breaking changes detected/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("detect --json-output writes a JSON sidecar next to the human report", () => {
  const workspace = createWorkspace();

  try {
    writeConfig(workspace);
    writePackage(workspace, {
      version: "1.0.0",
      declarations: "export declare function go(name: string): void;\n",
    });

    const snapshot = runBreakCheck(
      ["snapshot", "-c", "break-check.config.json", "-o", "baseline"],
      workspace,
    );
    assert.equal(snapshot.status, 0, snapshot.stderr);

    // Breaking change: a required parameter's type changed.
    writePackage(workspace, {
      version: "1.0.1",
      declarations: "export declare function go(name: number): void;\n",
    });

    const detect = runBreakCheck(
      [
        "detect",
        "-c",
        "break-check.config.json",
        "--baseline",
        "baseline",
        "--output",
        "report.md",
        "--json-output",
        "report.json",
        // Deterministic: assert the rule-based verdict even if a key is present.
        "--no-ai",
      ],
      workspace,
    );
    assert.equal(detect.status, 0, detect.stderr);

    const mdPath = join(workspace, "report.md");
    const jsonPath = join(workspace, "report.json");
    assert.ok(existsSync(mdPath), "the human report should be written");
    assert.ok(existsSync(jsonPath), "the JSON sidecar should be written");

    // The sidecar parses as the machine-readable verdict; the primary --output
    // stays human-readable markdown (so it is not valid JSON).
    const json = JSON.parse(readFileSync(jsonPath, "utf-8"));
    assert.equal(json.hasBreakingChanges, true);
    assert.equal(json.summary.breakingChanges, 1);
    assert.throws(
      () => JSON.parse(readFileSync(mdPath, "utf-8")),
      "the primary --output should be markdown, not JSON",
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("snapshot supports declaration packages without a tsconfig", () => {
  const workspace = createWorkspace();

  try {
    const configPath = writeConfig(workspace);
    writePackage(workspace, {
      version: "1.0.0",
      declarations: "export declare const value: string;\n",
    });

    const snapshot = runBreakCheck(["snapshot", "-c", configPath]);

    assert.equal(snapshot.status, 0, snapshot.stderr);

    const metadataPath = join(
      workspace,
      "snapshots",
      "demo__pkg",
      "break-check.snapshot.json",
    );
    const metadata = JSON.parse(readFileSync(metadataPath, "utf-8"));
    assert.equal(metadata.version, "1.0.0");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("detect: an all-skipped current build still records skipped entries and fails --fail-on-skipped", () => {
  const workspace = createWorkspace();

  try {
    const configPath = writeConfig(workspace);

    // Valid baseline so detect has something to compare against.
    writePackage(workspace, {
      version: "1.0.0",
      declarations: "export declare function go(name: string): void;\n",
    });
    const snapshot = runBreakCheck([
      "snapshot",
      "-c",
      configPath,
      "-o",
      "baseline",
    ]);
    assert.equal(snapshot.status, 0, snapshot.stderr);

    // Current build whose only entry fails extraction (references an undefined
    // type, so API Extractor errors and the entry is skipped). Every current
    // entry skipped means zero current snapshots: the path that previously
    // returned an empty result and dropped the skip signal entirely.
    writePackage(workspace, {
      version: "1.0.1",
      declarations: "export declare const x: MissingType;\n",
    });
    const detect = runBreakCheck([
      "detect",
      "-c",
      configPath,
      "--baseline",
      "baseline",
      "--format",
      "json",
      "--no-ai",
      "--fail-on-skipped",
    ]);

    // The skip must surface and --fail-on-skipped must fire, not silently report
    // "no changes" for a surface break-check never actually read.
    assert.equal(detect.status, 1, detect.stderr);
    const result = JSON.parse(detect.stdout);
    assert.equal(result.hasBreakingChanges, false);
    assert.ok(
      result.skippedEntries && result.skippedEntries.length === 1,
      "the skipped entry must be recorded even when every entry failed",
    );
    assert.match(detect.stderr, /could not be snapshotted/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("snapshot fails when a configured package has no declarations", () => {
  const workspace = createWorkspace();

  try {
    const configPath = writeConfig(workspace);
    writePackage(workspace, {
      version: "1.0.0",
      withTypes: false,
    });

    const snapshot = runBreakCheck(["snapshot", "-c", configPath]);

    assert.equal(snapshot.status, 1);
    assert.match(snapshot.stderr, /no TypeScript declarations found/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("init writes a default config that loadConfig accepts", () => {
  const workspace = createWorkspace();

  try {
    const result = runBreakCheck(["init"], workspace);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Created/);

    const configPath = join(workspace, "break-check.config.json");
    assert.ok(existsSync(configPath), "config file should be written");

    // The generated file must round-trip through the loader/validator, which
    // guards against createDefaultConfig drifting away from the zod schema.
    const config = loadConfig(configPath);
    assert.deepEqual(config.packages, ["packages/my-package"]);
    assert.equal(config.mainBranch, "main");
    assert.equal(config.outputFormat, "markdown");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("init refuses to overwrite an existing config without --force", () => {
  const workspace = createWorkspace();

  try {
    const first = runBreakCheck(["init"], workspace);
    assert.equal(first.status, 0, first.stderr);

    const second = runBreakCheck(["init"], workspace);
    assert.equal(second.status, 1);
    assert.match(second.stderr, /already exists/);
    assert.match(second.stderr, /--force/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("init --force overwrites an existing config", () => {
  const workspace = createWorkspace();

  try {
    const configPath = join(workspace, "break-check.config.json");
    // Seed a file the loader would reject, to prove --force actually rewrites it.
    writeFileSync(configPath, "{ not valid json }\n");

    const result = runBreakCheck(["init", "--force"], workspace);
    assert.equal(result.status, 0, result.stderr);

    const config = loadConfig(configPath);
    assert.deepEqual(config.packages, ["packages/my-package"]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("init -o writes the config to a custom path", () => {
  const workspace = createWorkspace();

  try {
    const result = runBreakCheck(
      ["init", "-o", "custom.config.json"],
      workspace,
    );
    assert.equal(result.status, 0, result.stderr);

    const customPath = join(workspace, "custom.config.json");
    assert.ok(existsSync(customPath), "custom config path should be written");
    assert.ok(
      !existsSync(join(workspace, "break-check.config.json")),
      "default path should not be written when -o is given",
    );

    const config = loadConfig(customPath);
    assert.equal(config.mainBranch, "main");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("detect refuses a baseline that is the configured snapshotDir", () => {
  const workspace = createWorkspace();

  try {
    const configPath = writeConfig(workspace); // snapshotDir: "snapshots"
    writePackage(workspace, {
      version: "1.0.0",
      declarations: "export declare const value: number;\n",
    });

    // Write a "baseline" into the snapshot dir itself, then point detect at
    // it. detect regenerates current snapshots into snapshotDir before
    // reading the baseline, so without the guard this would overwrite the
    // baseline and self-compare, reporting no changes for any break.
    const snapshot = runBreakCheck(["snapshot", "-c", configPath]);
    assert.equal(snapshot.status, 0, snapshot.stderr);

    const detect = runBreakCheck([
      "detect",
      "-c",
      configPath,
      "--baseline",
      "snapshots",
      "--no-ai",
    ]);
    assert.equal(detect.status, 1);
    assert.match(detect.stderr, /resolve to the same path/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
