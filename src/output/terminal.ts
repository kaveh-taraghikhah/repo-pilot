import pc from "picocolors";
import type { ProjectGraph } from "../graph/graph.ts";
import type {
  AnalyzeResult,
  CacheStats,
  ChangedResult,
  CheckResult,
  DoctorCheckResult,
  DoctorResult,
  GraphCommandResult,
  ImpactResult,
  OutputOptions,
} from "./types.ts";

function paint(options: OutputOptions) {
  const enabled = options.color && !process.env.NO_COLOR;
  return {
    bold: (s: string) => (enabled ? pc.bold(s) : s),
    dim: (s: string) => (enabled ? pc.dim(s) : s),
    green: (s: string) => (enabled ? pc.green(s) : s),
    yellow: (s: string) => (enabled ? pc.yellow(s) : s),
    red: (s: string) => (enabled ? pc.red(s) : s),
    cyan: (s: string) => (enabled ? pc.cyan(s) : s),
  };
}

function statusIcon(
  status: DoctorCheckResult["status"],
  c: ReturnType<typeof paint>,
): string {
  switch (status) {
    case "pass":
      return c.green("✓");
    case "warn":
      return c.yellow("⚠");
    case "fail":
      return c.red("✗");
  }
}

export function printDoctor(result: DoctorResult, options: OutputOptions): void {
  if (options.quiet) return;
  const c = paint(options);

  process.stdout.write(`\n${c.bold("RepoPilot Doctor")}\n\n`);

  const passed = result.checks.filter((x) => x.status === "pass");
  const warnings = result.checks.filter((x) => x.status === "warn");
  const failed = result.checks.filter((x) => x.status === "fail");

  for (const check of passed) {
    process.stdout.write(`${statusIcon(check.status, c)} ${check.message}\n`);
  }

  if (warnings.length > 0) {
    process.stdout.write(`\n${c.bold("Warnings")}\n\n`);
    for (const check of warnings) {
      process.stdout.write(`${statusIcon(check.status, c)} ${check.message}\n`);
      for (const detail of check.details ?? []) {
        process.stdout.write(`    ${c.dim(detail)}\n`);
      }
    }
  }

  if (failed.length > 0) {
    process.stdout.write(`\n${c.bold("Failures")}\n\n`);
    for (const check of failed) {
      process.stdout.write(`${statusIcon(check.status, c)} ${check.message}\n`);
      for (const detail of check.details ?? []) {
        process.stdout.write(`    ${c.dim(detail)}\n`);
      }
    }
  }

  process.stdout.write("\n");
  const summary = `${result.summary.passed} passed, ${result.summary.warnings} warnings, ${result.summary.failed} failed`;
  if (result.summary.failed > 0) {
    process.stdout.write(`${c.red(summary)}\n`);
  } else if (result.summary.warnings > 0) {
    process.stdout.write(`${c.yellow(summary)}\n`);
  } else {
    process.stdout.write(`${c.green(summary)}\n`);
  }
  process.stdout.write("\n");
}

export function printAnalyze(result: AnalyzeResult, options: OutputOptions): void {
  if (options.quiet) return;
  const c = paint(options);

  process.stdout.write(`\n${c.bold("Repository Analysis")}\n\n`);
  process.stdout.write(`${c.bold("Project:")}\n  ${result.project}\n\n`);
  process.stdout.write(`${c.bold("Files:")}\n  ${result.files}\n\n`);
  process.stdout.write(`${c.bold("TypeScript:")}\n  ${result.typescriptPercentage}%\n\n`);
  process.stdout.write(
    `${c.bold("React:")}\n  ~${result.reactComponents} components (approx)\n\n`,
  );
  process.stdout.write(`${c.bold("Tests:")}\n  ${result.testFiles}\n\n`);
  process.stdout.write(`${c.bold("AST:")}\n`);
  process.stdout.write(`  ${result.modules} modules\n`);
  process.stdout.write(`  ${result.functions} functions\n`);
  process.stdout.write(`  ${result.classes} classes\n`);
  process.stdout.write(`  ${result.routes} routes\n`);
  process.stdout.write(`  ${result.exports} exports\n\n`);
  process.stdout.write(`${c.bold("Dependencies:")}\n`);
  process.stdout.write(`  ${result.dependencies.production} production\n`);
  process.stdout.write(`  ${result.dependencies.development} development\n\n`);

  if (result.architecture.length > 0) {
    process.stdout.write(`${c.bold("Architecture:")}\n\n`);
    for (const line of result.architecture) {
      process.stdout.write(`  ${line}\n`);
    }
    process.stdout.write("\n");
  }

  if (result.issues.length > 0) {
    process.stdout.write(`${c.bold("Potential issues")}\n\n`);
    for (const issue of result.issues) {
      const icon = issue.severity === "warn" ? c.yellow("⚠") : c.cyan("•");
      process.stdout.write(`${icon} ${issue.message}\n`);
    }
    process.stdout.write("\n");
  }
}

const MAX_DEPTH = 4;
const MAX_CHILDREN = 8;

export function printGraph(
  result: GraphCommandResult,
  graph: ProjectGraph,
  options: OutputOptions,
): void {
  if (options.quiet) return;
  const c = paint(options);

  process.stdout.write(`\n${c.bold("Dependency Graph")}\n\n`);

  const internal = result.nodes.filter((n) => n.kind !== "external");
  process.stdout.write(
    c.dim(`${internal.length} modules, ${result.edges.length} edges\n\n`),
  );

  const preferred = pickRoots(graph);
  const visitedGlobal = new Set<string>();

  for (const rootId of preferred) {
    printTree(rootId, graph, "", true, 0, visitedGlobal, c, new Set());
    process.stdout.write("\n");
  }

  if (result.cycles.length > 0) {
    process.stdout.write(`${c.bold("Cycles")}\n\n`);
    for (const cycle of result.cycles.slice(0, 10)) {
      process.stdout.write(`${c.yellow("⚠")} ${cycle.join(" -> ")}\n`);
    }
    process.stdout.write("\n");
  }
}

function pickRoots(graph: ProjectGraph): string[] {
  const entries = graph.entryNodes().map((n) => n.id);
  const preferred = entries.filter(
    (id) =>
      /(^|\/)index\.[cm]?[jt]sx?$/.test(id) ||
      /(^|\/)main\.[cm]?[jt]sx?$/.test(id) ||
      /(^|\/)app\//.test(id) ||
      /(^|\/)api\//.test(id),
  );
  const roots = preferred.length > 0 ? preferred : entries;
  if (roots.length > 0) return roots.slice(0, 12);

  // Fallback: highest fan-out modules
  return graph
    .getNodes()
    .filter((n) => n.kind !== "external")
    .sort(
      (a, b) =>
        graph.dependenciesOf(b.id).length - graph.dependenciesOf(a.id).length,
    )
    .slice(0, 8)
    .map((n) => n.id);
}

function printTree(
  id: string,
  graph: ProjectGraph,
  prefix: string,
  isLast: boolean,
  depth: number,
  visitedGlobal: Set<string>,
  c: ReturnType<typeof paint>,
  pathStack: Set<string>,
): void {
  const node = graph.getNode(id);
  if (!node || node.kind === "external") return;

  const branch = depth === 0 ? "" : isLast ? "└── " : "├── ";
  const label =
    node.kind === "route"
      ? `${id} ${c.dim("(route)")}`
      : node.kind === "test"
        ? `${id} ${c.dim("(test)")}`
        : id;
  process.stdout.write(`${prefix}${branch}${label}\n`);

  if (pathStack.has(id) || depth >= MAX_DEPTH) return;
  // Already expanded under another root/branch — print the label once, skip children.
  if (visitedGlobal.has(id)) return;

  const nextStack = new Set(pathStack);
  nextStack.add(id);
  visitedGlobal.add(id);

  const children = graph
    .dependenciesOf(id)
    .filter((dep) => {
      const n = graph.getNode(dep);
      return n && n.kind !== "external";
    })
    .slice(0, MAX_CHILDREN);

  const childPrefix =
    depth === 0 ? "" : prefix + (isLast ? "    " : "│   ");

  children.forEach((child, index) => {
    printTree(
      child,
      graph,
      childPrefix,
      index === children.length - 1,
      depth + 1,
      visitedGlobal,
      c,
      nextStack,
    );
  });
}

export function printChanged(result: ChangedResult, options: OutputOptions): void {
  if (options.quiet) return;
  const c = paint(options);

  process.stdout.write(`\n${c.bold("Current branch:")}\n  ${result.branch}\n\n`);
  if (result.since) {
    process.stdout.write(`${c.dim(`Since: ${result.since}`)}\n\n`);
  }
  process.stdout.write(`${result.summary.total} files changed\n\n`);

  const bands: Array<{ key: keyof ChangedResult["summary"]; title: string }> = [
    { key: "high", title: "High impact" },
    { key: "medium", title: "Medium impact" },
    { key: "low", title: "Low impact" },
  ];

  for (const band of bands) {
    if (band.key === "total") continue;
    const files = result.files.filter((f) => f.impact === band.key);
    if (files.length === 0) continue;
    const titleColor =
      band.key === "high" ? c.red : band.key === "medium" ? c.yellow : c.dim;
    process.stdout.write(`${c.bold(titleColor(band.title))}:\n`);
    for (const file of files) {
      process.stdout.write(`  ${file.status} ${file.path}\n`);
    }
    process.stdout.write("\n");
  }

  if (result.summary.total === 0) {
    process.stdout.write(`${c.dim("No changes detected.")}\n\n`);
  }
}

export function printImpact(result: ImpactResult, options: OutputOptions): void {
  if (options.quiet) return;
  const c = paint(options);

  process.stdout.write(`\n${c.bold("Impact Analysis")}\n\n`);

  process.stdout.write(`${c.bold("Changed files")}\n`);
  process.stdout.write(`${c.dim("─────────────")}\n\n`);
  if (result.changed.length === 0) {
    process.stdout.write(`  ${c.dim("(none)")}\n\n`);
  } else {
    for (const file of result.changed) {
      process.stdout.write(`  ${file}\n`);
    }
    process.stdout.write("\n");
  }

  process.stdout.write(`${c.bold("Direct dependents")}\n`);
  process.stdout.write(`${c.dim("─────────────────")}\n\n`);
  printList(result.directDependents, c);

  process.stdout.write(`${c.bold("Indirect dependents")}\n`);
  process.stdout.write(`${c.dim("───────────────────")}\n\n`);
  printList(result.indirectDependents, c);

  process.stdout.write(`${c.bold("Tests potentially affected")}\n`);
  process.stdout.write(`${c.dim("──────────────────────────")}\n\n`);
  printList(result.affectedTests, c);

  const riskColor =
    result.risk === "high" ? c.red : result.risk === "medium" ? c.yellow : c.green;
  process.stdout.write(`${c.bold("Risk")}\n`);
  process.stdout.write(`${c.dim("────")}\n\n`);
  process.stdout.write(`  ${riskColor(result.risk.toUpperCase())}\n\n`);

  if (result.reasons.length > 0) {
    process.stdout.write(`${c.bold("Reasons:")}\n`);
    for (const reason of result.reasons) {
      process.stdout.write(`  • ${reason}\n`);
    }
    process.stdout.write("\n");
  }

  if (result.suggestedValidation.length > 0) {
    process.stdout.write(`${c.bold("Suggested validation:")}\n`);
    for (const cmd of result.suggestedValidation) {
      process.stdout.write(`  ${c.cyan(cmd)}\n`);
    }
    process.stdout.write("\n");
  }
}

function printList(
  items: string[],
  c: ReturnType<typeof paint>,
): void {
  if (items.length === 0) {
    process.stdout.write(`  ${c.dim("(none)")}\n\n`);
    return;
  }
  for (const item of items) {
    process.stdout.write(`  ${item}\n`);
  }
  process.stdout.write("\n");
}

export function printError(message: string, options: OutputOptions): void {
  const c = paint(options);
  process.stderr.write(`${c.red("Error:")} ${message}\n`);
}

export function printCacheStats(stats: CacheStats, options: OutputOptions): void {
  if (options.quiet || options.json) return;
  const c = paint(options);
  process.stdout.write(
    `${c.dim(`Cache: ${stats.filesCached} hit, ${stats.filesParsed} parsed (${stats.durationMs}ms)`)}\n\n`,
  );
}

export function printCheck(result: CheckResult, options: OutputOptions): void {
  if (options.quiet) return;
  const c = paint(options);

  process.stdout.write(`\n${c.bold("RepoPilot Check")}\n\n`);

  for (const script of result.scripts) {
    if (script.status === "pass") {
      process.stdout.write(`${c.green("✓")} ${script.name}\n`);
    } else if (script.status === "fail") {
      process.stdout.write(`${c.red("✗")} ${script.name}\n`);
      if (script.message) {
        process.stdout.write(`  ${c.dim(script.message.split("\n")[0] ?? "")}\n`);
      }
    }
  }

  if (result.architecture.rulesEvaluated === 0) {
    process.stdout.write(`${c.dim("•")} Architecture ${c.dim("(no rules configured)")}\n`);
  } else if (result.architecture.violations.length === 0) {
    process.stdout.write(`${c.green("✓")} Architecture\n`);
  } else {
    process.stdout.write(`${c.red("✗")} Architecture\n\n`);
    process.stdout.write(
      `${result.architecture.violations.length} violation${result.architecture.violations.length === 1 ? "" : "s"}\n\n`,
    );

    const byRule = new Map<string, Array<{ from: string; to: string }>>();
    for (const v of result.architecture.violations) {
      const list = byRule.get(v.rule) ?? [];
      list.push({ from: v.from, to: v.to });
      byRule.set(v.rule, list);
    }

    for (const [rule, items] of byRule) {
      process.stdout.write(`${c.bold(rule)}\n`);
      for (const item of items) {
        process.stdout.write(`  ${item.from} → ${item.to}\n`);
      }
      process.stdout.write("\n");
    }
  }

  for (const check of result.pluginChecks ?? []) {
    const label = `${check.plugin}: ${check.label}`;
    if (check.status === "pass") {
      process.stdout.write(`${c.green("✓")} ${label}\n`);
    } else if (check.status === "warn") {
      process.stdout.write(`${c.yellow("!")} ${label}\n`);
      process.stdout.write(`  ${c.dim(check.message)}\n`);
    } else {
      process.stdout.write(`${c.red("✗")} ${label}\n`);
      process.stdout.write(`  ${c.dim(check.message)}\n`);
    }
  }

  process.stdout.write("\n");
  if (result.passed) {
    process.stdout.write(`${c.green(c.bold("Result: PASSED"))}\n\n`);
  } else {
    process.stdout.write(`${c.red(c.bold("Result: FAILED"))}\n\n`);
  }
}
