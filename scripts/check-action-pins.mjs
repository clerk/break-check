#!/usr/bin/env node
// Enforce that every third-party GitHub Action is pinned to a full commit SHA.
//
// A tag like `@v4` or a branch like `@main` is a moving target: whoever controls
// the tag controls what runs in CI, so a compromised or retagged release would
// execute silently. Pinning to a 40-character commit SHA makes each action
// reference immutable and tamper-evident (the `# vX` comment stays as a
// human-readable hint, kept current by Dependabot). actionlint does not enforce
// this, so this script scans every workflow plus the composite action.yml and
// fails if any `uses:` points at anything other than a SHA.
//
// Exempt: local actions (`uses: ./...`), which reference this repo's own code.
//
// Usage: node scripts/check-action-pins.mjs

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const SHA = /^[0-9a-f]{40}$/;
const WORKFLOW_DIR = ".github/workflows";

const files = [
  ...(existsSync(WORKFLOW_DIR)
    ? readdirSync(WORKFLOW_DIR)
        .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
        .map((f) => join(WORKFLOW_DIR, f))
    : []),
  "action.yml",
].filter((f) => existsSync(f));

const offenders = [];

for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    // Match `uses:` (job step, reusable workflow, or composite step). Comments
    // start with `#`, which the value capture below stops at.
    const m = line.match(/^\s*-?\s*uses:\s*(['"]?)([^'"#\s]+)\1/);
    if (!m) return;
    const ref = m[2];
    // Local actions reference this repo and have no SHA to pin.
    if (ref.startsWith("./") || ref.startsWith("../")) return;
    // Docker actions pin by digest (`docker://image@sha256:...`); accept those.
    if (ref.startsWith("docker://") && /@sha256:[0-9a-f]{64}$/.test(ref))
      return;

    const at = ref.lastIndexOf("@");
    const pinned = at !== -1 && SHA.test(ref.slice(at + 1));
    if (!pinned) {
      offenders.push(`${file}:${i + 1}  ${ref}`);
    }
  });
}

if (offenders.length > 0) {
  console.error(
    "Actions must be pinned to a full commit SHA, not a tag or branch:",
  );
  for (const o of offenders) console.error(`  ${o}`);
  console.error(
    "\nPin to the SHA the tag resolves to and keep the version as a `# vX` comment, e.g.:",
  );
  console.error(
    "  uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3",
  );
  process.exit(1);
}

console.log(
  `All actions across ${files.length} workflow/action file(s) are pinned to a SHA.`,
);
