import { loadProjectGraph } from "../../analyzer/load-graph.ts";
import { loadConfig } from "../../config/loader.ts";
import { collectChangedFiles } from "../../git/changed.ts";
import { scoreChangedFiles } from "../../git/impact-score.ts";
import { assertValidSinceRef } from "../../git/since.ts";
import { printJson } from "../../output/json.ts";
import { printChanged } from "../../output/terminal.ts";
import type { ChangedResult, OutputOptions } from "../../output/types.ts";
import { findProjectRoot } from "../../scanner/find-root.ts";
import { scanFiles } from "../../scanner/scan-files.ts";
import { runCommand } from "../errors.ts";

export interface ChangedCommandOptions extends OutputOptions {
  since?: string;
}

export async function changedCommand(
  options: ChangedCommandOptions,
): Promise<number> {
  return runCommand(options, async () => {
    const root = findProjectRoot(options.cwd);
    assertValidSinceRef(root, options.since);
    const snapshot = collectChangedFiles({
      cwd: root,
      since: options.since,
    });

    let graph = null;
    try {
      const config = await loadConfig(root);
      const scan = await scanFiles(root, config.ignore ?? []);
      const loaded = await loadProjectGraph(root, scan.files, {
        cache: options.cache,
      });
      graph = loaded.graph;
    } catch {
      graph = null;
    }

    const scored = scoreChangedFiles(snapshot.files, graph);
    const summary = {
      high: scored.filter((f) => f.impact === "high").length,
      medium: scored.filter((f) => f.impact === "medium").length,
      low: scored.filter((f) => f.impact === "low").length,
      total: scored.length,
    };

    const result: ChangedResult = {
      branch: snapshot.branch,
      since: snapshot.since,
      files: scored,
      summary,
    };

    if (options.json) {
      printJson(result);
    } else {
      printChanged(result, options);
    }

    return 0;
  });
}
