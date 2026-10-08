import { runAnalyze } from "../../analyzer/project-report.ts";
import { loadConfig } from "../../config/loader.ts";
import { printJson } from "../../output/json.ts";
import { printAnalyze, printCacheStats } from "../../output/terminal.ts";
import type { OutputOptions } from "../../output/types.ts";
import { findProjectRoot } from "../../scanner/find-root.ts";
import { readManifests } from "../../scanner/read-manifests.ts";
import { scanFiles } from "../../scanner/scan-files.ts";
import { runCommand } from "../errors.ts";

export async function analyzeCommand(options: OutputOptions): Promise<number> {
  return runCommand(options, async () => {
    const root = findProjectRoot(options.cwd);
    const [manifests, config] = await Promise.all([
      readManifests(root),
      loadConfig(root),
    ]);
    const scan = await scanFiles(root, config.ignore ?? []);

    const result = await runAnalyze({
      root,
      files: scan.files,
      manifests,
      config,
      cache: options.cache,
    });

    if (options.json) {
      printJson(result);
    } else {
      printAnalyze(result, options);
      if (result.cache) printCacheStats(result.cache, options);
    }

    return 0;
  });
}
