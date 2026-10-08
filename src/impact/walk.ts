import type { ProjectGraph } from "../graph/graph.ts";
import { isTestFile } from "../scanner/scan-files.ts";

export interface DependentSets {
  direct: string[];
  indirect: string[];
}

/**
 * BFS over inbound edges to collect transitive dependents of seed modules.
 * Seeds themselves are excluded. External nodes and test files are skipped
 * (tests are collected separately).
 */
export function collectDependents(
  graph: ProjectGraph,
  seeds: string[],
): DependentSets {
  const seedSet = new Set(seeds.map(normalize));
  const direct = new Set<string>();
  const indirect = new Set<string>();
  const visited = new Set<string>();
  const queue: Array<{ id: string; depth: number }> = [];

  for (const seed of seedSet) {
    if (!graph.getNode(seed)) continue;
    for (const dep of internalDependents(graph, seed)) {
      if (seedSet.has(dep)) continue;
      queue.push({ id: dep, depth: 1 });
    }
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current.id) || seedSet.has(current.id)) continue;
    visited.add(current.id);

    const isTest =
      isTestFile(current.id) || graph.getNode(current.id)?.kind === "test";

    if (!isTest) {
      if (current.depth === 1) direct.add(current.id);
      else indirect.add(current.id);
    }

    for (const next of internalDependents(graph, current.id)) {
      if (visited.has(next) || seedSet.has(next)) continue;
      queue.push({ id: next, depth: current.depth + 1 });
    }
  }

  for (const id of direct) indirect.delete(id);

  return {
    direct: [...direct].sort(),
    indirect: [...indirect].sort(),
  };
}

function internalDependents(graph: ProjectGraph, id: string): string[] {
  return graph.dependentsOf(id).filter((dep) => {
    const node = graph.getNode(dep);
    return Boolean(node && node.kind !== "external");
  });
}

export function normalize(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}
