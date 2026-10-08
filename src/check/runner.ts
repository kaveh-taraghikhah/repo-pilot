import { loadProjectGraph } from "../analyzer/load-graph.ts";
import { loadConfig } from "../config/loader.ts";
import type { CheckResult, PluginCheckItem } from "../output/types.ts";
import { loadPlugins } from "../plugins/loader.ts";
import { evaluateArchitectureRules } from "../rules/evaluate.ts";
import { findProjectRoot } from "../scanner/find-root.ts";
import { scanFiles } from "../scanner/scan-files.ts";
import { runProjectScripts } from "./scripts.ts";

export interface RunCheckOptions {
  cwd: string;
  cache?: boolean;
  /** Skip package.json script runners (useful in tests) */
  skipScripts?: boolean;
}

export async function runCheck(options: RunCheckOptions): Promise<CheckResult> {
  const root = findProjectRoot(options.cwd);
  const config = await loadConfig(root);
  const scan = await scanFiles(root, config.ignore ?? []);
  const { graph, stats } = await loadProjectGraph(root, scan.files, {
    cache: options.cache !== false,
  });

  const rules = config.rules ?? [];
  const violations = evaluateArchitectureRules(graph, rules);

  const scripts = options.skipScripts
    ? []
    : await runProjectScripts(root);

  const { registry, context } = await loadPlugins(root);
  const pluginChecks: PluginCheckItem[] = [];
  for (const plugin of registry.getActive()) {
    for (const check of plugin.checks ?? []) {
      const result = await check.run(context);
      pluginChecks.push({
        id: check.id,
        label: check.label,
        plugin: plugin.name,
        status: result.status,
        message: result.message,
      });
    }
  }

  const scriptFailures = scripts.filter((s) => s.status === "fail").length;
  const pluginFailures = pluginChecks.filter((c) => c.status === "fail").length;
  const passed =
    violations.length === 0 && scriptFailures === 0 && pluginFailures === 0;

  return {
    passed,
    architecture: {
      rulesEvaluated: rules.length,
      violations,
    },
    scripts,
    pluginChecks,
    summary: {
      violations: violations.length,
      scriptFailures,
      pluginFailures,
    },
    cache: stats,
  };
}

export function checkExitCode(result: CheckResult): number {
  return result.passed ? 0 : 1;
}
