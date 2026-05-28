#!/usr/bin/env node

/**
 * Snapi CLI - Detect API breaking changes in TypeScript packages
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Command } from "commander";
import {
  loadConfig,
  createDefaultConfig,
  writeConfig,
  CONFIG_FILE_NAME,
} from "./config.js";
import { BreakingChangesDetector } from "./core/detector.js";
import { MarkdownReporter } from "./reporters/markdown.js";

const program = new Command();
const OUTPUT_FORMATS = ["markdown", "json"] as const;

program
  .name("snapi")
  .description("Detect API breaking changes in TypeScript packages")
  .version("0.0.1");

/**
 * snapi init - Create default configuration file
 */
program
  .command("init")
  .description("Create default snapi.config.json")
  .option("-o, --output <path>", "Output path", CONFIG_FILE_NAME)
  .option("-f, --force", "Overwrite existing config file")
  .action((options) => {
    const outputPath = path.resolve(process.cwd(), options.output);

    if (fs.existsSync(outputPath) && !options.force) {
      console.error(`Error: ${outputPath} already exists`);
      console.error("Use --force to overwrite");
      process.exit(1);
    }

    const config = createDefaultConfig();
    writeConfig(config, outputPath);

    console.log(`Created ${outputPath}`);
    console.log("\nNext steps:");
    console.log("  1. Edit the config to add your packages");
    console.log("  2. Run: snapi snapshot");
    console.log("  3. Run: snapi detect --baseline <baseline-dir>");
  });

/**
 * snapi snapshot - Generate API snapshots
 */
program
  .command("snapshot")
  .description("Generate API snapshots for configured packages")
  .option("-c, --config <path>", "Config file path", CONFIG_FILE_NAME)
  .option("-o, --output <path>", "Output directory (overrides config)")
  .option(
    "--fail-on-skipped",
    "Exit with code 1 if any subpath could not be snapshotted (use when producing a committed baseline so holes surface in CI)",
  )
  .option("-v, --verbose", "Show verbose output")
  .action(async (options) => {
    try {
      const configPath = path.resolve(process.cwd(), options.config);
      const config = loadConfig(configPath);

      // Override output directory if specified
      if (options.output) {
        config.snapshotDir = options.output;
      }

      const detector = new BreakingChangesDetector(config, {
        verbose: Boolean(options.verbose),
        configPath,
        // Snapshot never invokes the AI reviewer; hard-disable it so a
        // misconfigured `ai.enabled: true` does not require the API key
        // here (the baseline step in CI does not pass one).
        disableAi: true,
      });

      console.log("Generating API snapshots...\n");
      const snapshots = await detector.generateSnapshots();
      const packageCount = new Set(
        Array.from(snapshots.values()).map((s) => s.packageName),
      ).size;

      console.log(
        `\n✓ Generated ${snapshots.size} snapshot(s) across ${packageCount} package(s)`,
      );
      console.log(
        `  Output: ${path.resolve(path.dirname(configPath), config.snapshotDir)}`,
      );
      const skipped = detector.lastSkippedEntries;
      if (skipped.length > 0) {
        console.log(
          `  Skipped ${skipped.length} subpath(s) due to extraction errors (see warnings above).`,
        );
        if (options.failOnSkipped) {
          console.error(
            `\n✗ ${skipped.length} subpath(s) could not be snapshotted (--fail-on-skipped)`,
          );
          process.exit(1);
        }
      }
    } catch (error) {
      console.error(
        "Error:",
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

/**
 * snapi detect - Detect breaking changes
 */
program
  .command("detect")
  .description("Detect breaking changes between baseline and current")
  .option("-c, --config <path>", "Config file path", CONFIG_FILE_NAME)
  .requiredOption("-b, --baseline <path>", "Baseline snapshots directory")
  .option("-o, --output <path>", "Output report path")
  .option("--format <format>", "Output format (markdown|json)")
  .option("--fail-on-breaking", "Exit with code 1 if breaking changes found")
  .option(
    "--fail-on-skipped",
    "Exit with code 1 if any subpath could not be snapshotted (turns fail-soft skips into a hard error)",
  )
  .option(
    "--no-ai",
    "Disable the AI reviewer even if SNAPI_ANTHROPIC_API_KEY is set",
  )
  .option(
    "--ai-model <model>",
    "Override the AI model (e.g. claude-opus-4-7). Wins over SNAPI_AI_MODEL and config.ai.model.",
  )
  .option(
    "--ai-strict",
    "Run the AI reviewer even when only additions are detected (equivalent to SNAPI_AI_STRICT=1).",
  )
  .option("-v, --verbose", "Show verbose output")
  .action(async (options) => {
    try {
      const configPath = path.resolve(process.cwd(), options.config);
      const config = loadConfig(configPath);
      const format = String(options.format ?? config.outputFormat);

      if (!OUTPUT_FORMATS.includes(format as (typeof OUTPUT_FORMATS)[number])) {
        throw new Error(`Invalid output format: ${format}`);
      }

      const isJsonStdout = format === "json" && !options.output;
      const logInfo = (message: string): void => {
        if (isJsonStdout) {
          console.error(message);
        } else {
          console.log(message);
        }
      };

      const detector = new BreakingChangesDetector(config, {
        verbose: Boolean(options.verbose),
        configPath,
        // commander's `--no-ai` produces `options.ai === false`
        disableAi: options.ai === false,
        aiModel:
          typeof options.aiModel === "string" ? options.aiModel : undefined,
        aiStrict:
          typeof options.aiStrict === "boolean" ? options.aiStrict : undefined,
      });

      if (detector.aiEnabled) {
        logInfo(
          `AI review enabled (model: ${detector.aiStats.model ?? "default"})`,
        );
      }

      logInfo("Detecting API changes...\n");
      const result = await detector.detect(options.baseline);

      // Generate report
      const reporter = new MarkdownReporter();
      const report =
        format === "json"
          ? reporter.generateJson(result)
          : reporter.generate(result);

      // Output report
      if (options.output) {
        const outputPath = path.resolve(process.cwd(), options.output);
        fs.writeFileSync(outputPath, report, "utf-8");
        logInfo(`Report written to: ${outputPath}`);
      } else {
        console.log(report);
      }

      // Summary
      logInfo("\nSummary:");
      logInfo(`  Packages analyzed: ${result.summary.totalPackages}`);
      logInfo(`  Breaking changes: ${result.summary.breakingChanges}`);
      logInfo(`  Non-breaking changes: ${result.summary.nonBreakingChanges}`);
      logInfo(`  Additions: ${result.summary.additions}`);
      if (result.skippedEntries && result.skippedEntries.length > 0) {
        logInfo(
          `  Skipped subpaths: ${result.skippedEntries.length} (see warnings above)`,
        );
      }

      if (detector.aiEnabled) {
        const s = detector.aiStats;
        logInfo(
          `  AI review: ${s.reviewed} reviewed, ${s.overridden} reclassified, ${s.discovered} discovered`,
        );
      }

      // Exit with error if breaking changes found and flag is set
      if (options.failOnBreaking && result.hasBreakingChanges) {
        logInfo("\n✗ Breaking changes detected");
        process.exit(1);
      }

      if (result.hasBreakingChanges) {
        logInfo("\n⚠ Breaking changes detected");
      } else {
        logInfo("\n✓ No breaking changes detected");
      }

      // Strict mode: a skipped subpath means snapi reported "no changes" for
      // a surface it never actually inspected. Callers that would rather fail
      // the check than trust a partial diff opt in with --fail-on-skipped.
      const skippedCount = result.skippedEntries?.length ?? 0;
      if (options.failOnSkipped && skippedCount > 0) {
        logInfo(
          `\n✗ ${skippedCount} subpath(s) could not be snapshotted (--fail-on-skipped)`,
        );
        process.exit(1);
      }
    } catch (error) {
      console.error(
        "Error:",
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

program.parse();
