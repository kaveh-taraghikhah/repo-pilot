import { loadPlugins } from "../../plugins/loader.ts";
import { printJson } from "../../output/json.ts";
import type { OutputOptions } from "../../output/types.ts";
import type { PluginListEntry } from "../../plugins/types.ts";
import { findProjectRoot } from "../../scanner/find-root.ts";
import { runCommand } from "../errors.ts";
import { createCoreProgram } from "../program.ts";
import {
  findCommandNameConflict,
  pluginCommandGroupConflictWarning,
  takenTopLevelCommandNames,
} from "../reserved-commands.ts";

export async function pluginsListCommand(options: OutputOptions): Promise<number> {
  return runCommand(options, async () => {
    const root = findProjectRoot(options.cwd);
    const { registry, warnings: loadWarnings } = await loadPlugins(root);
    const taken = takenTopLevelCommandNames(createCoreProgram(options.cwd));
    const warnings = [...loadWarnings];

    // Mirror CLI registration: inactive / colliding names are not mounted, so
    // don't advertise commands that cannot be invoked.
    const plugins: PluginListEntry[] = registry.list().map((p) => {
      if (!p.commands.length) return p;
      if (!p.active) {
        return { ...p, commands: [] };
      }
      const conflict = findCommandNameConflict(p.name, taken);
      if (!conflict) {
        taken.add(p.name.toLowerCase());
        return p;
      }
      warnings.push(pluginCommandGroupConflictWarning(p.name, conflict));
      return { ...p, commands: [] };
    });

    if (options.json) {
      printJson({ plugins, warnings });
    } else if (!options.quiet) {
      printPluginsList(plugins);
      for (const w of warnings) {
        process.stderr.write(`warning: ${w}\n`);
      }
    }
    return 0;
  });
}

function printPluginsList(plugins: PluginListEntry[]): void {
  process.stdout.write("\nPlugins\n\n");
  for (const p of plugins) {
    const mark = p.active ? "✓" : "·";
    const suffix = p.active ? "" : " (not detected)";
    process.stdout.write(`  ${mark} ${p.name}${suffix}\n`);
  }
  process.stdout.write("\n");
}
