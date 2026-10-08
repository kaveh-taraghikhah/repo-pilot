import { Command } from "commander";
import { analyzeCommand } from "./commands/analyze.ts";
import { changedCommand } from "./commands/changed.ts";
import { checkCommand } from "./commands/check.ts";
import { cleanCommand } from "./commands/clean.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { graphCommand } from "./commands/graph.ts";
import { impactCommand } from "./commands/impact.ts";
import { pluginsListCommand } from "./commands/plugins.ts";
import { loadPlugins } from "../plugins/loader.ts";
import type { OutputOptions } from "../output/types.ts";
import { VERSION } from "../version.ts";
import { findProjectRoot } from "../scanner/find-root.ts";
import {
  findCommandNameConflict,
  pluginCommandGroupConflictWarning,
} from "./reserved-commands.ts";

/** Core CLI (no plugin command groups). Used for collision checks in `plugins list`. */
export function createCoreProgram(cwd: string = process.cwd()): Command {
  const program = new Command();

  program
    .name("repopilot")
    .description("Understand your codebase before you change it.")
    .version(VERSION)
    .option("--json", "Emit machine-readable JSON", false)
    .option("--quiet", "Suppress non-error human output", false)
    .option("--no-color", "Disable ANSI colors")
    .option("--no-cache", "Disable incremental analysis cache")
    .option("--cwd <path>", "Working directory", cwd);

  registerCoreCliCommands(program);
  return program;
}

export async function createProgram(
  cwd: string = process.cwd(),
): Promise<Command> {
  const program = createCoreProgram(cwd);
  await registerPluginCommandGroups(program, cwd);
  return program;
}

function registerCoreCliCommands(program: Command): void {
  program
    .command("doctor")
    .description("Check whether this repository looks healthy locally")
    .action(async () => {
      const opts = resolveOutputOptions(program);
      const code = await doctorCommand(opts);
      process.exitCode = code;
    });

  program
    .command("analyze")
    .description("Summarize repository structure and AST-backed insights")
    .action(async () => {
      const opts = resolveOutputOptions(program);
      const code = await analyzeCommand(opts);
      process.exitCode = code;
    });

  program
    .command("graph")
    .description("Show the project dependency graph")
    .option("--format <format>", "Output format: text | json", "text")
    .option("--serve", "Start the interactive graph viewer", false)
    .option("--port <number>", "Viewer port", "4173")
    .option("--no-open", "Do not open a browser when serving")
    .action(
      async (cmdOpts: {
        format?: string;
        serve?: boolean;
        port?: string;
        open?: boolean;
      }) => {
        const opts = resolveOutputOptions(program);
        const format = cmdOpts.format === "json" ? "json" : "text";
        const port = Number(cmdOpts.port ?? 4173);
        const code = await graphCommand({
          ...opts,
          format,
          serve: Boolean(cmdOpts.serve),
          port: Number.isFinite(port) ? port : 4173,
          open: cmdOpts.open !== false,
        });
        process.exitCode = code;
      },
    );

  program
    .command("changed")
    .description("List changed files and score their impact")
    .option("--since <ref>", "Compare against a Git ref (e.g. main)")
    .action(async (cmdOpts: { since?: string }) => {
      const opts = resolveOutputOptions(program);
      const code = await changedCommand({
        ...opts,
        since: cmdOpts.since,
      });
      process.exitCode = code;
    });

  program
    .command("impact")
    .description("Analyze blast radius of changed or specified files")
    .argument("[files...]", "Files to analyze (defaults to git changes)")
    .option("--since <ref>", "Compare against a Git ref when discovering changes")
    .action(async (files: string[], cmdOpts: { since?: string }) => {
      const opts = resolveOutputOptions(program);
      const code = await impactCommand({
        ...opts,
        files: files.length > 0 ? files : undefined,
        since: cmdOpts.since,
      });
      process.exitCode = code;
    });

  program
    .command("check")
    .description("Run architecture rules and optional project scripts")
    .option("--skip-scripts", "Only evaluate architecture rules", false)
    .action(async (cmdOpts: { skipScripts?: boolean }) => {
      const opts = resolveOutputOptions(program);
      const code = await checkCommand({
        ...opts,
        skipScripts: Boolean(cmdOpts.skipScripts),
      });
      process.exitCode = code;
    });

  program
    .command("clean")
    .description("Clear the local .repopilot/cache")
    .action(async () => {
      const opts = resolveOutputOptions(program);
      const code = await cleanCommand(opts);
      process.exitCode = code;
    });

  const pluginsCmd = program
    .command("plugins")
    .description("Inspect and manage RepoPilot plugins");

  pluginsCmd
    .command("list")
    .description("List built-in and configured plugins")
    .action(async () => {
      const opts = resolveOutputOptions(program);
      const code = await pluginsListCommand(opts);
      process.exitCode = code;
    });
}

async function registerPluginCommandGroups(
  program: Command,
  cwd: string,
): Promise<void> {
  // Resolve cwd from argv early so --cwd works for plugin registration
  const cwdFlag = extractCwdFromArgv(process.argv) ?? cwd;
  const root = findProjectRoot(cwdFlag);
  const { registry } = await loadPlugins(root);

  // Core + already-registered names — colliding plugin names would throw inside
  // Commander and break every CLI invocation. Compare case-insensitively.
  const taken = new Set(
    program.commands
      .map((c) => c.name())
      .filter(Boolean)
      .map((n) => n.toLowerCase()),
  );

  for (const entry of registry.list()) {
    const plugin = registry.get(entry.name);
    if (!plugin || !plugin.commands?.length) continue;
    // Only mount CLI groups for plugins that detected in this project.
    if (!entry.active) continue;
    const conflict = findCommandNameConflict(plugin.name, taken);
    if (conflict) {
      process.stderr.write(
        `warning: ${pluginCommandGroupConflictWarning(plugin.name, conflict)}\n`,
      );
      continue;
    }
    taken.add(plugin.name.toLowerCase());

    const group = program
      .command(plugin.name)
      .description(`${plugin.name} plugin commands`);

    for (const cmd of plugin.commands) {
      group
        .command(cmd.name)
        .description(cmd.description)
        .action(async () => {
          const opts = resolveOutputOptions(program);
          const invokeRoot = findProjectRoot(opts.cwd);
          const loaded = await loadPlugins(invokeRoot);
          const code = await cmd.run(loaded.context, opts);
          process.exitCode = code;
        });
    }
  }
}

function extractCwdFromArgv(argv: string[]): string | undefined {
  const idx = argv.indexOf("--cwd");
  if (idx >= 0 && argv[idx + 1]) return argv[idx + 1];
  const eq = argv.find((a) => a.startsWith("--cwd="));
  if (eq) return eq.slice("--cwd=".length);
  return undefined;
}

function resolveOutputOptions(program: Command): OutputOptions {
  const opts = program.opts<{
    json?: boolean;
    quiet?: boolean;
    color?: boolean;
    cache?: boolean;
    cwd?: string;
  }>();

  return {
    json: Boolean(opts.json),
    quiet: Boolean(opts.quiet),
    color: opts.color !== false && Boolean(process.stdout.isTTY),
    cache: opts.cache !== false,
    cwd: opts.cwd ?? process.cwd(),
  };
}
