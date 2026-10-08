import type { ProjectGraph } from "../graph/graph.ts";
import { isSourceFile, isTestFile } from "../scanner/scan-files.ts";
import { extname } from "node:path";
import { normalize } from "./walk.ts";

export type RiskLevel = "high" | "medium" | "low";

export interface RiskInput {
  changed: string[];
  direct: string[];
  indirect: string[];
  affectedTests: string[];
  exportedApiChanged: boolean;
  moduleExportsPublicSymbols: boolean;
  graph: ProjectGraph | null;
}

export interface RiskResult {
  risk: RiskLevel;
  reasons: string[];
}

const WORKER_PATH = /(^|\/)workers\//;

export function computeRisk(input: RiskInput): RiskResult {
  const reasons: string[] = [];
  const dependentsTotal = input.direct.length + input.indirect.length;
  const changedSource = input.changed.filter((p) => {
    const ext = extname(p);
    return isSourceFile(ext) && !isTestFile(p);
  });

  if (input.exportedApiChanged) {
    reasons.push("exported API changed");
  } else if (input.moduleExportsPublicSymbols && changedSource.length > 0) {
    reasons.push("module exports public symbols");
  }

  if (dependentsTotal > 0) {
    reasons.push(
      `${dependentsTotal} dependent module${dependentsTotal === 1 ? "" : "s"}`,
    );
  }

  const workerCount = countWorkerDependents(input, input.graph);
  if (workerCount > 0) {
    reasons.push(
      `shared by ${workerCount} worker${workerCount === 1 ? "" : "s"}`,
    );
  }

  if (input.affectedTests.length > 0) {
    reasons.push(
      `${input.affectedTests.length} potentially affected test${input.affectedTests.length === 1 ? "" : "s"}`,
    );
  }

  let risk: RiskLevel = "low";

  const highFanoutWithExports =
    dependentsTotal >= 5 &&
    (input.exportedApiChanged || input.moduleExportsPublicSymbols);

  if (
    dependentsTotal >= 10 ||
    input.exportedApiChanged ||
    (workerCount > 0 && dependentsTotal >= 1) ||
    highFanoutWithExports
  ) {
    risk = "high";
  } else if (dependentsTotal >= 1 || changedSource.length > 0) {
    risk = "medium";
  } else {
    risk = "low";
    if (reasons.length === 0) {
      reasons.push("no source-module dependents detected");
    }
  }

  return { risk, reasons };
}

function countWorkerDependents(
  input: RiskInput,
  graph: ProjectGraph | null,
): number {
  const all = [...input.direct, ...input.indirect, ...input.changed].map(normalize);
  const workers = new Set<string>();
  for (const path of all) {
    if (WORKER_PATH.test(path)) workers.add(path);
  }
  if (!graph) return workers.size;

  for (const path of all) {
    for (const dep of graph.dependentsOf(path)) {
      if (WORKER_PATH.test(dep)) workers.add(dep);
    }
  }
  return workers.size;
}
