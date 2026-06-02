import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { loadConfig } from "../dist/config.js";

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
