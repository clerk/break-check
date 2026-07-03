import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { findConfigFile, loadConfig } from "../dist/config.js";

function withConfig(obj, fn) {
  const dir = mkdtempSync(join(tmpdir(), "break-check-config-"));
  const file = join(dir, "break-check.config.json");
  writeFileSync(file, JSON.stringify(obj));
  try {
    return fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("config: a removed ai.strict key is rejected, not silently dropped", () => {
  withConfig({ packages: ["pkg"], ai: { strict: true } }, (file) => {
    // The old `strict` key was split into applyDowngrades + scanForMissed. A
    // stale config must fail loudly (naming the key) rather than parse to a
    // surprising all-false AI config.
    assert.throws(
      () => loadConfig(file),
      /strict/,
      "stale ai.strict must error and mention the offending key",
    );
  });
});

test("config: an unknown ai key (typo) is rejected", () => {
  withConfig({ packages: ["pkg"], ai: { scanForMisssed: true } }, (file) => {
    assert.throws(() => loadConfig(file), /scanForMisssed/);
  });
});

test("config: the replacement ai keys load", () => {
  withConfig(
    { packages: ["pkg"], ai: { scanForMissed: true, applyDowngrades: true } },
    (file) => {
      const cfg = loadConfig(file);
      assert.equal(cfg.ai.scanForMissed, true);
      assert.equal(cfg.ai.applyDowngrades, true);
    },
  );
});

test("config: acknowledgedChanges loads as a string array", () => {
  const patterns = ["R", "@demo/pkg#OAuthConsentInfo", "Clerk.__internal_*"];
  withConfig({ packages: ["pkg"], acknowledgedChanges: patterns }, (file) => {
    const cfg = loadConfig(file);
    assert.deepEqual(cfg.acknowledgedChanges, patterns);
  });
});

test("config: acknowledgedChanges defaults to an empty array", () => {
  withConfig({ packages: ["pkg"] }, (file) => {
    const cfg = loadConfig(file);
    assert.deepEqual(cfg.acknowledgedChanges, []);
  });
});

test("config: acknowledgedChanges rejects a non-string entry", () => {
  withConfig({ packages: ["pkg"], acknowledgedChanges: [123] }, (file) => {
    assert.throws(() => loadConfig(file), /acknowledgedChanges/);
  });
});

test("config: findConfigFile terminates on a relative startDir", () => {
  // A relative path used to spin forever: `path.parse(rel).root` is "" and
  // `path.dirname(".")` is ".", so the walk-up loop never reached the root.
  const dir = mkdtempSync(join(tmpdir(), "break-check-config-"));
  const nested = join(dir, "a", "b");
  mkdirSync(nested, { recursive: true });
  const previousCwd = process.cwd();
  try {
    process.chdir(dir);
    // No config anywhere up the tmpdir tree: must return null, not hang.
    assert.equal(findConfigFile(join("a", "b")), null);

    // A config above the relative start dir is still found. Compare against
    // process.cwd() (the realpath) since macOS tmpdirs are symlinked
    // (/var/folders -> /private/var/folders).
    writeFileSync(
      join(dir, "break-check.config.json"),
      JSON.stringify({ packages: ["pkg"] }),
    );
    assert.equal(
      findConfigFile(join("a", "b")),
      join(process.cwd(), "break-check.config.json"),
    );
  } finally {
    process.chdir(previousCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config: downgradeAbsorbingArmUnions defaults to true and loads false", () => {
  withConfig({ packages: ["pkg"] }, (file) => {
    assert.equal(loadConfig(file).downgradeAbsorbingArmUnions, true);
  });
  withConfig(
    { packages: ["pkg"], downgradeAbsorbingArmUnions: false },
    (file) => {
      assert.equal(loadConfig(file).downgradeAbsorbingArmUnions, false);
    },
  );
});
