import { describe, expect, it } from "vitest";
import { evaluateArchitectureRules } from "../../src/rules/evaluate.ts";
import { matchesGlob } from "../../src/rules/match.ts";
import { ProjectGraph } from "../../src/graph/graph.ts";
import { checkExitCode } from "../../src/check/runner.ts";
import type { CheckResult } from "../../src/output/types.ts";

describe("matchesGlob", () => {
  it("matches ** globs", () => {
    expect(matchesGlob("src/api/users.ts", "src/api/**")).toBe(true);
    expect(matchesGlob("src/services/x.ts", "src/api/**")).toBe(false);
    expect(matchesGlob("src/repositories/user.ts", "src/repositories/**")).toBe(
      true,
    );
  });
});

describe("evaluateArchitectureRules", () => {
  it("reports violations for forbidden edges", () => {
    const g = new ProjectGraph();
    g.addNode("src/api/users.ts", "src/api/users.ts");
    g.addNode("src/repositories/user.ts", "src/repositories/user.ts");
    g.addEdge("src/api/users.ts", "src/repositories/user.ts");

    const violations = evaluateArchitectureRules(g, [
      {
        name: "api-cannot-import-database",
        from: "src/api/**",
        cannotImport: ["src/repositories/**"],
      },
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.from).toBe("src/api/users.ts");
    expect(violations[0]?.to).toBe("src/repositories/user.ts");
  });

  it("returns empty when compliant", () => {
    const g = new ProjectGraph();
    g.addNode("src/api/users.ts", "src/api/users.ts");
    g.addNode("src/services/user.ts", "src/services/user.ts");
    g.addEdge("src/api/users.ts", "src/services/user.ts");

    const violations = evaluateArchitectureRules(g, [
      {
        name: "api-cannot-import-database",
        from: "src/api/**",
        cannotImport: ["src/repositories/**"],
      },
    ]);

    expect(violations).toHaveLength(0);
  });
});

describe("checkExitCode", () => {
  it("maps passed flag to exit code", () => {
    const failed: CheckResult = {
      passed: false,
      architecture: { rulesEvaluated: 1, violations: [] },
      scripts: [],
      summary: { violations: 0, scriptFailures: 1 },
    };
    expect(checkExitCode(failed)).toBe(1);
    expect(checkExitCode({ ...failed, passed: true, summary: { violations: 0, scriptFailures: 0 } })).toBe(0);
  });
});
