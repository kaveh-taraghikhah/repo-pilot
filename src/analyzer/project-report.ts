import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { COMPLEXITY_THRESHOLD, isHighComplexity } from "./complexity.ts";
import { loadProjectGraph } from "./load-graph.ts";
import { findUnusedExports } from "./unused-exports.ts";
import type {
  AnalyzeIssue,
  AnalyzeResult,
  CacheStats,
  RepoPilotConfig,
} from "../output/types.ts";
import type { ManifestSnapshot } from "../scanner/read-manifests.ts";
import {
  countByExtension,
  isSourceFile,
  isTestFile,
  isTypeScriptFile,
  type ScannedFile,
} from "../scanner/scan-files.ts";

export interface AnalyzeContext {
  root: string;
  files: ScannedFile[];
  manifests: ManifestSnapshot;
  config: RepoPilotConfig;
  cache?: boolean;
}

/** Aggregate parse/graph stats into the `analyze` command result. */
export async function runAnalyze(ctx: AnalyzeContext): Promise<AnalyzeResult> {
  const filesByExtension = countByExtension(ctx.files);
  const sourceFiles = ctx.files.filter((f) => isSourceFile(f.extension));
  const tsFiles = sourceFiles.filter((f) => isTypeScriptFile(f.extension));
  const typescriptPercentage =
    sourceFiles.length === 0
      ? 0
      : Math.round((tsFiles.length / sourceFiles.length) * 100);

  const testFiles = ctx.files.filter((f) => isTestFile(f.relativePath)).length;

  const pkg = ctx.manifests.packageJson;
  const project = pkg?.name ?? "unknown";
  const production = Object.keys(pkg?.dependencies ?? {}).length;
  const development = Object.keys(pkg?.devDependencies ?? {}).length;

  const architecture = await buildArchitectureTree(ctx.root);

  const { parsed, graph, stats } = await loadProjectGraph(ctx.root, ctx.files, {
    cache: ctx.cache !== false,
  });
  const cycles = graph.findCycles();
  const unused = findUnusedExports(parsed);

  let functions = 0;
  let classes = 0;
  let routes = 0;
  let exportsCount = 0;
  let highComplexityFiles = 0;
  let reactComponents = 0;

  for (const file of parsed.files) {
    functions += file.symbols.functions.length;
    classes += file.symbols.classes.length;
    if (file.symbols.isRoute) routes += 1;
    exportsCount += file.exports.length;
    if (isHighComplexity(file.complexity)) highComplexityFiles += 1;
    if (file.file.endsWith(".tsx") || file.file.endsWith(".jsx")) {
      reactComponents += 1;
    }
  }

  const modules = parsed.files.filter((f) => !f.symbols.isTest).length;

  const issues = collectIssues(ctx, {
    typescriptFileCount: tsFiles.length,
    testFiles,
    cycles,
    unusedCount: unused.length,
    highComplexityFiles,
  });

  return {
    project,
    root: ctx.root,
    files: ctx.files.length,
    filesByExtension,
    typescriptPercentage,
    reactComponents,
    testFiles,
    dependencies: { production, development },
    architecture,
    modules,
    functions,
    classes,
    routes,
    exports: exportsCount,
    circularDependencies: cycles.length,
    unusedExports: unused.length,
    highComplexityFiles,
    issues,
    cache: stats satisfies CacheStats,
  };
}

async function buildArchitectureTree(root: string): Promise<string[]> {
  const candidates = ["src", "app", "lib", "packages"];
  const lines: string[] = [];

  for (const dir of candidates) {
    const absolute = join(root, dir);
    let entries;
    try {
      entries = await readdir(absolute, { withFileTypes: true });
    } catch {
      continue;
    }

    const children = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();

    if (children.length === 0) {
      lines.push(`${dir}/`);
      continue;
    }

    lines.push(`${dir}/`);
    children.forEach((name, index) => {
      const prefix = index === children.length - 1 ? "└──" : "├──";
      lines.push(`  ${prefix} ${name}`);
    });
  }

  return lines;
}

function collectIssues(
  ctx: AnalyzeContext,
  stats: {
    typescriptFileCount: number;
    testFiles: number;
    cycles: string[][];
    unusedCount: number;
    highComplexityFiles: number;
  },
): AnalyzeIssue[] {
  const issues: AnalyzeIssue[] = [];

  if (stats.typescriptFileCount > 0 && !ctx.manifests.tsconfig) {
    if (ctx.manifests.tsconfigError) {
      issues.push({
        severity: "warn",
        message: `TypeScript configuration invalid: ${ctx.manifests.tsconfigError}`,
      });
    } else {
      issues.push({
        severity: "warn",
        message: "TypeScript files found but tsconfig.json is missing",
      });
    }
  }

  if (stats.testFiles === 0) {
    issues.push({
      severity: "warn",
      message: "No test files detected",
    });
  }

  if (!ctx.manifests.lockfile) {
    issues.push({
      severity: "warn",
      message: "No lockfile detected",
    });
  }

  const scripts = ctx.manifests.packageJson?.scripts ?? {};
  if (Object.keys(scripts).length === 0 && ctx.manifests.packageJson) {
    issues.push({
      severity: "info",
      message: "package.json has no scripts",
    });
  }

  if (stats.cycles.length > 0) {
    const sample = stats.cycles
      .slice(0, 3)
      .map((c) => c.join(" -> "))
      .join("; ");
    issues.push({
      severity: "warn",
      message: `${stats.cycles.length} circular dependencies (${sample})`,
    });
  }

  if (stats.unusedCount > 0) {
    issues.push({
      severity: "warn",
      message: `${stats.unusedCount} unused exports`,
    });
  }

  if (stats.highComplexityFiles > 0) {
    issues.push({
      severity: "warn",
      message: `${stats.highComplexityFiles} modules exceed complexity threshold (${COMPLEXITY_THRESHOLD})`,
    });
  }

  return issues;
}
