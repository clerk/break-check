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

function runBreakCheck(args, opts = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: opts.cwd ?? repoRoot,
    encoding: "utf-8",
  });
}

function workspaceDir() {
  return mkdtempSync(join(tmpdir(), "break-check-skew-"));
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

test("snapshot metadata records break-check and API Extractor producer versions", () => {
  const workspace = workspaceDir();
  try {
    const configPath = writeConfig(workspace);
    writeMinimalPackage(workspace, {
      version: "1.0.0",
      body: "export declare const root: number;\n",
    });

    const snapshot = runBreakCheck(["snapshot", "-c", configPath]);
    assert.equal(snapshot.status, 0, snapshot.stderr);

    const metadataPath = join(
      workspace,
      "snapshots",
      "demo__pkg",
      "break-check.snapshot.json",
    );
    assert.ok(existsSync(metadataPath));
    const metadata = JSON.parse(readFileSync(metadataPath, "utf-8"));

    assert.equal(metadata.schemaVersion, 4);
    assert.equal(metadata.apiExtractorPackage, "@microsoft/api-extractor");
    assert.match(metadata.apiExtractorVersion, /^\d+\.\d+\.\d+/);
    assert.match(metadata.breakCheckVersion, /^\d+\.\d+\.\d+/);
    assert.equal(typeof metadata.discoveryVersion, "number");
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

    const baseline = runBreakCheck([
      "snapshot",
      "-c",
      configPath,
      "-o",
      "baseline",
    ]);
    assert.equal(baseline.status, 0, baseline.stderr);

    // Rewrite the baseline metadata to claim it was produced by a different
    // AE major. The .api.json shape is still current break-check's, but the
    // recorded producer version is what we check.
    const metadataPath = join(
      workspace,
      "baseline",
      "demo__pkg",
      "break-check.snapshot.json",
    );
    const metadata = JSON.parse(readFileSync(metadataPath, "utf-8"));
    metadata.apiExtractorVersion = "6.0.0";
    writeJson(metadataPath, metadata);

    const detect = runBreakCheck([
      "detect",
      "-c",
      configPath,
      "--baseline",
      "baseline",
      "--format",
      "json",
      "--no-ai",
    ]);

    assert.equal(detect.status, 3, detect.stderr);
    assert.match(
      detect.stderr,
      /major version mismatch|@microsoft\/api-extractor/i,
    );
    assert.match(detect.stderr, /Regenerate the baseline/i);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("detect refuses a baseline whose discovery version is older", () => {
  const workspace = workspaceDir();
  try {
    const configPath = writeConfig(workspace);
    writeMinimalPackage(workspace, {
      version: "1.0.0",
      body: "export declare const root: number;\n",
    });

    const baseline = runBreakCheck([
      "snapshot",
      "-c",
      configPath,
      "-o",
      "baseline",
    ]);
    assert.equal(baseline.status, 0, baseline.stderr);

    // Rewrite the baseline metadata to claim an older discovery version,
    // simulating a baseline produced before a discovery-semantics change
    // (e.g. before wildcard subpath expansion enumerated more subpaths).
    const metadataPath = join(
      workspace,
      "baseline",
      "demo__pkg",
      "break-check.snapshot.json",
    );
    const metadata = JSON.parse(readFileSync(metadataPath, "utf-8"));
    metadata.discoveryVersion = 0;
    writeJson(metadataPath, metadata);

    const detect = runBreakCheck([
      "detect",
      "-c",
      configPath,
      "--baseline",
      "baseline",
      "--format",
      "json",
      "--no-ai",
    ]);

    assert.equal(detect.status, 3, detect.stderr);
    assert.match(detect.stderr, /discovery version/i);
    assert.match(detect.stderr, /Regenerate the baseline/i);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("detect refuses a producer-stamped baseline that predates discovery stamping", () => {
  const workspace = workspaceDir();
  try {
    const configPath = writeConfig(workspace);
    writeMinimalPackage(workspace, {
      version: "1.0.0",
      body: "export declare const root: number;\n",
    });

    const baseline = runBreakCheck([
      "snapshot",
      "-c",
      configPath,
      "-o",
      "baseline",
    ]);
    assert.equal(baseline.status, 0, baseline.stderr);

    // Simulate a baseline from the producer-stamp era (schemaVersion 3) that
    // predates discovery-version stamping: keep the API Extractor stamp but
    // drop the discovery stamp and downgrade schemaVersion to 3. We cannot
    // prove its surface matches the running discovery, so it must be refused.
    const metadataPath = join(
      workspace,
      "baseline",
      "demo__pkg",
      "break-check.snapshot.json",
    );
    const metadata = JSON.parse(readFileSync(metadataPath, "utf-8"));
    delete metadata.discoveryVersion;
    metadata.schemaVersion = 3;
    writeJson(metadataPath, metadata);

    const detect = runBreakCheck([
      "detect",
      "-c",
      configPath,
      "--baseline",
      "baseline",
      "--format",
      "json",
      "--no-ai",
    ]);

    assert.equal(detect.status, 3, detect.stderr);
    assert.match(
      detect.stderr,
      /predates break-check discovery-version stamping/i,
    );
    assert.match(detect.stderr, /Regenerate the baseline/i);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("detect recovers (exit 3 -> regenerate -> success) on an incompatible baseline", () => {
  // Mirrors what the CI workflows automate: a refused baseline exits 3, the
  // baseline is regenerated with the current break-check, and detect then succeeds.
  const workspace = workspaceDir();
  try {
    const configPath = writeConfig(workspace);
    writeMinimalPackage(workspace, {
      version: "1.0.0",
      body: "export declare const root: number;\n",
    });

    const baseline = runBreakCheck([
      "snapshot",
      "-c",
      configPath,
      "-o",
      "baseline",
    ]);
    assert.equal(baseline.status, 0, baseline.stderr);

    // Age the recorded discovery version so detect refuses the baseline.
    const metadataPath = join(
      workspace,
      "baseline",
      "demo__pkg",
      "break-check.snapshot.json",
    );
    const metadata = JSON.parse(readFileSync(metadataPath, "utf-8"));
    metadata.discoveryVersion = 0;
    writeJson(metadataPath, metadata);

    const detectArgs = [
      "detect",
      "-c",
      configPath,
      "--baseline",
      "baseline",
      "--format",
      "json",
      "--no-ai",
    ];

    const refused = runBreakCheck(detectArgs);
    assert.equal(refused.status, 3, refused.stderr);

    // Recompute the baseline with the current break-check (the recovery step), then
    // detect succeeds against the now-compatible baseline.
    const regen = runBreakCheck([
      "snapshot",
      "-c",
      configPath,
      "-o",
      "baseline",
    ]);
    assert.equal(regen.status, 0, regen.stderr);

    const detect = runBreakCheck(detectArgs);
    assert.equal(detect.status, 0, detect.stderr);
    const result = JSON.parse(detect.stdout);
    assert.equal(result.summary.breakingChanges, 0);
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

    const baseline = runBreakCheck([
      "snapshot",
      "-c",
      configPath,
      "-o",
      "baseline",
    ]);
    assert.equal(baseline.status, 0, baseline.stderr);

    // Simulate a baseline produced by an older break-check by dropping the producer
    // fields and downgrading schemaVersion.
    const metadataPath = join(
      workspace,
      "baseline",
      "demo__pkg",
      "break-check.snapshot.json",
    );
    const metadata = JSON.parse(readFileSync(metadataPath, "utf-8"));
    delete metadata.apiExtractorVersion;
    delete metadata.apiExtractorPackage;
    delete metadata.breakCheckVersion;
    metadata.schemaVersion = 2;
    writeJson(metadataPath, metadata);

    const detect = runBreakCheck([
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

test("detect ignores baseline metadata entries with path-traversal filenames", () => {
  const workspace = workspaceDir();
  try {
    // Version-bump checking off so the exit status reflects only how the
    // traversal entry is handled, not unrelated version-bump noise.
    const configPath = join(workspace, "break-check.config.json");
    writeJson(configPath, {
      packages: ["packages/pkg"],
      snapshotDir: "snapshots",
      mainBranch: "main",
      checkVersionBump: false,
      outputFormat: "markdown",
    });
    writeMinimalPackage(workspace, {
      version: "1.0.0",
      body: "export declare const root: number;\n",
    });

    const baseline = runBreakCheck([
      "snapshot",
      "-c",
      configPath,
      "-o",
      "baseline",
    ]);
    assert.equal(baseline.status, 0, baseline.stderr);

    // Plant a sentinel outside the baseline package directory and point the
    // recorded apiJsonFile at it via a `../../` traversal. Without the
    // containment guard, readSnapshotMetadata path.joins this onto the package
    // dir, escapes to the sentinel, and reads it (its contents could then leak
    // into the diff or the AI surface payload). With the guard the entry is
    // dropped, so the package simply reads as having no baseline.
    const sentinelPath = join(workspace, "SECRET.txt");
    writeFileSync(sentinelPath, "SENTINEL-DO-NOT-LEAK\n");

    const metadataPath = join(
      workspace,
      "baseline",
      "demo__pkg",
      "break-check.snapshot.json",
    );
    const metadata = JSON.parse(readFileSync(metadataPath, "utf-8"));
    metadata.entries = metadata.entries.map((entry) => ({
      ...entry,
      apiJsonFile: "../../SECRET.txt",
    }));
    writeJson(metadataPath, metadata);

    const detect = runBreakCheck([
      "detect",
      "-c",
      configPath,
      "--baseline",
      "baseline",
      "--format",
      "json",
      "--no-ai",
    ]);

    // The traversal entry is ignored, so detect completes cleanly (it never
    // tries to JSON.parse the sentinel) and the sentinel never surfaces in the
    // output. Without the guard, parsing the sentinel as api.json throws and
    // this would exit non-zero.
    assert.equal(detect.status, 0, detect.stderr);
    const combined = `${detect.stdout}${detect.stderr}`;
    assert.doesNotMatch(combined, /SENTINEL-DO-NOT-LEAK/);
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

    const baseline = runBreakCheck([
      "snapshot",
      "-c",
      configPath,
      "-o",
      "baseline",
    ]);
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

    const detect = runBreakCheck([
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
