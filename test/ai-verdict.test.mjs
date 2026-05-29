/**
 * End-to-end AI verdict tests against the real Anthropic API.
 *
 * These tests depend on external network + model behavior, so they are NOT
 * part of the regular CI matrix. Opt in explicitly by setting BOTH:
 *   BREAK_CHECK_RUN_REAL_AI_TESTS=1
 *   BREAK_CHECK_ANTHROPIC_API_KEY=<key>
 *
 * The dedicated `.github/workflows/ai-smoke.yml` workflow sets both and runs
 * on a schedule / on manual dispatch.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(repoRoot, "dist", "cli.js");

const truthy = (v) => v === "1" || v === "true";
const runRealAiTests =
  truthy(process.env.BREAK_CHECK_RUN_REAL_AI_TESTS ?? "") &&
  Boolean(process.env.BREAK_CHECK_ANTHROPIC_API_KEY);
const skipReason = runRealAiTests
  ? false
  : "real-AI tests require BREAK_CHECK_RUN_REAL_AI_TESTS=1 and BREAK_CHECK_ANTHROPIC_API_KEY";

function runBreakCheck(args, cwd) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf-8",
    env: process.env,
  });
}

function writePackage(pkgDir, { version, dts }) {
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify(
      { name: "@demo/ai-fixture", version, types: "dist/index.d.ts" },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(join(pkgDir, "dist", "index.d.ts"), dts);
}

function setup({ baseline, current, extraDetectArgs = [] }) {
  const workspace = mkdtempSync(join(tmpdir(), "break-check-ai-verdict-"));
  const pkgDir = join(workspace, "packages", "pkg");
  mkdirSync(join(pkgDir, "dist"), { recursive: true });

  writeFileSync(
    join(workspace, "break-check.config.json"),
    JSON.stringify(
      {
        packages: ["packages/pkg"],
        snapshotDir: "current",
        mainBranch: "main",
        checkVersionBump: false,
        outputFormat: "json",
      },
      null,
      2,
    ),
  );

  writePackage(pkgDir, baseline);
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
      ...extraDetectArgs,
    ],
    workspace,
  );
  if (detect.status !== 0) {
    rmSync(workspace, { recursive: true, force: true });
    throw new Error(`detect exited ${detect.status}: ${detect.stderr}`);
  }

  const result = JSON.parse(detect.stdout);
  rmSync(workspace, { recursive: true, force: true });
  return { result, stderr: detect.stderr };
}

test(
  "ai-verdict: AI confirms a real breaking parameter-type change",
  { skip: skipReason },
  () => {
    const { result, stderr } = setup({
      baseline: {
        version: "1.0.0",
        dts: "export declare function fetchUser(id: string): { name: string };\n",
      },
      current: {
        version: "2.0.0",
        dts: "export declare function fetchUser(id: number): { name: string };\n",
      },
    });

    // Sanity: CLI announced that AI is enabled.
    assert.match(
      stderr,
      /AI review enabled/,
      "expected CLI to log that AI review was enabled",
    );

    const pkg = result.packages[0];
    assert.ok(pkg, "expected a package analysis");
    assert.equal(pkg.aiReviewedBy, "claude-sonnet-4-6");

    const change = pkg.changes.find((c) => c.name === "fetchUser");
    assert.ok(change, "expected a change for fetchUser");
    assert.equal(change.type, "breaking");
    assert.ok(
      change.aiAnalysis,
      "expected aiAnalysis to be attached after AI review",
    );
    assert.equal(change.aiAnalysis.source, "rule-confirmed");
    assert.ok(
      change.aiAnalysis.confidence > 0,
      `expected positive confidence, got ${change.aiAnalysis.confidence}`,
    );
    assert.ok(
      typeof change.aiAnalysis.rationale === "string" &&
        change.aiAnalysis.rationale.length > 0,
      "expected a non-empty rationale",
    );
    assert.ok(
      typeof change.aiAnalysis.migration === "string" &&
        change.aiAnalysis.migration.length > 0,
      "expected migration guidance for a confirmed breaking change",
    );
    assert.equal(change.aiAnalysis.model, "claude-sonnet-4-6");
  },
);

test(
  "ai-verdict: AI is skipped by default when only additions are detected",
  { skip: skipReason },
  () => {
    const { result } = setup({
      baseline: {
        version: "1.0.0",
        dts: "export declare function existing(): void;\n",
      },
      current: {
        version: "1.1.0",
        dts: "export declare function existing(): void;\nexport declare function added(): void;\n",
      },
    });

    const pkg = result.packages[0];
    assert.ok(pkg, "expected a package analysis");
    assert.equal(
      pkg.aiReviewedBy,
      undefined,
      "AI should not run when only additions are detected",
    );
    for (const c of pkg.changes) {
      assert.equal(
        c.aiAnalysis,
        undefined,
        `change ${c.name} should not carry aiAnalysis`,
      );
    }
  },
);

test(
  "ai-verdict: --ai-strict forces AI to run on additions-only diffs",
  { skip: skipReason },
  () => {
    const { result } = setup({
      baseline: {
        version: "1.0.0",
        dts: "export declare function existing(): void;\n",
      },
      current: {
        version: "1.1.0",
        dts: "export declare function existing(): void;\nexport declare function added(): void;\n",
      },
      extraDetectArgs: ["--ai-strict"],
    });

    const pkg = result.packages[0];
    assert.ok(pkg, "expected a package analysis");
    assert.equal(
      pkg.aiReviewedBy,
      "claude-sonnet-4-6",
      "--ai-strict should have caused AI to run",
    );
  },
);
