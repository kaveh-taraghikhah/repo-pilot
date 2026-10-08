import { describe, expect, it } from "vitest";
import { parseNameStatus } from "../../src/git/diff.ts";
import { bandFor, scoreChangedFiles } from "../../src/git/impact-score.ts";
import { parsePorcelain } from "../../src/git/status.ts";
import { ProjectGraph } from "../../src/graph/graph.ts";

describe("parsePorcelain", () => {
  it("parses modified, added, and untracked files", () => {
    const files = parsePorcelain(` M src/a.ts
A  src/b.ts
?? src/c.ts
`);
    expect(files).toEqual([
      { path: "src/a.ts", status: "M" },
      { path: "src/b.ts", status: "A" },
      { path: "src/c.ts", status: "?" },
    ]);
  });

  it("parses rename lines", () => {
    const files = parsePorcelain(`R  src/old.ts -> src/new.ts\n`);
    expect(files).toEqual([
      { path: "src/old.ts", status: "D" },
      { path: "src/new.ts", status: "R" },
    ]);
  });

  it("does not treat copy source as deleted", () => {
    const files = parsePorcelain(`C  src/a.ts\tsrc/b.ts\n`);
    expect(files).toEqual([{ path: "src/b.ts", status: "C" }]);
  });

  it("decodes C-style quoted porcelain paths", () => {
    // é.ts → \303\251 in git's default quotepath encoding
    const files = parsePorcelain(` M "src/\\303\\251.ts"\n`);
    expect(files).toEqual([{ path: "src/é.ts", status: "M" }]);
  });
});

describe("parseNameStatus", () => {
  it("parses name-status diff lines", () => {
    const files = parseNameStatus(`M\tsrc/a.ts
A\tsrc/b.ts
D\tsrc/c.ts
R100\tsrc/old.ts\tsrc/new.ts
C50\tsrc/a.ts\tsrc/a-copy.ts
`);
    expect(files).toEqual([
      { path: "src/a.ts", status: "M" },
      { path: "src/b.ts", status: "A" },
      { path: "src/c.ts", status: "D" },
      { path: "src/old.ts", status: "D" },
      { path: "src/new.ts", status: "R" },
      { path: "src/a-copy.ts", status: "C" },
    ]);
  });

  it("decodes C-style quoted name-status paths", () => {
    const files = parseNameStatus(`M\t"src/\\303\\251.ts"\n`);
    expect(files).toEqual([{ path: "src/é.ts", status: "M" }]);
  });
});

describe("impact scoring", () => {
  it("bands by dependents and path heuristics", () => {
    const graph = new ProjectGraph();
    graph.addNode("src/services/payment.ts", "src/services/payment.ts");
    graph.addNode("src/order.ts", "src/order.ts");
    graph.addNode("src/a.ts", "src/a.ts");
    graph.addNode("src/b.ts", "src/b.ts");
    graph.addNode("src/c.ts", "src/c.ts");
    graph.addNode("src/d.ts", "src/d.ts");
    graph.addNode("src/e.ts", "src/e.ts");
    for (const dep of ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"]) {
      graph.addEdge(dep, "src/services/payment.ts");
    }
    graph.addEdge("src/order.ts", "src/services/payment.ts");

    expect(bandFor("README.md", 0)).toBe("low");
    expect(bandFor("src/foo.test.ts", 3)).toBe("low");
    expect(bandFor("bun.lock", 0)).toBe("low");
    expect(bandFor("src/lonely.ts", 0)).toBe("medium");
    expect(bandFor("src/utils/math.ts", 2)).toBe("medium");
    expect(bandFor("src/services/payment.ts", 1)).toBe("high");
    expect(bandFor("src/api/users.ts", 1)).toBe("high");
    expect(bandFor("src/utils/math.ts", 5)).toBe("high");
    expect(bandFor("assets/logo.png", 0)).toBe("low");

    const scored = scoreChangedFiles(
      [
        { path: "src/services/payment.ts", status: "M" },
        { path: "README.md", status: "M" },
        { path: "src/foo.test.ts", status: "M" },
        { path: "src/lonely.ts", status: "M" },
      ],
      graph,
    );

    expect(scored.find((f) => f.path === "src/services/payment.ts")?.impact).toBe(
      "high",
    );
    expect(scored.find((f) => f.path === "README.md")?.impact).toBe("low");
    expect(scored.find((f) => f.path === "src/foo.test.ts")?.impact).toBe("low");
    expect(scored.find((f) => f.path === "src/lonely.ts")?.impact).toBe("medium");
    expect(
      scored.find((f) => f.path === "src/services/payment.ts")?.dependents,
    ).toBe(6);
  });

  it("treats source leaves as medium even with zero graph dependents", () => {
    // Leaf modules can still break callers via aliases / dynamic imports /
    // files outside the scanned graph — never collapse them to "low".
    expect(bandFor("src/orphan.ts", 0)).toBe("medium");
    expect(bandFor("src/orphan.tsx", 0)).toBe("medium");
    expect(bandFor("lib/helper.mts", 0)).toBe("medium");
  });
});
