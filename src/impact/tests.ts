import type { ProjectGraph } from "../graph/graph.ts";
import { isTestFile } from "../scanner/scan-files.ts";
import { normalize } from "./walk.ts";

/**
 * Collect test files affected by seed + dependent closure.
 */
export function collectAffectedTests(
  graph: ProjectGraph,
  seeds: string[],
  direct: string[],
  indirect: string[],
): string[] {
  const closure = new Set([
    ...seeds.map(normalize),
    ...direct.map(normalize),
    ...indirect.map(normalize),
  ]);
  const tests = new Set<string>();

  for (const id of closure) {
    const node = graph.getNode(id);
    if (node?.kind === "test" || isTestFile(id)) {
      tests.add(id);
    }
  }

  // Any test that directly imports a seed or affected non-test module
  for (const node of graph.getNodes()) {
    if (node.kind !== "test" && !isTestFile(node.id)) continue;
    const deps = graph.dependenciesOf(node.id);
    if (deps.some((d) => closure.has(d))) {
      tests.add(node.id);
    }
  }

  // Exclude seeds that are themselves the only "test" if they're not tests — fine
  return [...tests].filter((t) => isTestFile(t) || graph.getNode(t)?.kind === "test").sort();
}
