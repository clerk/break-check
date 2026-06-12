import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { makeScopedSubpathMatcher } from "../dist/utils/api-extractor.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(repoRoot, "dist", "cli.js");

function runBreakCheck(args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf-8",
  });
}

function workspaceDir() {
  return mkdtempSync(join(tmpdir(), "break-check-subpath-"));
}

function writeJson(filePath, value) {
  writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n");
}

function writeDts(filePath, contents) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents);
}

function writeConfig(workspace, overrides = {}) {
  const configPath = join(workspace, "break-check.config.json");
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

    const snapshot = runBreakCheck(["snapshot", "-c", configPath]);
    assert.equal(snapshot.status, 0, snapshot.stderr);

    const pkgDir = join(workspace, "snapshots", "demo__pkg");
    for (const slug of ["_root", "react", "errors"]) {
      assert.ok(
        existsSync(join(pkgDir, `demo__pkg__${slug}.api.json`)),
        `expected api.json for ${slug}`,
      );
    }

    const metadata = JSON.parse(
      readFileSync(join(pkgDir, "break-check.snapshot.json"), "utf-8"),
    );
    assert.equal(metadata.schemaVersion, 4);
    assert.equal(metadata.apiExtractorPackage, "@microsoft/api-extractor");
    assert.match(metadata.apiExtractorVersion, /^\d+\.\d+\.\d+/);
    assert.match(metadata.breakCheckVersion, /^\d+\.\d+\.\d+/);
    assert.equal(typeof metadata.discoveryVersion, "number");
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

    const baseline = runBreakCheck([
      "snapshot",
      "-c",
      configPath,
      "-o",
      "baseline",
    ]);
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

    const baseline = runBreakCheck([
      "snapshot",
      "-c",
      configPath,
      "-o",
      "baseline",
    ]);
    assert.equal(baseline.status, 0, baseline.stderr);

    writeSubpathOnlyPackage(workspace, {
      version: "1.0.0",
      surfaces: {
        dts: {
          ".": "export declare const root: number;\n",
        },
      },
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

    const baseline = runBreakCheck([
      "snapshot",
      "-c",
      configPath,
      "-o",
      "baseline",
    ]);
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

test("detect collapses a newly enumerated subpath to a single addition, not one per member", () => {
  // Regression for issue #40: an already-baselined package that gains a
  // subpath (coverage bump or a discovery change that newly enumerates it)
  // must not diff every member against an empty baseline and flood the report
  // with one addition per export.
  const workspace = workspaceDir();
  try {
    const configPath = writeConfig(workspace);

    writeSubpathOnlyPackage(workspace, {
      version: "1.0.0",
      surfaces: {
        dts: { ".": "export declare const root: number;\n" },
      },
    });

    const baseline = runBreakCheck([
      "snapshot",
      "-c",
      configPath,
      "-o",
      "baseline",
    ]);
    assert.equal(baseline.status, 0, baseline.stderr);

    const manyMembers =
      Array.from(
        { length: 30 },
        (_, i) => `export declare const member${i}: number;`,
      ).join("\n") + "\n";

    writeSubpathOnlyPackage(workspace, {
      version: "1.1.0",
      surfaces: {
        dts: {
          ".": "export declare const root: number;\n",
          "./big": manyMembers,
        },
      },
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
    ]);
    assert.equal(detect.status, 0, detect.stderr);

    const result = JSON.parse(detect.stdout);
    assert.equal(result.summary.breakingChanges, 0);
    assert.equal(
      result.summary.additions,
      1,
      "the 30-member subpath should produce exactly one addition, not a flood",
    );

    const bigChanges = result.packages[0].changes.filter(
      (c) => c.subpath === "./big",
    );
    assert.equal(bigChanges.length, 1);
    assert.equal(bigChanges[0].type, "addition");
    assert.match(bigChanges[0].description, /New subpath export `\.\/big`/);
    assert.equal(result.packages[0].recommendedVersionBump, "minor");
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
    const baseline = runBreakCheck([
      "snapshot",
      "-c",
      configPath,
      "-o",
      "baseline",
    ]);
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
    // a v1-shaped metadata file. break-check's writer no longer produces this
    // layout, but already-cached baselines from earlier runs still use it.
    const baselineDir = join(workspace, "baseline", "demo__pkg");
    mkdirSync(baselineDir, { recursive: true });
    writeJson(join(baselineDir, "break-check.snapshot.json"), {
      schemaVersion: 1,
      packageName: "@demo/pkg",
      packagePath: join(workspace, "packages", "pkg"),
      version: "1.0.0",
      timestamp: new Date().toISOString(),
      apiJsonFile: "demo__pkg.api.json",
      apiReportFile: null,
    });
    // Generate a real api.json by running break-check on the v1 layout
    writeSubpathOnlyPackage(workspace, {
      version: "1.0.0",
      surfaces: {
        dts: { ".": "export declare const root: number;\n" },
      },
    });
    const stage = runBreakCheck([
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

    const result = JSON.parse(detect.stdout);
    assert.equal(result.summary.totalPackages, 1);
    assert.equal(result.summary.breakingChanges, 0);
    assert.equal(result.packages[0].version.previous, "1.0.0");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("snapshot expands wildcard subpath exports against the filesystem", () => {
  const workspace = workspaceDir();
  try {
    const configPath = writeConfig(workspace);
    // Mirror @clerk/shared: `./*` wildcard pointing into `./dist/runtime/`.
    // Three concrete files there → three concrete subpaths the consumer
    // can import. The wildcard itself must not appear as a literal entry.
    const packageDir = join(workspace, "packages", "pkg");
    mkdirSync(packageDir, { recursive: true });
    writeDts(
      join(packageDir, "dist/runtime/file.d.mts"),
      "export declare function readFile(): string;\n",
    );
    writeDts(
      join(packageDir, "dist/runtime/url.d.mts"),
      "export declare function parseUrl(): URL;\n",
    );
    writeDts(
      join(packageDir, "dist/runtime/error.d.mts"),
      "export declare class FooError extends Error {}\n",
    );
    writeDts(
      join(packageDir, "dist/index.d.ts"),
      "export declare const root: number;\n",
    );
    writeJson(join(packageDir, "package.json"), {
      name: "@demo/pkg",
      version: "1.0.0",
      exports: {
        ".": { import: { types: "./dist/index.d.ts" } },
        "./*": { import: { types: "./dist/runtime/*.d.mts" } },
        "./package.json": "./package.json",
      },
    });

    const snapshot = runBreakCheck(["snapshot", "-c", configPath]);
    assert.equal(snapshot.status, 0, snapshot.stderr);

    const metadata = JSON.parse(
      readFileSync(
        join(workspace, "snapshots", "demo__pkg", "break-check.snapshot.json"),
        "utf-8",
      ),
    );
    // Assert the raw (unsorted) order: `.` from the literal key, then the
    // wildcard expansion sorted by subpath. `fs.globSync` order is not
    // stable across platforms, so the expansion must sort deterministically
    // or committed-baseline metadata churns between runners.
    const subpaths = metadata.entries.map((e) => e.subpath);
    assert.deepEqual(subpaths, [".", "./error", "./file", "./url"]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("detect surfaces a breaking change under a wildcard subpath", () => {
  const workspace = workspaceDir();
  try {
    const configPath = writeConfig(workspace);
    const packageDir = join(workspace, "packages", "pkg");
    mkdirSync(packageDir, { recursive: true });

    const writeWildcardPackage = (fileBody) => {
      writeDts(
        join(packageDir, "dist/index.d.ts"),
        "export declare const root: number;\n",
      );
      writeDts(join(packageDir, "dist/runtime/file.d.mts"), fileBody);
      writeJson(join(packageDir, "package.json"), {
        name: "@demo/pkg",
        version: "1.0.0",
        exports: {
          ".": { import: { types: "./dist/index.d.ts" } },
          "./*": { import: { types: "./dist/runtime/*.d.mts" } },
          "./package.json": "./package.json",
        },
      });
    };

    writeWildcardPackage("export declare function readJSONFile(): string;\n");
    const baseline = runBreakCheck([
      "snapshot",
      "-c",
      configPath,
      "-o",
      "baseline",
    ]);
    assert.equal(baseline.status, 0, baseline.stderr);

    // Rename the exported function: the rule-based diff classifies that as
    // removal + addition, both surfacing under `./file`.
    writeWildcardPackage("export declare function parseJSONFile(): string;\n");

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

    const result = JSON.parse(detect.stdout);
    const fileChanges = result.packages[0].changes.filter(
      (c) => c.subpath === "./file",
    );
    assert.ok(
      fileChanges.some((c) => c.type === "breaking"),
      "expected a breaking change under the wildcard-expanded ./file subpath",
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

/**
 * Build a package whose surface lives behind a `./*` wildcard pointing into
 * `dist/runtime`, mirroring a rolldown/tsdown layout. `runtime` maps a file
 * basename (e.g. `index-Dq-_K2VH`) to its `.d.mts` body; `root`, when given,
 * is the `.` entry body.
 */
function writeRuntimeWildcardPackage(
  workspace,
  { version = "1.0.0", root, runtime },
) {
  const packageDir = join(workspace, "packages", "pkg");
  mkdirSync(packageDir, { recursive: true });

  const exports = {};
  if (root !== undefined) {
    writeDts(join(packageDir, "dist/index.d.ts"), root);
    exports["."] = { import: { types: "./dist/index.d.ts" } };
  }
  for (const [name, body] of Object.entries(runtime)) {
    writeDts(join(packageDir, `dist/runtime/${name}.d.mts`), body);
  }
  exports["./*"] = { import: { types: "./dist/runtime/*.d.mts" } };
  exports["./package.json"] = "./package.json";

  writeJson(join(packageDir, "package.json"), {
    name: "@demo/pkg",
    version,
    exports,
  });
  return packageDir;
}

function snapshotSubpaths(workspace, dir = "snapshots") {
  const metadata = JSON.parse(
    readFileSync(
      join(workspace, dir, "demo__pkg", "break-check.snapshot.json"),
      "utf-8",
    ),
  );
  return metadata.entries.map((e) => e.subpath).sort();
}

test("snapshot drops content-hashed chunks under a wildcard subpath", () => {
  const workspace = workspaceDir();
  try {
    const configPath = writeConfig(workspace);
    // Two hash-named shared chunks plus one real flat entry, all caught by the
    // same `./*` glob. The chunks must not become public subpaths.
    writeRuntimeWildcardPackage(workspace, {
      root: "export declare const root: number;\n",
      runtime: {
        "index-Dq-_K2VH": "export declare function chunkA(): void;\n",
        "url-CcPzUbGM": "export declare function chunkB(): void;\n",
        helpers: "export declare function help(): string;\n",
      },
    });

    const snapshot = runBreakCheck(["snapshot", "-c", configPath]);
    assert.equal(snapshot.status, 0, snapshot.stderr);

    assert.deepEqual(snapshotSubpaths(workspace), [".", "./helpers"]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("detect reports no phantom change when a chunk hash flips", () => {
  const workspace = workspaceDir();
  try {
    const configPath = writeConfig(workspace);
    writeRuntimeWildcardPackage(workspace, {
      root: "export declare const root: number;\n",
      runtime: {
        "index-AAAA1111": "export declare function chunk(): void;\n",
        helpers: "export declare function help(): string;\n",
      },
    });

    const baseline = runBreakCheck([
      "snapshot",
      "-c",
      configPath,
      "-o",
      "baseline",
    ]);
    assert.equal(baseline.status, 0, baseline.stderr);

    // Rebuild: the chunk's hash changes (its content shifted), so the file is
    // renamed. The real surface (`.`, `./helpers`) is untouched.
    rmSync(join(workspace, "packages", "pkg"), {
      recursive: true,
      force: true,
    });
    writeRuntimeWildcardPackage(workspace, {
      root: "export declare const root: number;\n",
      runtime: {
        "index-BBBB2222": "export declare function chunk(): void;\n",
        helpers: "export declare function help(): string;\n",
      },
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
    ]);
    assert.equal(detect.status, 0, detect.stderr);

    const result = JSON.parse(detect.stdout);
    assert.equal(result.summary.breakingChanges, 0);
    const chunkChanges = result.packages[0].changes.filter((c) =>
      /index-(AAAA1111|BBBB2222)/.test(c.subpath ?? c.name ?? ""),
    );
    assert.equal(
      chunkChanges.length,
      0,
      "no add/remove should be reported for the renamed chunk",
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("detect reconciles an older baseline that recorded chunk subpaths", () => {
  const workspace = workspaceDir();
  try {
    // Snapshot with the heuristic OFF so the baseline records the chunk as a
    // real subpath, mimicking a baseline committed before this filter existed.
    const configPath = writeConfig(workspace, { ignoreHashedChunks: false });
    writeRuntimeWildcardPackage(workspace, {
      root: "export declare const root: number;\n",
      runtime: {
        "index-AAAA1111": "export declare function chunk(): void;\n",
        helpers: "export declare function help(): string;\n",
      },
    });

    const baseline = runBreakCheck([
      "snapshot",
      "-c",
      configPath,
      "-o",
      "baseline",
    ]);
    assert.equal(baseline.status, 0, baseline.stderr);
    assert.ok(
      snapshotSubpaths(workspace, "baseline").includes("./index-AAAA1111"),
      "baseline should have recorded the chunk while the heuristic was off",
    );

    // Flip the heuristic back on (the default) and rebuild with a new chunk
    // hash. The baseline's chunk entry must be dropped on read, not reported
    // as a removed subpath.
    writeConfig(workspace, { ignoreHashedChunks: true });
    rmSync(join(workspace, "packages", "pkg"), {
      recursive: true,
      force: true,
    });
    writeRuntimeWildcardPackage(workspace, {
      root: "export declare const root: number;\n",
      runtime: {
        "index-BBBB2222": "export declare function chunk(): void;\n",
        helpers: "export declare function help(): string;\n",
      },
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
    ]);
    assert.equal(detect.status, 0, detect.stderr);

    const result = JSON.parse(detect.stdout);
    assert.equal(
      result.summary.breakingChanges,
      0,
      "an old baseline's chunk entry must not surface as a phantom removal",
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("ignoreSubpaths accepts globs during wildcard discovery", () => {
  const workspace = workspaceDir();
  try {
    const configPath = writeConfig(workspace, {
      ignoreSubpaths: ["./internal-*"],
    });
    writeRuntimeWildcardPackage(workspace, {
      root: "export declare const root: number;\n",
      runtime: {
        "internal-foo": "export declare function foo(): void;\n",
        "internal-bar": "export declare function bar(): void;\n",
        public: "export declare function pub(): string;\n",
      },
    });

    const snapshot = runBreakCheck(["snapshot", "-c", configPath]);
    assert.equal(snapshot.status, 0, snapshot.stderr);

    assert.deepEqual(snapshotSubpaths(workspace), [".", "./public"]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("ignoreHashedChunks:false keeps chunk subpaths (preserves #26)", () => {
  const workspace = workspaceDir();
  try {
    const configPath = writeConfig(workspace, { ignoreHashedChunks: false });
    writeRuntimeWildcardPackage(workspace, {
      root: "export declare const root: number;\n",
      runtime: {
        "index-AAAA1111": "export declare function chunk(): void;\n",
        helpers: "export declare function help(): string;\n",
      },
    });

    const snapshot = runBreakCheck(["snapshot", "-c", configPath]);
    assert.equal(snapshot.status, 0, snapshot.stderr);

    assert.deepEqual(snapshotSubpaths(workspace), [
      ".",
      "./helpers",
      "./index-AAAA1111",
    ]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("snapshot warns and continues when one subpath fails extraction", () => {
  const workspace = workspaceDir();
  try {
    const configPath = writeConfig(workspace);
    writeSubpathOnlyPackage(workspace, {
      version: "1.0.0",
      surfaces: {
        dts: {
          ".": "export declare const root: number;\n",
          "./broken":
            // Syntactically invalid TypeScript triggers an extractor
            // failure. The exact error shape doesn't matter; what matters
            // is that the orchestrator catches it and continues instead
            // of throwing the whole run. Same fail-soft behavior we need
            // for ambient-global crashes on @clerk/testing (./cypress)
            // and @clerk/astro (./env).
            "this is not valid typescript $$$ {{{\n",
          "./good": "export declare function helper(): string;\n",
        },
      },
    });

    const snapshot = runBreakCheck(["snapshot", "-c", configPath]);
    assert.equal(snapshot.status, 0, snapshot.stderr);
    assert.match(snapshot.stderr, /skipping @demo\/pkg \.\/broken/);

    const pkgDir = join(workspace, "snapshots", "demo__pkg");
    assert.ok(existsSync(join(pkgDir, "demo__pkg___root.api.json")));
    assert.ok(existsSync(join(pkgDir, "demo__pkg__good.api.json")));
    assert.ok(!existsSync(join(pkgDir, "demo__pkg__broken.api.json")));

    const metadata = JSON.parse(
      readFileSync(join(pkgDir, "break-check.snapshot.json"), "utf-8"),
    );
    const subpaths = metadata.entries.map((e) => e.subpath).sort();
    assert.deepEqual(subpaths, [".", "./good"]);
    assert.match(snapshot.stdout, /Skipped 1 subpath/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("snapshot --fail-on-skipped turns a skipped subpath into a hard error", () => {
  const workspace = workspaceDir();
  try {
    const configPath = writeConfig(workspace);
    writeSubpathOnlyPackage(workspace, {
      version: "1.0.0",
      surfaces: {
        dts: {
          ".": "export declare const root: number;\n",
          "./broken": "this is not valid typescript $$$ {{{\n",
        },
      },
    });

    // Default (fail-soft): succeeds despite the skip.
    const soft = runBreakCheck(["snapshot", "-c", configPath]);
    assert.equal(soft.status, 0, soft.stderr);

    // Strict: same input, exits non-zero. The good entry is still written
    // (the run completes), but the exit code forces the producer to notice.
    const strict = runBreakCheck([
      "snapshot",
      "-c",
      configPath,
      "--fail-on-skipped",
    ]);
    assert.equal(strict.status, 1);
    assert.match(strict.stderr, /could not be snapshotted .*--fail-on-skipped/);
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

    const snapshot = runBreakCheck(["snapshot", "-c", configPath]);
    assert.equal(snapshot.status, 0, snapshot.stderr);

    const metadata = JSON.parse(
      readFileSync(
        join(workspace, "snapshots", "demo__pkg", "break-check.snapshot.json"),
        "utf-8",
      ),
    );
    const subpaths = metadata.entries.map((e) => e.subpath);
    assert.deepEqual(subpaths, ["."]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

const TRAVERSAL_SENTINEL = "BreakCheckTraversalSentinel";

/**
 * Assert that no snapshot artifact under `dir` contains the out-of-root
 * sentinel symbol. If discovery had followed a `../` path traversal, the
 * stolen .d.ts would be rolled up into one of these .api.json files.
 */
function assertSentinelAbsent(dir) {
  for (const rel of readdirSync(dir, { recursive: true })) {
    const file = join(dir, rel);
    if (!statSync(file).isFile()) continue;
    assert.ok(
      !readFileSync(file, "utf-8").includes(TRAVERSAL_SENTINEL),
      `out-of-root .d.ts content leaked into ${rel}`,
    );
  }
}

test("snapshot drops a subpath whose types escape the package root (issue #7)", () => {
  const workspace = workspaceDir();
  try {
    const configPath = writeConfig(workspace);

    // A sentinel .d.ts OUTSIDE the package the manifest describes. The
    // package.json is attacker-controlled in CI (the Action builds a PR's
    // manifest), so a subpath pointing its types at this file via `../../`
    // must not pull it into the snapshot (and from there the report + AI
    // payload). See issue #7.
    writeDts(
      join(workspace, "outside", "secret.d.ts"),
      `export declare const ${TRAVERSAL_SENTINEL}: number;\n`,
    );

    const packageDir = join(workspace, "packages", "pkg");
    mkdirSync(packageDir, { recursive: true });
    writeDts(
      join(packageDir, "dist/index.d.ts"),
      "export declare const root: number;\n",
    );
    writeJson(join(packageDir, "package.json"), {
      name: "@demo/pkg",
      version: "1.0.0",
      exports: {
        ".": { import: { types: "./dist/index.d.ts" } },
        "./pwn": { import: { types: "../../outside/secret.d.ts" } },
        "./package.json": "./package.json",
      },
    });

    const snapshot = runBreakCheck(["snapshot", "-c", configPath]);
    assert.equal(snapshot.status, 0, snapshot.stderr);

    // The traversal subpath is dropped entirely; only the legit root remains.
    const pkgDir = join(workspace, "snapshots", "demo__pkg");
    const metadata = JSON.parse(
      readFileSync(join(pkgDir, "break-check.snapshot.json"), "utf-8"),
    );
    assert.deepEqual(
      metadata.entries.map((e) => e.subpath),
      ["."],
      "the out-of-root ./pwn subpath must not be enumerated",
    );
    assertSentinelAbsent(pkgDir);

    // The dropped surface is no longer silent: it is reported as skipped so
    // --fail-on-skipped (and the report) can see the hole.
    assert.match(snapshot.stderr, /skipping @demo\/pkg \.\/pwn/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("snapshot ignores a root `types` field that escapes the package root (issue #7)", () => {
  const workspace = workspaceDir();
  try {
    const configPath = writeConfig(workspace);
    writeDts(
      join(workspace, "outside", "secret.d.ts"),
      `export declare const ${TRAVERSAL_SENTINEL}: number;\n`,
    );

    const packageDir = join(workspace, "packages", "pkg");
    mkdirSync(packageDir, { recursive: true });
    // A legit in-package declaration the resolver should land on after
    // rejecting the out-of-root `types` (it falls through to `main` -> .d.ts).
    writeDts(
      join(packageDir, "dist/index.d.ts"),
      "export declare const root: number;\n",
    );
    writeJson(join(packageDir, "package.json"), {
      name: "@demo/pkg",
      version: "1.0.0",
      types: "../../outside/secret.d.ts",
      main: "./dist/index.js",
    });

    const snapshot = runBreakCheck(["snapshot", "-c", configPath]);
    assert.equal(snapshot.status, 0, snapshot.stderr);

    const pkgDir = join(workspace, "snapshots", "demo__pkg");
    const metadata = JSON.parse(
      readFileSync(join(pkgDir, "break-check.snapshot.json"), "utf-8"),
    );
    assert.deepEqual(
      metadata.entries.map((e) => e.subpath),
      ["."],
    );
    assertSentinelAbsent(pkgDir);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("discovery resolves types nested under runtime conditions and .d.cts files", () => {
  const workspace = workspaceDir();
  try {
    const configPath = writeConfig(workspace);

    const packageDir = join(workspace, "packages", "pkg");
    mkdirSync(packageDir, { recursive: true });
    writeDts(
      join(packageDir, "dist/index.d.ts"),
      "export declare const root: number;\n",
    );
    writeDts(
      join(packageDir, "dist/deep.d.ts"),
      "export declare const deep: boolean;\n",
    );
    writeDts(
      join(packageDir, "dist/legacy.d.cts"),
      "export declare const legacy: string;\n",
    );
    writeJson(join(packageDir, "package.json"), {
      name: "@demo/pkg",
      version: "1.0.0",
      exports: {
        ".": { import: { types: "./dist/index.d.ts" } },
        // A single-level scan misses both of these shapes; Node and TS
        // resolve them fine, so they are real public surface.
        "./deep": { node: { import: { types: "./dist/deep.d.ts" } } },
        "./legacy": { require: "./dist/legacy.d.cts" },
        "./package.json": "./package.json",
      },
    });

    const snapshot = runBreakCheck([
      "snapshot",
      "-c",
      configPath,
      "--fail-on-skipped",
    ]);
    assert.equal(snapshot.status, 0, snapshot.stderr);

    const metadata = JSON.parse(
      readFileSync(
        join(workspace, "snapshots", "demo__pkg", "break-check.snapshot.json"),
        "utf-8",
      ),
    );
    assert.deepEqual(metadata.entries.map((e) => e.subpath).sort(), [
      ".",
      "./deep",
      "./legacy",
    ]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a JS-only or asset subpath is not reported as a skipped surface", () => {
  const workspace = workspaceDir();
  try {
    const configPath = writeConfig(workspace);

    const packageDir = join(workspace, "packages", "pkg");
    mkdirSync(packageDir, { recursive: true });
    writeDts(
      join(packageDir, "dist/index.d.ts"),
      "export declare const root: number;\n",
    );
    writeFileSync(join(packageDir, "styles.css"), "body {}\n");
    writeFileSync(join(packageDir, "dist", "util.js"), "module.exports = 1;\n");
    writeJson(join(packageDir, "package.json"), {
      name: "@demo/pkg",
      version: "1.0.0",
      exports: {
        ".": { import: { types: "./dist/index.d.ts" } },
        "./styles.css": "./styles.css",
        "./util": { import: "./dist/util.js" },
        "./package.json": "./package.json",
      },
    });

    // No declared types on those subpaths means nothing to snapshot and
    // nothing to warn about; strict mode must stay green.
    const snapshot = runBreakCheck([
      "snapshot",
      "-c",
      configPath,
      "--fail-on-skipped",
    ]);
    assert.equal(snapshot.status, 0, snapshot.stderr);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a declared types file that is missing surfaces as a skipped subpath", () => {
  const workspace = workspaceDir();
  try {
    const configPath = writeConfig(workspace);

    const packageDir = join(workspace, "packages", "pkg");
    mkdirSync(packageDir, { recursive: true });
    writeDts(
      join(packageDir, "dist/index.d.ts"),
      "export declare const root: number;\n",
    );
    writeJson(join(packageDir, "package.json"), {
      name: "@demo/pkg",
      version: "1.0.0",
      exports: {
        ".": { import: { types: "./dist/index.d.ts" } },
        "./gone": { import: { types: "./dist/gone.d.ts" } },
        "./package.json": "./package.json",
      },
    });

    // Fail-soft: the run succeeds but the hole is visible.
    const soft = runBreakCheck([
      "snapshot",
      "-c",
      configPath,
      "-o",
      "baseline",
    ]);
    assert.equal(soft.status, 0, soft.stderr);
    assert.match(soft.stderr, /skipping @demo\/pkg \.\/gone/);

    // Strict: the hole is a hard error.
    const strict = runBreakCheck([
      "snapshot",
      "-c",
      configPath,
      "--fail-on-skipped",
    ]);
    assert.equal(strict.status, 1);

    // The hole also rides into detect's result so reports show it.
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
    const result = JSON.parse(detect.stdout);
    assert.ok(
      (result.skippedEntries ?? []).some((s) => s.subpath === "./gone"),
      "detect result should list ./gone as skipped",
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("an unsupported multi-star wildcard types pattern surfaces as skipped", () => {
  const workspace = workspaceDir();
  try {
    const configPath = writeConfig(workspace);

    const packageDir = join(workspace, "packages", "pkg");
    mkdirSync(packageDir, { recursive: true });
    writeDts(
      join(packageDir, "dist/index.d.ts"),
      "export declare const root: number;\n",
    );
    // Real surface hides behind a pattern shape break-check cannot expand.
    writeDts(
      join(packageDir, "dist/a/x.d.ts"),
      "export declare const x: number;\n",
    );
    writeJson(join(packageDir, "package.json"), {
      name: "@demo/pkg",
      version: "1.0.0",
      exports: {
        ".": { import: { types: "./dist/index.d.ts" } },
        "./m/*": { types: "./dist/*/*.d.ts" },
        "./package.json": "./package.json",
      },
    });

    const strict = runBreakCheck([
      "snapshot",
      "-c",
      configPath,
      "--fail-on-skipped",
    ]);
    assert.equal(strict.status, 1);
    assert.match(strict.stderr, /skipping @demo\/pkg \.\/m\/\*/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a wildcard types pattern that matches no files stays silent", () => {
  const workspace = workspaceDir();
  try {
    const configPath = writeConfig(workspace);
    // The shared fixture's "./*" wildcard maps to ./dist/wild/*.d.ts, which
    // matches nothing: no file exists, so no consumer could resolve anything
    // through it either. Not a coverage hole; strict mode stays green.
    writeSubpathOnlyPackage(workspace, {
      version: "1.0.0",
      surfaces: {
        dts: { ".": "export declare const root: number;\n" },
        wildcards: ["./*"],
      },
    });

    const strict = runBreakCheck([
      "snapshot",
      "-c",
      configPath,
      "--fail-on-skipped",
    ]);
    assert.equal(strict.status, 0, strict.stderr);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Package-scoped ignoreSubpaths (issue #104)
// ---------------------------------------------------------------------------

test("makeScopedSubpathMatcher: scoping and glob semantics", () => {
  const match = makeScopedSubpathMatcher([
    "@clerk/astro#./env",
    "@clerk/*#./internal-*",
    "./chunk-*",
    "#./any",
  ]);

  // Package-pinned entry hits only that package.
  assert.ok(match("@clerk/astro", "./env"));
  assert.ok(!match("@clerk/express", "./env"));

  // Package glob with a subpath glob on the other side.
  assert.ok(match("@clerk/shared", "./internal-foo"));
  assert.ok(!match("@other/shared", "./internal-foo"));
  assert.ok(!match("@clerk/shared", "./public"));

  // Bare entry keeps today's global semantics.
  assert.ok(match("@clerk/astro", "./chunk-abc"));
  assert.ok(match("anything", "./chunk-x"));

  // Empty package part means any package.
  assert.ok(match("whatever", "./any"));
});

test("makeScopedSubpathMatcher: package globs follow segment semantics", () => {
  // `*` stays within a `/`-segment, so it covers unscoped names only;
  // `**` crosses segments and covers scoped names too.
  const single = makeScopedSubpathMatcher(["*#./env"]);
  assert.ok(single("react", "./env"));
  assert.ok(!single("@clerk/astro", "./env"));

  const double = makeScopedSubpathMatcher(["**#./env"]);
  assert.ok(double("react", "./env"));
  assert.ok(double("@clerk/astro", "./env"));
});

test("makeScopedSubpathMatcher: a leading-dot entry containing # is never split", () => {
  const match = makeScopedSubpathMatcher(["./weird#name"]);
  assert.ok(match("any-pkg", "./weird#name"));
  assert.ok(!match("./weird", "name"));
});

/**
 * Like writeSubpathOnlyPackage but parameterized by directory and package
 * name, for scoped-ignoreSubpaths tests that need two packages exporting the
 * same subpath key.
 */
function writeNamedSubpathPackage(workspace, dir, name, { version, dts }) {
  const packageDir = join(workspace, dir);
  mkdirSync(packageDir, { recursive: true });

  const exports = {};
  for (const [subpath, body] of Object.entries(dts)) {
    const slug =
      subpath === "."
        ? "index"
        : subpath.replace(/^\.\//, "").replace(/\//g, "_");
    const file = `./dist/${slug}.d.ts`;
    writeDts(join(packageDir, file.slice(2)), body);
    exports[subpath] = { import: { types: file } };
  }
  exports["./package.json"] = "./package.json";

  writeJson(join(packageDir, "package.json"), { name, version, exports });
}

function metadataSubpaths(workspace, pkgSlug) {
  const metadata = JSON.parse(
    readFileSync(
      join(workspace, "snapshots", pkgSlug, "break-check.snapshot.json"),
      "utf-8",
    ),
  );
  return metadata.entries.map((e) => e.subpath).sort();
}

test("scoped ignoreSubpaths drops the subpath only in the named package", () => {
  const workspace = workspaceDir();
  try {
    const configPath = writeConfig(workspace, {
      packages: ["packages/a", "packages/b"],
      ignoreSubpaths: ["@demo/a#./env"],
    });
    writeNamedSubpathPackage(workspace, "packages/a", "@demo/a", {
      version: "1.0.0",
      dts: {
        ".": "export declare const a: number;\n",
        "./env": "export declare const envA: number;\n",
      },
    });
    writeNamedSubpathPackage(workspace, "packages/b", "@demo/b", {
      version: "1.0.0",
      dts: {
        ".": "export declare const b: number;\n",
        "./env": "export declare const envB: number;\n",
      },
    });

    const snapshot = runBreakCheck(["snapshot", "-c", configPath]);
    assert.equal(snapshot.status, 0, snapshot.stderr);

    assert.deepEqual(metadataSubpaths(workspace, "demo__a"), ["."]);
    assert.deepEqual(metadataSubpaths(workspace, "demo__b"), [".", "./env"]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("scoped ignoreSubpaths suppresses baseline removals only in the named package", () => {
  const workspace = workspaceDir();
  try {
    // Baseline: both packages export ./env, nothing ignored.
    const configPath = writeConfig(workspace, {
      packages: ["packages/a", "packages/b"],
    });
    const envSurfaces = (tag) => ({
      version: "1.0.0",
      dts: {
        ".": `export declare const ${tag}: number;\n`,
        "./env": `export declare const env_${tag}: number;\n`,
      },
    });
    writeNamedSubpathPackage(
      workspace,
      "packages/a",
      "@demo/a",
      envSurfaces("a"),
    );
    writeNamedSubpathPackage(
      workspace,
      "packages/b",
      "@demo/b",
      envSurfaces("b"),
    );

    const baseline = runBreakCheck([
      "snapshot",
      "-c",
      configPath,
      "-o",
      "baseline",
    ]);
    assert.equal(baseline.status, 0, baseline.stderr);

    // Current: ./env dropped from BOTH packages; only @demo/a's is ignored.
    writeConfig(workspace, {
      packages: ["packages/a", "packages/b"],
      ignoreSubpaths: ["@demo/a#./env"],
    });
    const rootOnly = (tag) => ({
      version: "1.0.0",
      dts: { ".": `export declare const ${tag}: number;\n` },
    });
    rmSync(join(workspace, "packages", "a", "dist", "env.d.ts"));
    rmSync(join(workspace, "packages", "b", "dist", "env.d.ts"));
    writeNamedSubpathPackage(workspace, "packages/a", "@demo/a", rootOnly("a"));
    writeNamedSubpathPackage(workspace, "packages/b", "@demo/b", rootOnly("b"));

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

    const result = JSON.parse(detect.stdout);
    const pkg = (name) => result.packages.find((p) => p.packageName === name);

    const removalsA = pkg("@demo/a").changes.filter(
      (c) => c.subpath === "./env",
    );
    assert.equal(
      removalsA.length,
      0,
      "scoped ignore must suppress the removal in the scoped package",
    );

    const removalsB = pkg("@demo/b").changes.filter(
      (c) => c.subpath === "./env" && c.type === "breaking",
    );
    assert.ok(
      removalsB.length > 0,
      "the other package's ./env removal must still be reported",
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("skip warning names the scoped ignoreSubpaths entry, and that entry clears the skip", () => {
  const workspace = workspaceDir();
  try {
    const configPath = writeConfig(workspace);
    // An ambient .d.ts (no top-level import/export) is the @clerk/astro ./env
    // shape: API Extractor can never analyze it, so the entry is skipped with
    // guidance naming the exact scoped config entry.
    writeSubpathOnlyPackage(workspace, {
      version: "1.0.0",
      surfaces: {
        dts: {
          ".": "export declare const root: number;\n",
          "./env": "interface AmbientOnly { x: number }\n",
        },
      },
    });

    const snapshot = runBreakCheck(["snapshot", "-c", configPath]);
    assert.equal(snapshot.status, 0, snapshot.stderr);
    assert.match(
      snapshot.stderr,
      /add `"@demo\/pkg#\.\/env"` to `ignoreSubpaths`/,
    );

    // Copying the suggested entry acknowledges the skip.
    writeConfig(workspace, { ignoreSubpaths: ["@demo/pkg#./env"] });
    const acknowledged = runBreakCheck([
      "snapshot",
      "-c",
      configPath,
      "--fail-on-skipped",
    ]);
    assert.equal(acknowledged.status, 0, acknowledged.stderr);
    assert.ok(!acknowledged.stderr.includes("skipping"));
    assert.deepEqual(metadataSubpaths(workspace, "demo__pkg"), ["."]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
