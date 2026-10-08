import type { ProjectGraph } from "../graph/graph.ts";
import { matchesAnyGlob, matchesGlob } from "./match.ts";
import type { ArchitectureRule, RuleViolation } from "./types.ts";

/**
 * Evaluate architecture boundary rules against the project import graph.
 * External package nodes are ignored as targets.
 */
export function evaluateArchitectureRules(
  graph: ProjectGraph,
  rules: ArchitectureRule[],
): RuleViolation[] {
  if (rules.length === 0) return [];

  const violations: RuleViolation[] = [];

  for (const edge of graph.getEdges()) {
    const fromNode = graph.getNode(edge.from);
    const toNode = graph.getNode(edge.to);
    if (!fromNode || !toNode) continue;
    if (toNode.kind === "external") continue;

    for (const rule of rules) {
      if (!matchesGlob(edge.from, rule.from)) continue;
      if (!matchesAnyGlob(edge.to, rule.cannotImport)) continue;
      violations.push({
        rule: rule.name,
        from: edge.from,
        to: edge.to,
      });
    }
  }

  return violations.sort((a, b) =>
    a.rule.localeCompare(b.rule) || a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
  );
}
