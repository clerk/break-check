#!/usr/bin/env node
// Shellcheck the embedded `run:` blocks of composite GitHub Actions.
//
// actionlint validates workflow files under .github/workflows, but it does not
// lint composite action.yml files, so the ~340 lines of shell in this repo's
// Action would otherwise ship unchecked. This script parses each composite
// action, pulls out every bash `run:` step, neutralizes `${{ ... }}`
// expressions (which are not valid shell) into a placeholder, and runs
// shellcheck over the result. It exits non-zero if shellcheck reports anything.
//
// Usage: node scripts/lint-action-shell.mjs [action.yml ...]
// Requires `shellcheck` on PATH (preinstalled on GitHub-hosted ubuntu runners).

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";

const SHELLCHECK_ARGS = ["-x", "--severity=style", "--color=always"];

function fail(message) {
  console.error(`lint-action-shell: ${message}`);
  process.exit(2);
}

// Confirm shellcheck is available up front; a missing binary must not look like
// a clean pass.
const probe = spawnSync("shellcheck", ["--version"], { encoding: "utf8" });
if (probe.error || probe.status !== 0) {
  fail("shellcheck not found on PATH. Install it (ubuntu runners ship it).");
}

const files = process.argv.slice(2);
if (files.length === 0) files.push("action.yml");

const workdir = mkdtempSync(join(tmpdir(), "action-shell-"));
let stepsChecked = 0;
let filesWithFindings = 0;

try {
  for (const file of files) {
    let doc;
    try {
      doc = parse(readFileSync(file, "utf8"));
    } catch (err) {
      fail(`could not parse ${file}: ${err.message}`);
    }

    const using = doc?.runs?.using;
    if (using !== "composite") {
      console.log(
        `• ${file}: runs.using is '${using}', not 'composite'; skipping.`,
      );
      continue;
    }

    const steps = Array.isArray(doc?.runs?.steps) ? doc.runs.steps : [];
    let fileHadFindings = false;

    steps.forEach((step, i) => {
      if (!step || typeof step.run !== "string") return;
      // Composite steps must declare a shell; we only know how to lint bash/sh.
      const shell = step.shell ?? "bash";
      if (shell !== "bash" && shell !== "sh") {
        console.log(
          `• ${file} step ${i} (${step.name ?? "unnamed"}): shell '${shell}', skipping.`,
        );
        return;
      }

      // `${{ ... }}` is GitHub expression syntax, not shell. Replace each with a
      // bareword placeholder so shellcheck parses the surrounding shell. This
      // matches how actionlint pre-processes workflow run blocks.
      const neutralized = step.run.replace(/\$\{\{[\s\S]*?\}\}/g, "GHA_EXPR");
      const script = `#!/usr/bin/env ${shell}\nset -euo pipefail\n${neutralized}\n`;
      const scriptPath = join(workdir, `step-${i}.sh`);
      writeFileSync(scriptPath, script);
      stepsChecked += 1;

      const result = spawnSync("shellcheck", [...SHELLCHECK_ARGS, scriptPath], {
        encoding: "utf8",
      });
      if (result.status !== 0) {
        if (!fileHadFindings) {
          console.error(`\n✗ ${file}`);
          fileHadFindings = true;
        }
        console.error(`\n  ── step ${i}: ${step.name ?? "unnamed"} ──`);
        process.stderr.write(result.stdout || result.stderr || "");
      }
    });

    if (fileHadFindings) {
      filesWithFindings += 1;
    } else {
      console.log(`✓ ${file}: embedded shell is clean.`);
    }
  }
} finally {
  rmSync(workdir, { recursive: true, force: true });
}

console.log(
  `\nChecked ${stepsChecked} shell step(s) across ${files.length} file(s).`,
);
if (filesWithFindings > 0) {
  console.error(
    `shellcheck reported findings in ${filesWithFindings} file(s).`,
  );
  process.exit(1);
}
