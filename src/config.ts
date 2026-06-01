/**
 * Configuration loading and validation for break-check
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";

/**
 * Default config file name
 */
export const CONFIG_FILE_NAME = "break-check.config.json";

/**
 * Pre-rename config file name. Still honored as a deprecated fallback so repos
 * that predate the snapi -> break-check rename keep working without an edit.
 * Prefer CONFIG_FILE_NAME; this will be removed in a future major.
 */
export const LEGACY_CONFIG_FILE_NAME = "snapi.config.json";

/**
 * Default model used by the AI analyzer when no override is configured.
 */
export const DEFAULT_AI_MODEL = "claude-sonnet-4-6";

/**
 * Zod schema for the AI analyzer block
 */
export const AiConfigSchema = z.object({
  /**
   * When true: AI runs (errors if BREAK_CHECK_ANTHROPIC_API_KEY is missing).
   * When false: AI never runs even if the key is set.
   * When unset (default): AI runs iff BREAK_CHECK_ANTHROPIC_API_KEY is in the environment.
   */
  enabled: z.boolean().optional(),

  /** Model identifier (Anthropic API). Defaults to DEFAULT_AI_MODEL when neither config nor BREAK_CHECK_AI_MODEL is set. */
  model: z.string().optional(),

  /** Maximum rule-based changes batched into a single AI call per package. */
  maxChangesPerCall: z.number().int().positive().default(80),

  /**
   * When true, also invoke the AI reviewer for diffs that the rule-based pass
   * classified as pure additions. Useful for paranoid scans; costs an extra
   * model call per such package. May also be enabled via `BREAK_CHECK_AI_STRICT=1`
   * or `--ai-strict`.
   */
  strict: z.boolean().default(false),
});

/**
 * Zod schema for break-check configuration
 */
export const ConfigSchema = z.object({
  /** Package paths relative to config file location */
  packages: z.array(z.string()).min(1, "At least one package is required"),

  /** Directory to store API snapshots */
  snapshotDir: z.string().default(".api-snapshots"),

  /** Base branch for comparison */
  mainBranch: z.string().default("main"),

  /** Whether to validate that version bumps match change severity */
  checkVersionBump: z.boolean().default(true),

  /** Output format for reports */
  outputFormat: z.enum(["markdown", "json"]).default("markdown"),

  /**
   * Subpath exports to skip during discovery. An entry without `*` is matched
   * exactly against `exports` map keys (`./internal`, `./types`, etc.); an
   * entry containing `*` is treated as a glob (`*` within a path segment, `**`
   * across segments), e.g. `./internal-*`. This is the explicit escape hatch
   * for surfaces the hashed-chunk heuristic doesn't cover.
   */
  ignoreSubpaths: z.array(z.string()).default([]),

  /**
   * Drop wildcard-expanded subpaths whose basename looks like a content-hashed
   * bundler chunk (e.g. `./index-Dq-_K2VH`, emitted by rolldown/tsdown/esbuild/
   * rollup). On by default: such chunks are not public API and their names flip
   * every build, which would otherwise read as phantom add/remove subpaths.
   * Set to `false` to treat every wildcard match as a real subpath.
   */
  ignoreHashedChunks: z.boolean().default(true),

  /** Optional AI analyzer configuration. */
  ai: AiConfigSchema.optional(),
});

/**
 * Resolved AI configuration type
 */
export type AiConfig = z.infer<typeof AiConfigSchema>;

/**
 * Break Check configuration type
 */
export type BreakCheckConfig = z.infer<typeof ConfigSchema>;

/**
 * Create a default configuration object
 */
export function createDefaultConfig(): BreakCheckConfig {
  return {
    packages: ["packages/my-package"],
    snapshotDir: ".api-snapshots",
    mainBranch: "main",
    checkVersionBump: true,
    outputFormat: "markdown",
    ignoreSubpaths: [],
    ignoreHashedChunks: true,
  };
}

/**
 * Find the config file by walking up the directory tree
 * @param startDir - Directory to start searching from (defaults to cwd)
 * @returns Path to config file or null if not found
 */
export function findConfigFile(startDir?: string): string | null {
  let currentDir = startDir ?? process.cwd();
  const root = path.parse(currentDir).root;

  // Prefer the current name in each directory, then fall back to the legacy
  // one before walking further up, so a closer legacy config still wins over a
  // distant current config.
  const findIn = (dir: string): string | null => {
    for (const name of [CONFIG_FILE_NAME, LEGACY_CONFIG_FILE_NAME]) {
      const configPath = path.join(dir, name);
      if (fs.existsSync(configPath)) {
        return configPath;
      }
    }
    return null;
  };

  while (currentDir !== root) {
    const found = findIn(currentDir);
    if (found) return found;
    currentDir = path.dirname(currentDir);
  }

  // Check root as well
  return findIn(root);
}

/**
 * Load and validate configuration from a file
 * @param configPath - Path to config file (optional, will search if not provided)
 * @returns Validated configuration object
 * @throws Error if config file not found or invalid
 */
export function loadConfig(configPath?: string): BreakCheckConfig {
  let resolvedPath = configPath ?? findConfigFile();

  // Legacy fallback: a caller that passed (or defaulted to)
  // break-check.config.json but only has the pre-rename snapi.config.json
  // beside it still loads, with a deprecation warning on stderr (kept off
  // stdout so JSON output stays parseable).
  if (
    resolvedPath &&
    !fs.existsSync(resolvedPath) &&
    path.basename(resolvedPath) === CONFIG_FILE_NAME
  ) {
    const legacyPath = path.join(
      path.dirname(resolvedPath),
      LEGACY_CONFIG_FILE_NAME,
    );
    if (fs.existsSync(legacyPath)) {
      process.stderr.write(
        `[break-check] warning: ${LEGACY_CONFIG_FILE_NAME} is deprecated; ` +
          `rename it to ${CONFIG_FILE_NAME}.\n`,
      );
      resolvedPath = legacyPath;
    }
  }

  if (!resolvedPath) {
    throw new Error(
      `Config file not found. Run 'break-check init' to create ${CONFIG_FILE_NAME}`,
    );
  }

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Config file not found: ${resolvedPath}`);
  }

  let rawConfig: unknown;
  try {
    const content = fs.readFileSync(resolvedPath, "utf-8");
    rawConfig = JSON.parse(content);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in config file: ${resolvedPath}`);
    }
    throw error;
  }

  const result = ConfigSchema.safeParse(rawConfig);

  if (!result.success) {
    const errors = result.error.issues
      .map((e) => `  - ${e.path.join(".")}: ${e.message}`)
      .join("\n");
    throw new Error(`Invalid configuration in ${resolvedPath}:\n${errors}`);
  }

  return result.data;
}

/**
 * Write configuration to a file
 * @param config - Configuration object to write
 * @param configPath - Path to write to (defaults to CONFIG_FILE_NAME in cwd)
 */
export function writeConfig(
  config: BreakCheckConfig,
  configPath?: string,
): void {
  const resolvedPath = configPath ?? path.join(process.cwd(), CONFIG_FILE_NAME);
  const content = JSON.stringify(config, null, 2) + "\n";
  fs.writeFileSync(resolvedPath, content, "utf-8");
}

/**
 * Get the directory containing the config file
 * Useful for resolving relative package paths
 */
export function getConfigDir(configPath: string): string {
  return path.dirname(path.resolve(configPath));
}

/**
 * Resolve package paths relative to config file location
 * @param config - Configuration object
 * @param configPath - Path to the config file
 * @returns Array of absolute package paths
 */
export function resolvePackagePaths(
  config: BreakCheckConfig,
  configPath: string,
): string[] {
  const configDir = getConfigDir(configPath);
  return config.packages.map((pkg) => path.resolve(configDir, pkg));
}
