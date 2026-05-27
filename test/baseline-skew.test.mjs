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

function runSnapi(args, opts = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: opts.cwd ?? repoRoot,
    encoding: "utf-8",
  });
}

function workspaceDir() {
  return mkdtempSync(join(tmpdir(), "snapi-skew-"));
}

function writeJson(filePath, value) {
  writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n");
}

function writeDts(filePath, contents) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents);
}

function writeMinimalPackage(workspace, { version, body }) {
  const packageDir = join(workspace, "packages", "pkg");
  mkdirSync(packageDir, { recursive: true });
  writeDts(join(packageDir, "dist/index.d.ts"), body);
  writeJson(join(packageDir, "package.json"), {
    name: "@demo/pkg",
    version,
    exports: { ".": { import: { types: "./dist/index.d.ts" } } },
  });
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

test("snapshot metadata records snapi and API Extractor producer versions", () => {
  const workspace = workspaceDir();
  try {
    const configPath = writeConfig(workspace);
    writeMinimalPackage(workspace, {
      version: "1.0.0",
      body: "export declare const root: number;\n",
    });

    const snapshot = runSnapi(["snapshot", "-c", configPath]);
    assert.equal(snapshot.status, 0, snapshot.stderr);

    const metadataPath = join(
      workspace,
      "snapshots",
      "demo__pkg",
      "snapi.snapshot.json",
    );
    assert.ok(existsSync(metadataPath));
    const metadata = JSON.parse(readFileSync(metadataPath, "utf-8"));

    assert.equal(metadata.schemaVersion, 3);
    assert.equal(metadata.apiExtractorPackage, "@microsoft/api-extractor");
    assert.match(metadata.apiExtractorVersion, /^\d+\.\d+\.\d+/);
    assert.match(metadata.snapiVersion, /^\d+\.\d+\.\d+/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("detect refuses a baseline whose API Extractor major differs", () => {
  const workspace = workspaceDir();
  try {
    const configPath = writeConfig(workspace);
    writeMinimalPackage(workspace, {
      version: "1.0.0",
      body: "export declare const root: number;\n",
    });

    const baseline = runSnapi(["snapshot", "-c", configPath, "-o", "baseline"]);
    assert.equal(baseline.status, 0, baseline.stderr);

    // Rewrite the baseline metadata to claim it was produced by a different
    // AE major. The .api.json shape is still current snapi's, but the
    // recorded producer version is what we check.
    const metadataPath = join(
      workspace,
      "baseline",
      "demo__pkg",
      "snapi.snapshot.json",
    );
    const metadata = JSON.parse(readFileSync(metadataPath, "utf-8"));
    metadata.apiExtractorVersion = "6.0.0";
    writeJson(metadataPath, metadata);

    const detect = runSnapi([
      "detect",
      "-c",
      configPath,
      "--baseline",
      "baseline",
      "--format",
      "json",
      "--no-ai",
    ]);

    assert.notEqual(detect.status, 0);
    assert.match(
      detect.stderr,
      /major version mismatch|@microsoft\/api-extractor/i,
    );
    assert.match(detect.stderr, /Regenerate the baseline/i);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("detect warns but proceeds for a legacy baseline without producer stamp", () => {
  const workspace = workspaceDir();
  try {
    const configPath = writeConfig(workspace);
    writeMinimalPackage(workspace, {
      version: "1.0.0",
      body: "export declare const root: number;\n",
    });

    const baseline = runSnapi(["snapshot", "-c", configPath, "-o", "baseline"]);
    assert.equal(baseline.status, 0, baseline.stderr);

    // Simulate a baseline produced by an older snapi by dropping the producer
    // fields and downgrading schemaVersion.
    const metadataPath = join(
      workspace,
      "baseline",
      "demo__pkg",
      "snapi.snapshot.json",
    );
    const metadata = JSON.parse(readFileSync(metadataPath, "utf-8"));
    delete metadata.apiExtractorVersion;
    delete metadata.apiExtractorPackage;
    delete metadata.snapiVersion;
    metadata.schemaVersion = 2;
    writeJson(metadataPath, metadata);

    const detect = runSnapi([
      "detect",
      "-c",
      configPath,
      "--baseline",
      "baseline",
      "--format",
      "json",
      "--no-ai",
    ]);

    assert.equal(detect.status, 0, detect.stderr);
    assert.match(detect.stderr, /predates producer-version stamping/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("parseApiJson throws when the file shape is unrecognized", () => {
  const workspace = workspaceDir();
  try {
    const configPath = writeConfig(workspace);
    writeMinimalPackage(workspace, {
      version: "1.0.0",
      body: "export declare const root: number;\n",
    });

    const baseline = runSnapi(["snapshot", "-c", configPath, "-o", "baseline"]);
    assert.equal(baseline.status, 0, baseline.stderr);

    // Corrupt the api.json so the toolPackage check fails.
    const apiJsonPath = join(
      workspace,
      "baseline",
      "demo__pkg",
      "demo__pkg___root.api.json",
    );
    writeFileSync(
      apiJsonPath,
      JSON.stringify({ metadata: { toolPackage: "something-else" } }),
    );

    const detect = runSnapi([
      "detect",
      "-c",
      configPath,
      "--baseline",
      "baseline",
      "--format",
      "json",
      "--no-ai",
    ]);

    assert.notEqual(detect.status, 0);
    assert.match(detect.stderr, /Unrecognized API JSON/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
