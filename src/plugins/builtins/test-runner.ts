import { existsSync } from "node:fs";
import { join } from "node:path";
import { printJson } from "../../output/json.ts";
import { hasDependency } from "../context.ts";
import type { PluginCheck, PluginCommand, ProjectContext, RepoPilotPlugin } from "../types.ts";

export function detectTestRunner(ctx: ProjectContext): "vitest" | "jest" | null {
  if (
    hasDependency(ctx.packageJson, "vitest") ||
    existsSync(join(ctx.root, "vitest.config.ts")) ||
    existsSync(join(ctx.root, "vitest.config.js")) ||
    existsSync(join(ctx.root, "vitest.config.mjs")) ||
    existsSync(join(ctx.root, "vitest.config.mts"))
  ) {
    return "vitest";
  }
  if (
    hasDependency(ctx.packageJson, "jest") ||
    existsSync(join(ctx.root, "jest.config.js")) ||
    existsSync(join(ctx.root, "jest.config.ts")) ||
    existsSync(join(ctx.root, "jest.config.mjs"))
  ) {
    return "jest";
  }
  return null;
}

const infoCommand: PluginCommand = {
  name: "info",
  description: "Show detected unit-test runner",
  async run(ctx, options) {
    const runner = detectTestRunner(ctx);
    if (options.json) {
      printJson({ plugin: "test-runner", runner });
    } else if (!options.quiet) {
      process.stdout.write("\nTest runner\n\n");
      process.stdout.write(`  ${runner ?? "none detected"}\n\n`);
    }
    return 0;
  },
};

const runnerConfigured: PluginCheck = {
  id: "test-runner-configured",
  label: "Test runner",
  async run(ctx) {
    const runner = detectTestRunner(ctx);
    if (runner) {
      return { status: "pass", message: `${runner} configured` };
    }
    return { status: "warn", message: "No Vitest/Jest configuration detected" };
  },
};

export const testRunnerPlugin: RepoPilotPlugin = {
  name: "test-runner",
  detect(ctx) {
    return detectTestRunner(ctx) !== null;
  },
  commands: [infoCommand],
  checks: [runnerConfigured],
};
