import { extname } from "node:path";
import type { ProjectGraph } from "../graph/graph.ts";
import {
  isSourceFile,
  isTestFile,
} from "../scanner/scan-files.ts";
import type { GitFileChange } from "./status.ts";

export type ImpactBand = "high" | "medium" | "low";

export interface ScoredChange {
  path: string;
  status: string;
  impact: ImpactBand;
  dependents: number;
}

const HIGH_PATH =
  /(^|\/)(services|api|workers|repositories)\//;

const LOW_EXT = new Set([
  ".md",
  ".txt",
  ".json",
  ".yml",
  ".yaml",
  ".toml",
  ".lock",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".css",
  ".scss",
]);

export function scoreChangedFiles(
  files: GitFileChange[],
  graph: ProjectGraph | null,
): ScoredChange[] {
  return files.map((file) => scoreOne(file, graph));
}

export function scoreOne(
  file: GitFileChange,
  graph: ProjectGraph | null,
): ScoredChange {
  const path = file.path.replaceAll("\\", "/");
  const dependents = countDependents(path, graph);
  const impact = bandFor(path, dependents);
  return {
    path,
    status: file.status,
    impact,
    dependents,
  };
}

function countDependents(path: string, graph: ProjectGraph | null): number {
  if (!graph) return 0;
  // Graph node ids are repo-relative posix paths
  if (graph.getNode(path)) {
    return graph.dependentsOf(path).filter((id) => {
      const node = graph.getNode(id);
      return node && node.kind !== "external";
    }).length;
  }
  return 0;
}

export function bandFor(path: string, dependents: number): ImpactBand {
  if (isTestFile(path)) return "low";

  const ext = extname(path).toLowerCase();
  const base = path.split("/").pop() ?? path;

  if (
    LOW_EXT.has(ext) ||
    base === "package-lock.json" ||
    base === "pnpm-lock.yaml" ||
    base === "yarn.lock" ||
    base === "bun.lock" ||
    base === "bun.lockb" ||
    base === "LICENSE" ||
    base === ".gitignore"
  ) {
    return "low";
  }

  if (dependents >= 5) return "high";
  if (HIGH_PATH.test(path) && dependents >= 1) return "high";

  // Source modules are at least medium: even a leaf can still break callers
  // that resolve through aliases, dynamic imports, or files outside the graph.
  if (isSourceFile(ext)) return "medium";

  return "low";
}
