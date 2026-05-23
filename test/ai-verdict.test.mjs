/**
 * End-to-end AI verdict test against the real Anthropic API.
 *
 * Skipped when SNAPI_ANTHROPIC_API_KEY is not set in the environment, so the
 * unit-test suite still passes in environments without the key. CI passes the
 * secret through on a single Node version (see .github/workflows/publish-preview.yml).
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

const haveKey = Boolean(process.env.SNAPI_ANTHROPIC_API_KEY);

function runSnapi(args, cwd) {
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

function setup({ baseline, current }) {
  const workspace = mkdtempSync(join(tmpdir(), "snapi-ai-verdict-"));
  const pkgDir = join(workspace, "packages", "pkg");
  mkdirSync(join(pkgDir, "dist"), { recursive: true });

  writeFileSync(
    join(workspace, "snapi.config.json"),
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
  const snapshot = runSnapi(
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
  return { result, stderr: detect.stderr };
}

test(
  "ai-verdict: AI confirms a real breaking parameter-type change",
  { skip: !haveKey && "SNAPI_ANTHROPIC_API_KEY not set" },
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
