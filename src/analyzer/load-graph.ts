import { buildProjectGraph } from "../graph/build.ts";
import type { ProjectGraph } from "../graph/graph.ts";
import type { CacheStats } from "../cache/types.ts";
import type { ScannedFile } from "../scanner/scan-files.ts";
import {
  parseProjectIncremental,
  type IncrementalParseOptions,
} from "./parse-incremental.ts";
import type { ParseResult } from "./parser.ts";

export interface LoadGraphResult {
  graph: ProjectGraph;
  parsed: ParseResult;
  stats: CacheStats;
}

export async function loadProjectGraph(
  root: string,
  scanned: ScannedFile[],
  options: IncrementalParseOptions = {},
): Promise<LoadGraphResult> {
  const { parseResult, stats } = await parseProjectIncremental(
    root,
    scanned,
    options,
  );
  const graph = buildProjectGraph(parseResult);
  return { graph, parsed: parseResult, stats };
}
