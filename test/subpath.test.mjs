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

function workspaceDir() {
  return mkdtempSync(join(tmpdir(), "snapi-subpath-"));
}

function writeJson(filePath, value) {
  writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n");
}

function writeDts(filePath, contents) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents);
}

function writeConfig(workspace, overrides = {}) {
  const configPath = join(workspace, "snapi.config.json");
  writeJson(configPath, {
    packages: ["packages/pkg"],
    snapshotDir: "snapshots",
    mainBranch: "main",
    checkVersionBump: true,
    outputFormat: "markdown",
    ...overrides,
  });
  return configPath;
}

/**
 * Mirror @clerk/shared shape: no `types`/`main`, every API surface lives
 * under a subpath in the exports map. Includes a wildcard that must be
 * skipped silently.
 */
function writeSubpathOnlyPackage(workspace, { version, surfaces }) {
  const packageDir = join(workspace, "packages", "pkg");
  mkdirSync(packageDir, { recursive: true });

  const exports = {};
  for (const [subpath, body] of Object.entries(surfaces.dts)) {
    const slug =
      subpath === "."
        ? "index"
        : subpath.replace(/^\.\//, "").replace(/\//g, "_");
    const file = `./dist/${slug}.d.ts`;
    writeDts(join(packageDir, file.slice(2)), body);
    exports[subpath] = { import: { types: file } };
  }
  for (const wildcard of surfaces.wildcards ?? []) {
    exports[wildcard] = { import: { types: "./dist/wild/*.d.ts" } };
  }
  exports["./package.json"] = "./package.json";

  writeJson(join(packageDir, "package.json"), {
    name: "@demo/pkg",
    version,
    exports,
  });
}

test("snapshot generates one .api.json per non-wildcard subpath", () => {
  const workspace = workspaceDir();
  try {
    const configPath = writeConfig(workspace);
    writeSubpathOnlyPackage(workspace, {
      version: "1.0.0",
      surfaces: {
        dts: {
          ".": "export declare const root: number;\n",
          "./react": "export declare function useFoo(): string;\n",
          "./errors": "export declare class FooError extends Error {}\n",
        },
        wildcards: ["./*"],
      },
    });

    const snapshot = runSnapi(["snapshot", "-c", configPath]);
    assert.equal(snapshot.status, 0, snapshot.stderr);

    const pkgDir = join(workspace, "snapshots", "demo__pkg");
    for (const slug of ["_root", "react", "errors"]) {
      assert.ok(
        existsSync(join(pkgDir, `demo__pkg__${slug}.api.json`)),
        `expected api.json for ${slug}`,
      );
    }

    const metadata = JSON.parse(
      readFileSync(join(pkgDir, "snapi.snapshot.json"), "utf-8"),
    );
    assert.equal(metadata.schemaVersion, 2);
    assert.equal(metadata.entries.length, 3);
    const subpaths = metadata.entries.map((e) => e.subpath).sort();
    assert.deepEqual(subpaths, [".", "./errors", "./react"]);
    assert.match(snapshot.stdout, /3 snapshot\(s\) across 1 package/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("detect surfaces breaking changes per subpath", () => {
  const workspace = workspaceDir();
  try {
    const configPath = writeConfig(workspace);

    writeSubpathOnlyPackage(workspace, {
      version: "1.0.0",
      surfaces: {
        dts: {
          ".": "export declare const root: number;\n",
          "./react": "export declare function useFoo(id: string): string;\n",
        },
      },
    });

    const baseline = runSnapi(["snapshot", "-c", configPath, "-o", "baseline"]);
    assert.equal(baseline.status, 0, baseline.stderr);

    // Change ./react's signature so the diff is breaking
    writeSubpathOnlyPackage(workspace, {
      version: "1.0.0",
      surfaces: {
        dts: {
          ".": "export declare const root: number;\n",
          "./react": "export declare function useFoo(id: number): string;\n",
        },
      },
    });

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

    const result = JSON.parse(detect.stdout);
    assert.equal(result.summary.totalPackages, 1);
    assert.equal(result.summary.breakingChanges, 1);

    const breaking = result.packages[0].changes.find(
      (c) => c.type === "breaking",
    );
    assert.ok(breaking, "expected a breaking change");
    assert.equal(breaking.subpath, "./react");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("detect flags a removed subpath as breaking", () => {
  const workspace = workspaceDir();
  try {
    const configPath = writeConfig(workspace);

    writeSubpathOnlyPackage(workspace, {
      version: "1.0.0",
      surfaces: {
        dts: {
          ".": "export declare const root: number;\n",
          "./removed": "export declare const goneSoon: boolean;\n",
        },
      },
    });

    const baseline = runSnapi(["snapshot", "-c", configPath, "-o", "baseline"]);
    assert.equal(baseline.status, 0, baseline.stderr);

    writeSubpathOnlyPackage(workspace, {
      version: "1.0.0",
      surfaces: {
        dts: {
          ".": "export declare const root: number;\n",
        },
      },
    });

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

    const result = JSON.parse(detect.stdout);
    const removalChange = result.packages[0].changes.find(
      (c) => c.subpath === "./removed",
    );
    assert.ok(removalChange, "expected a removal change for ./removed");
    assert.equal(removalChange.type, "breaking");
    assert.match(
      removalChange.description,
      /Subpath export `\.\/removed` was removed/,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("detect reports a newly added subpath as additions, not breaking", () => {
  const workspace = workspaceDir();
  try {
    const configPath = writeConfig(workspace);

    writeSubpathOnlyPackage(workspace, {
      version: "1.0.0",
      surfaces: {
        dts: { ".": "export declare const root: number;\n" },
      },
    });

    const baseline = runSnapi(["snapshot", "-c", configPath, "-o", "baseline"]);
    assert.equal(baseline.status, 0, baseline.stderr);

    writeSubpathOnlyPackage(workspace, {
      version: "1.1.0",
      surfaces: {
        dts: {
          ".": "export declare const root: number;\n",
          "./new-thing": "export declare const fresh: boolean;\n",
        },
      },
    });

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

    const result = JSON.parse(detect.stdout);
    assert.equal(result.summary.breakingChanges, 0);
    assert.ok(
      result.summary.additions >= 1,
      "expected at least one addition entry for the new subpath",
    );

    const additions = result.packages[0].changes.filter(
      (c) => c.type === "addition" && c.subpath === "./new-thing",
    );
    assert.ok(
      additions.length >= 1,
      "expected the new ./new-thing surface to appear as an addition with the right subpath tag",
    );
    assert.equal(
      result.packages[0].recommendedVersionBump,
      "minor",
      "additions in a new subpath should require at least a minor bump",
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("ignoreSubpaths suppresses removals for ignored baseline subpaths", () => {
  const workspace = workspaceDir();
  try {
    // First run: no ignoreSubpaths, baseline contains ./types.
    const configPath = writeConfig(workspace);
    writeSubpathOnlyPackage(workspace, {
      version: "1.0.0",
      surfaces: {
        dts: {
          ".": "export declare const root: number;\n",
          "./types": "export type Foo = string;\n",
        },
      },
    });
    const baseline = runSnapi(["snapshot", "-c", configPath, "-o", "baseline"]);
    assert.equal(baseline.status, 0, baseline.stderr);

    // Second run: rewrite config to ignore ./types and drop the subpath
    // from the package. The baseline still has it. We should NOT see a
    // "removed" break, because the user opted out of tracking ./types.
    writeConfig(workspace, { ignoreSubpaths: ["./types"] });
    writeSubpathOnlyPackage(workspace, {
      version: "1.0.0",
      surfaces: {
        dts: {
          ".": "export declare const root: number;\n",
        },
      },
    });

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

    const result = JSON.parse(detect.stdout);
    assert.equal(
      result.summary.breakingChanges,
      0,
      "ignored baseline subpath should not produce a removal break",
    );

    const removalForTypes = result.packages[0].changes.find(
      (c) => c.subpath === "./types",
    );
    assert.equal(
      removalForTypes,
      undefined,
      "ignored subpath should not appear in the change list at all",
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("detect reads v1 baseline metadata as a root-only entry", () => {
  const workspace = workspaceDir();
  try {
    const configPath = writeConfig(workspace);

    // Fabricate a legacy v1 baseline directory: only `<safe>.api.json` and
    // a v1-shaped metadata file. snapi's writer no longer produces this
    // layout, but already-cached baselines from earlier runs still use it.
    const baselineDir = join(workspace, "baseline", "demo__pkg");
    mkdirSync(baselineDir, { recursive: true });
    writeJson(join(baselineDir, "snapi.snapshot.json"), {
      schemaVersion: 1,
      packageName: "@demo/pkg",
      packagePath: join(workspace, "packages", "pkg"),
      version: "1.0.0",
      timestamp: new Date().toISOString(),
      apiJsonFile: "demo__pkg.api.json",
      apiReportFile: null,
    });
    // Generate a real api.json by running snapi on the v1 layout
    writeSubpathOnlyPackage(workspace, {
      version: "1.0.0",
      surfaces: {
        dts: { ".": "export declare const root: number;\n" },
      },
    });
    const stage = runSnapi([
      "snapshot",
      "-c",
      configPath,
      "-o",
      "tmp-baseline",
    ]);
    assert.equal(stage.status, 0, stage.stderr);
    // Move the generated _root file into the legacy filename
    const generated = join(
      workspace,
      "tmp-baseline",
      "demo__pkg",
      "demo__pkg___root.api.json",
    );
    writeFileSync(
      join(baselineDir, "demo__pkg.api.json"),
      readFileSync(generated),
    );

    // Now bump the package and detect against the v1 baseline.
    writeSubpathOnlyPackage(workspace, {
      version: "1.0.1",
      surfaces: {
        dts: { ".": "export declare const root: number;\n" },
      },
    });

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

    const result = JSON.parse(detect.stdout);
    assert.equal(result.summary.totalPackages, 1);
    assert.equal(result.summary.breakingChanges, 0);
    assert.equal(result.packages[0].version.previous, "1.0.0");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("ignoreSubpaths drops matching subpaths from discovery", () => {
  const workspace = workspaceDir();
  try {
    const configPath = writeConfig(workspace, {
      ignoreSubpaths: ["./types"],
    });

    writeSubpathOnlyPackage(workspace, {
      version: "1.0.0",
      surfaces: {
        dts: {
          ".": "export declare const root: number;\n",
          "./types": "export type Foo = string;\n",
        },
      },
    });

    const snapshot = runSnapi(["snapshot", "-c", configPath]);
    assert.equal(snapshot.status, 0, snapshot.stderr);

    const metadata = JSON.parse(
      readFileSync(
        join(workspace, "snapshots", "demo__pkg", "snapi.snapshot.json"),
        "utf-8",
      ),
    );
    const subpaths = metadata.entries.map((e) => e.subpath);
    assert.deepEqual(subpaths, ["."]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
