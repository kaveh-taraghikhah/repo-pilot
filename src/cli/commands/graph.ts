import { loadProjectGraph } from "../../analyzer/load-graph.ts";
import { loadConfig } from "../../config/loader.ts";
import { startGraphServer } from "../../graph/serve.ts";
import type { ProjectGraph } from "../../graph/graph.ts";
import { printJson } from "../../output/json.ts";
import { printCacheStats, printGraph } from "../../output/terminal.ts";
import type { GraphCommandResult, OutputOptions } from "../../output/types.ts";
import { findProjectRoot } from "../../scanner/find-root.ts";
import { scanFiles } from "../../scanner/scan-files.ts";
import { runCommand } from "../errors.ts";

export interface GraphCommandOptions extends OutputOptions {
  format: "text" | "json";
  serve?: boolean;
  port?: number;
  open?: boolean;
}

export async function graphCommand(options: GraphCommandOptions): Promise<number> {
  const preferJson = Boolean(options.json || options.format === "json");

  return runCommand(
    options,
    async () => {
      const root = findProjectRoot(options.cwd);
      const config = await loadConfig(root);
      const scan = await scanFiles(root, config.ignore ?? []);
      const { graph, stats } = await loadProjectGraph(root, scan.files, {
        cache: options.cache,
      });
      const result = toResult(root, graph, stats);

      if (options.serve) {
        const port = options.port ?? 4173;
        const openBrowser = options.open !== false && Boolean(process.stdout.isTTY);

        const server = await startGraphServer({
          port,
          payload: result,
          openBrowser,
          refresh: async () => {
            const cfg = await loadConfig(root);
            const sc = await scanFiles(root, cfg.ignore ?? []);
            const loaded = await loadProjectGraph(root, sc.files, {
              cache: options.cache,
            });
            return toResult(root, loaded.graph, loaded.stats);
          },
        });

        if (!options.quiet && !options.json) {
          process.stdout.write(`\nRepoPilot graph viewer → ${server.url}\n`);
          process.stdout.write("Press Ctrl+C to stop.\n\n");
          if (result.cache) printCacheStats(result.cache, options);
        }

        await new Promise<void>((resolve) => {
          const stop = () => {
            server.stop();
            resolve();
          };
          process.once("SIGINT", stop);
          process.once("SIGTERM", stop);
        });

        return 0;
      }

      if (preferJson) {
        printJson(result);
      } else {
        printGraph(result, graph, options);
        if (result.cache) printCacheStats(result.cache, options);
      }

      return 0;
    },
    preferJson ? "json" : "human",
  );
}

function toResult(
  root: string,
  graph: ProjectGraph,
  stats: GraphCommandResult["cache"],
): GraphCommandResult {
  const json = graph.toJSON();
  return {
    root,
    nodes: json.nodes,
    edges: json.edges,
    cycles: json.cycles,
    cache: stats,
  };
}
