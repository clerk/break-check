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

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(repoRoot, "dist", "cli.js");

function runSnapi(args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf-8",
  });
}

function createWorkspace() {
  return mkdtempSync(join(tmpdir(), "snapi-test-"));
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
  const configPath = join(workspace, "snapi.config.json");
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

    const snapshot = runSnapi(["snapshot", "-c", configPath, "-o", "baseline"]);
    assert.equal(snapshot.status, 0, snapshot.stderr);
    assert.ok(
      existsSync(
        join(workspace, "baseline", "demo__pkg", "snapi.snapshot.json"),
      ),
    );

    writePackage(workspace, {
      version: "1.1.0",
      declarations:
        "export interface User {\n  id: string;\n}\nexport declare function getUser(id: string): User;\nexport declare function listUsers(): User[];\n",
    });

    const detect = runSnapi([
      "detect",
      "-c",
      configPath,
      "--baseline",
      "baseline",
      "--format",
      "json",
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

test("snapshot supports declaration packages without a tsconfig", () => {
  const workspace = createWorkspace();

  try {
    const configPath = writeConfig(workspace);
    writePackage(workspace, {
      version: "1.0.0",
      declarations: "export declare const value: string;\n",
    });

    const snapshot = runSnapi(["snapshot", "-c", configPath]);

    assert.equal(snapshot.status, 0, snapshot.stderr);

    const metadataPath = join(
      workspace,
      "snapshots",
      "demo__pkg",
      "snapi.snapshot.json",
    );
    const metadata = JSON.parse(readFileSync(metadataPath, "utf-8"));
    assert.equal(metadata.version, "1.0.0");
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

    const snapshot = runSnapi(["snapshot", "-c", configPath]);

    assert.equal(snapshot.status, 1);
    assert.match(snapshot.stderr, /no TypeScript declarations found/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
