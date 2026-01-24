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
        verbose: options.verbose ?? true,
        configPath,
      });

      console.log("Generating API snapshots...\n");
      const snapshots = await detector.generateSnapshots();

      console.log(`\n✓ Generated ${snapshots.size} snapshot(s)`);
      console.log(
        `  Output: ${path.resolve(path.dirname(configPath), config.snapshotDir)}`,
      );
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
  .option("--format <format>", "Output format (markdown|json)", "markdown")
  .option("--fail-on-breaking", "Exit with code 1 if breaking changes found")
  .option("-v, --verbose", "Show verbose output")
  .action(async (options) => {
    try {
      const configPath = path.resolve(process.cwd(), options.config);
      const config = loadConfig(configPath);

      const detector = new BreakingChangesDetector(config, {
        verbose: options.verbose,
        configPath,
      });

      console.log("Detecting API changes...\n");
      const result = await detector.detect(options.baseline);

      // Generate report
      const reporter = new MarkdownReporter();
      const report =
        options.format === "json"
          ? reporter.generateJson(result)
          : reporter.generate(result);

      // Output report
      if (options.output) {
        const outputPath = path.resolve(process.cwd(), options.output);
        fs.writeFileSync(outputPath, report, "utf-8");
        console.log(`Report written to: ${outputPath}`);
      } else {
        console.log(report);
      }

      // Summary
      console.log("\nSummary:");
      console.log(`  Packages analyzed: ${result.summary.totalPackages}`);
      console.log(`  Breaking changes: ${result.summary.breakingChanges}`);
      console.log(
        `  Non-breaking changes: ${result.summary.nonBreakingChanges}`,
      );
      console.log(`  Additions: ${result.summary.additions}`);

      // Exit with error if breaking changes found and flag is set
      if (options.failOnBreaking && result.hasBreakingChanges) {
        console.log("\n✗ Breaking changes detected");
        process.exit(1);
      }

      if (result.hasBreakingChanges) {
        console.log("\n⚠ Breaking changes detected");
      } else {
        console.log("\n✓ No breaking changes detected");
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
