import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProjectGraph } from "../../src/analyzer/load-graph.ts";
import { diffTouchesExports } from "../../src/impact/exports-changed.ts";
import { findImportersOfMissingSeed, runImpact } from "../../src/impact/engine.ts";
import { computeRisk } from "../../src/impact/risk.ts";
import { buildSuggestedValidation } from "../../src/impact/validation.ts";
import { collectDependents } from "../../src/impact/walk.ts";
import { ProjectGraph } from "../../src/graph/graph.ts";
import { scanFiles } from "../../src/scanner/scan-files.ts";
import { makeParsed } from "../helpers/parse-fixture.ts";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("collectDependents", () => {
  it("separates direct and indirect dependents", () => {
    const g = new ProjectGraph();
    g.addNode("payment.ts", "payment.ts");
    g.addNode("order.ts", "order.ts");
    g.addNode("api.ts", "api.ts");
    g.addEdge("order.ts", "payment.ts");
    g.addEdge("api.ts", "order.ts");

    const result = collectDependents(g, ["payment.ts"]);
    expect(result.direct).toEqual(["order.ts"]);
    expect(result.indirect).toEqual(["api.ts"]);
  });
});

describe("findImportersOfMissingSeed", () => {
  it("finds unresolved relative imports of a deleted module", () => {
    const parsed = makeParsed([
      { file: "src/order.ts", imports: [{ specifier: "./payment", resolvedPath: null }] },
    ]);

    expect(findImportersOfMissingSeed(parsed, "src/payment.ts")).toEqual([
      "src/order.ts",
    ]);
  });

  it("finds # subpath importers of a deleted module", () => {
    const parsed = makeParsed([
      { file: "src/order.ts", imports: [{ specifier: "#/payment", resolvedPath: null }] },
    ], { compilerOptions: { baseUrl: ".", paths: { "#/*": ["src/*"] } } });

    expect(findImportersOfMissingSeed(parsed, "src/payment.ts")).toEqual([
      "src/order.ts",
    ]);
  });

  it("stem-matches resolvedPath when extensions differ", () => {
    const parsed = makeParsed([
      { file: "src/order.ts", imports: [{ specifier: "./payment", resolvedPath: "src/payment.js" }] },
    ]);

    expect(findImportersOfMissingSeed(parsed, "src/payment.ts")).toEqual([
      "src/order.ts",
    ]);
  });

  it("does not stem-match a live sibling module", () => {
    const parsed = makeParsed([
      { file: "src/order.ts", imports: [{ specifier: "./payment", resolvedPath: "src/payment.tsx" }] },
      { file: "src/payment.tsx" },
    ]);

    expect(findImportersOfMissingSeed(parsed, "src/payment.ts")).toEqual([]);
  });

  it("does not trust stale exact resolvedPath when a live sibling exists", () => {
    const parsed = makeParsed([
      { file: "src/order.ts", imports: [{ specifier: "./payment", resolvedPath: "src/payment.ts" }] },
      { file: "src/payment.tsx" },
    ]);

    expect(findImportersOfMissingSeed(parsed, "src/payment.ts")).toEqual([]);
  });

  it("does not recover when a live index module exists under the stem", () => {
    const parsed = makeParsed([
      { file: "src/order.ts", imports: [{ specifier: "./foo", resolvedPath: null }] },
      { file: "src/foo/index.ts" },
    ]);

    expect(findImportersOfMissingSeed(parsed, "src/foo.ts")).toEqual([]);
  });

  it("does not recover deleted index when a live file sibling exists", () => {
    const parsed = makeParsed([
      { file: "src/order.ts", imports: [{ specifier: "./foo", resolvedPath: null }] },
      { file: "src/foo.ts" },
    ]);

    expect(findImportersOfMissingSeed(parsed, "src/foo/index.ts")).toEqual([]);
  });

  it("does not stem-match stale .js when a live sibling exists", () => {
    const parsed = makeParsed([
      { file: "src/order.ts", imports: [{ specifier: "./payment", resolvedPath: "src/payment.js" }] },
      { file: "src/payment.tsx" },
    ]);

    expect(findImportersOfMissingSeed(parsed, "src/payment.ts")).toEqual([]);
  });

  it("does not exact-match unresolved relatives when a live sibling exists", () => {
    const parsed = makeParsed([
      { file: "src/order.ts", imports: [{ specifier: "./payment", resolvedPath: null }] },
      { file: "src/payment.tsx" },
    ]);

    expect(findImportersOfMissingSeed(parsed, "src/payment.ts")).toEqual([]);
  });

  it("recovers explicit-extension relatives even when a live sibling exists", () => {
    const parsed = makeParsed([
      { file: "src/order.ts", imports: [{ specifier: "./payment.ts", resolvedPath: null }] },
      { file: "src/payment.tsx" },
    ]);

    expect(findImportersOfMissingSeed(parsed, "src/payment.ts")).toEqual([
      "src/order.ts",
    ]);
  });

  it("recovers TS ESM ./x.js imports of deleted x.ts", () => {
    const parsed = makeParsed([
      { file: "src/order.ts", imports: [{ specifier: "./payment.js", resolvedPath: null }] },
    ]);

    expect(findImportersOfMissingSeed(parsed, "src/payment.ts")).toEqual([
      "src/order.ts",
    ]);
  });

  it("recovers NodeNext ./x.js imports of a deleted .ts seed even when a twin lives", () => {
    const parsed = makeParsed([
      { file: "src/order.ts", imports: [{ specifier: "./payment.js", resolvedPath: null }] },
      { file: "src/payment.tsx" },
    ]);

    expect(findImportersOfMissingSeed(parsed, "src/payment.ts")).toEqual([
      "src/order.ts",
    ]);
  });

  it("does not recover NodeNext ./x.js for deleted .tsx when .ts twin lives", () => {
    const parsed = makeParsed([
      { file: "src/order.ts", imports: [{ specifier: "./payment.js", resolvedPath: null }] },
      { file: "src/payment.ts" },
    ]);

    expect(findImportersOfMissingSeed(parsed, "src/payment.tsx")).toEqual([]);
  });

  it("does not recover ./x.js imports for a deleted .mts seed (wrong emit family)", () => {
    const parsed = makeParsed([
      { file: "src/order.ts", imports: [{ specifier: "./payment.js", resolvedPath: null }] },
    ]);

    expect(findImportersOfMissingSeed(parsed, "src/payment.mts")).toEqual([]);
  });

  it("does not recover ./x.mjs imports for a deleted .ts seed (wrong emit family)", () => {
    const parsed = makeParsed([
      { file: "src/order.ts", imports: [{ specifier: "./payment.mjs", resolvedPath: null }] },
      { file: "src/payment.tsx" },
    ]);

    expect(findImportersOfMissingSeed(parsed, "src/payment.ts")).toEqual([]);
  });

  it("recovers ./x.mjs imports of a deleted .mts seed even when a .tsx twin lives", () => {
    const parsed = makeParsed([
      { file: "src/order.ts", imports: [{ specifier: "./payment.mjs", resolvedPath: null }] },
      { file: "src/payment.tsx" },
    ]);

    expect(findImportersOfMissingSeed(parsed, "src/payment.mts")).toEqual([
      "src/order.ts",
    ]);
  });

  it("recovers ./x.cjs imports of a deleted .cts seed", () => {
    const parsed = makeParsed([
      { file: "src/order.ts", imports: [{ specifier: "./payment.cjs", resolvedPath: null }] },
    ]);

    expect(findImportersOfMissingSeed(parsed, "src/payment.cts")).toEqual([
      "src/order.ts",
    ]);
  });

  it("recovers ./x.js for deleted .tsx when only an unrelated .mts sibling lives", () => {
    const parsed = makeParsed([
      { file: "src/order.ts", imports: [{ specifier: "./payment.js", resolvedPath: null }] },
      { file: "src/payment.mts" },
    ]);

    expect(findImportersOfMissingSeed(parsed, "src/payment.tsx")).toEqual([
      "src/order.ts",
    ]);
  });

  it("recovers ./x.js for deleted .tsx when only an index sibling lives", () => {
    const parsed = makeParsed([
      { file: "src/order.ts", imports: [{ specifier: "./foo.js", resolvedPath: null }] },
      { file: "src/foo/index.ts" },
    ]);

    expect(findImportersOfMissingSeed(parsed, "src/foo.tsx")).toEqual([
      "src/order.ts",
    ]);
    expect(findImportersOfMissingSeed(parsed, "src/foo.ts")).toEqual([
      "src/order.ts",
    ]);
  });

  it("still prefers live .ts over deleted .tsx for ./x.js despite other siblings", () => {
    const parsed = makeParsed([
      { file: "src/order.ts", imports: [{ specifier: "./payment.js", resolvedPath: null }] },
      { file: "src/payment.ts" },
      { file: "src/payment.mts" },
    ]);

    expect(findImportersOfMissingSeed(parsed, "src/payment.tsx")).toEqual([]);
  });

  it("does not treat cross-ext candidate expansion as explicit exact", () => {
    const parsed = makeParsed([
      { file: "src/order.ts", imports: [{ specifier: "./payment.tsx", resolvedPath: null }] },
      { file: "src/payment.tsx" },
    ]);

    // Specifier names the live sibling, not the deleted seed.
    expect(findImportersOfMissingSeed(parsed, "src/payment.ts")).toEqual([]);
  });

  it("does not map explicit ./foo.ts to deleted foo/index.ts via candidates", () => {
    const parsed = makeParsed([
      { file: "src/order.ts", imports: [{ specifier: "./foo.ts", resolvedPath: null }] },
    ]);

    expect(findImportersOfMissingSeed(parsed, "src/foo/index.ts")).toEqual([]);
  });

  it("canonicalizes relative unresolved joins through dir symlinks", () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-impact-sym-"));
    temps.push(dir);
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "other"), { recursive: true });
    try {
      symlinkSync(join(dir, "src"), join(dir, "alias"));
    } catch {
      return;
    }

    const parsed = makeParsed([
      { file: "other/order.ts", imports: [{ specifier: "../alias/payment", resolvedPath: null }] },
    ], { root: dir });

    // Seed is canonical realpath form; importer used symlink-relative path.
    expect(findImportersOfMissingSeed(parsed, "src/payment.ts")).toEqual([
      "other/order.ts",
    ]);
    expect(findImportersOfMissingSeed(parsed, "alias/payment.ts")).toEqual([
      "other/order.ts",
    ]);
  });

  it("recovers importers from allowlist-skipped program modules", async () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-impact-skip-"));
    temps.push(dir);
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "ignored"), { recursive: true });
    writeFileSync(join(dir, "src", "entry.ts"), `import "../ignored/bridge";\n`);
    writeFileSync(
      join(dir, "ignored", "bridge.ts"),
      `import { x } from "../src/gone";\nexport const v = x;\n`,
    );
    // gone.ts intentionally absent (deleted seed)
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { module: "ESNext", moduleResolution: "bundler", noEmit: true },
        include: ["src/**/*", "ignored/**/*"],
      }),
    );
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "impact-skip",
        repopilot: { ignore: ["ignored"] },
      }),
    );
    writeFileSync(
      join(dir, ".repopilot.json"),
      JSON.stringify({ ignore: ["ignored"] }),
    );

    const scan = await scanFiles(dir, ["ignored"]);
    const { parsed } = await loadProjectGraph(dir, scan.files, { cache: false });
    expect(parsed.files.some((f) => f.file.includes("ignored/"))).toBe(false);

    expect(findImportersOfMissingSeed(parsed, "src/gone.ts")).toEqual([
      "ignored/bridge.ts",
    ]);

    // Skipped bridge is direct; scanned entry that imports it is indirect.
    const result = await runImpact({
      cwd: dir,
      files: ["src/gone.ts"],
      cache: false,
    });
    expect(result.directDependents).toContain("ignored/bridge.ts");
    expect(result.indirectDependents).toContain("src/entry.ts");
  });

  it("BFS-walks skipped importer chains to scanned dependents", async () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-impact-chain-"));
    temps.push(dir);
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "ignored"), { recursive: true });
    writeFileSync(join(dir, "src", "entry.ts"), `import "../ignored/mid";\n`);
    writeFileSync(
      join(dir, "ignored", "mid.ts"),
      `import "../ignored/bridge";\nexport {};\n`,
    );
    writeFileSync(
      join(dir, "ignored", "bridge.ts"),
      `import { x } from "../src/gone";\nexport const v = x;\n`,
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { module: "ESNext", moduleResolution: "bundler", noEmit: true },
        include: ["src/**/*", "ignored/**/*"],
      }),
    );
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "impact-chain" }),
    );
    writeFileSync(
      join(dir, ".repopilot.json"),
      JSON.stringify({ ignore: ["ignored"] }),
    );

    const result = await runImpact({
      cwd: dir,
      files: ["src/gone.ts"],
      cache: false,
    });
    expect(result.directDependents).toContain("ignored/bridge.ts");
    expect(result.indirectDependents).toEqual(
      expect.arrayContaining(["ignored/mid.ts", "src/entry.ts"]),
    );
  });

  it("records tests that only reach deleted seeds via skipped bridges", async () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-impact-test-skip-"));
    temps.push(dir);
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "ignored"), { recursive: true });
    writeFileSync(
      join(dir, "src", "gone.test.ts"),
      `import { v } from "../ignored/bridge";\nexport const t = v;\n`,
    );
    writeFileSync(
      join(dir, "ignored", "bridge.ts"),
      `import { x } from "../src/gone";\nexport const v = x;\n`,
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { module: "ESNext", moduleResolution: "bundler", noEmit: true },
        include: ["src/**/*", "ignored/**/*"],
      }),
    );
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "impact-test-skip" }),
    );
    writeFileSync(
      join(dir, ".repopilot.json"),
      JSON.stringify({ ignore: ["ignored"] }),
    );

    const result = await runImpact({
      cwd: dir,
      files: ["src/gone.ts"],
      cache: false,
    });
    expect(result.directDependents).toContain("ignored/bridge.ts");
    expect(result.affectedTests).toContain("src/gone.test.ts");
  });

  it("walks transitive non-test dependents through recovered test importers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-impact-test-bridge-"));
    temps.push(dir);
    mkdirSync(join(dir, "src", "__tests__"), { recursive: true });
    writeFileSync(
      join(dir, "src", "__tests__", "helper.ts"),
      `import { x } from "../gone";\nexport const h = x;\n`,
    );
    writeFileSync(
      join(dir, "src", "entry.ts"),
      `import { h } from "./__tests__/helper";\nexport const e = h;\n`,
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { module: "ESNext", moduleResolution: "bundler", noEmit: true },
        include: ["src/**/*"],
      }),
    );
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "impact-test-bridge" }),
    );

    const result = await runImpact({
      cwd: dir,
      files: ["src/gone.ts"],
      cache: false,
    });
    expect(result.affectedTests).toContain("src/__tests__/helper.ts");
    expect(result.directDependents).not.toContain("src/__tests__/helper.ts");
    expect(result.indirectDependents).toContain("src/entry.ts");
  });

  it("BFS hops follow unresolved relative imports into skipped modules", async () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-impact-unres-"));
    temps.push(dir);
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "ignored"), { recursive: true });
    // entry imports mid with a path that may fail compiler resolve if mid is
    // only reachable as an unresolved relative from another skipped file.
    writeFileSync(join(dir, "src", "entry.ts"), `import "../ignored/mid";\n`);
    writeFileSync(
      join(dir, "ignored", "mid.ts"),
      // Extensionless relative — exercises unresolved/alias-style hop matching
      `import "./bridge";\nexport {};\n`,
    );
    writeFileSync(
      join(dir, "ignored", "bridge.ts"),
      `import { x } from "../src/gone";\nexport const v = x;\n`,
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { module: "ESNext", moduleResolution: "bundler", noEmit: true },
        include: ["src/**/*", "ignored/**/*"],
      }),
    );
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "impact-unres" }),
    );
    writeFileSync(
      join(dir, ".repopilot.json"),
      JSON.stringify({ ignore: ["ignored"] }),
    );

    const result = await runImpact({
      cwd: dir,
      files: ["src/gone.ts"],
      cache: false,
    });
    expect(result.indirectDependents).toEqual(
      expect.arrayContaining(["ignored/mid.ts", "src/entry.ts"]),
    );
  });

  it("finds skipped dependents above in-graph bridges", async () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-impact-above-"));
    temps.push(dir);
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "ignored"), { recursive: true });
    // ignored/outer → src/mid → ignored/bridge → gone
    writeFileSync(
      join(dir, "ignored", "outer.ts"),
      `import "../src/mid";\nexport {};\n`,
    );
    writeFileSync(
      join(dir, "src", "mid.ts"),
      `import "../ignored/bridge";\nexport {};\n`,
    );
    writeFileSync(
      join(dir, "ignored", "bridge.ts"),
      `import { x } from "../src/gone";\nexport const v = x;\n`,
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { module: "ESNext", moduleResolution: "bundler", noEmit: true },
        include: ["src/**/*", "ignored/**/*"],
      }),
    );
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "impact-above" }),
    );
    writeFileSync(
      join(dir, ".repopilot.json"),
      JSON.stringify({ ignore: ["ignored"] }),
    );

    const result = await runImpact({
      cwd: dir,
      files: ["src/gone.ts"],
      cache: false,
    });
    expect(result.directDependents).toContain("ignored/bridge.ts");
    expect(result.indirectDependents).toEqual(
      expect.arrayContaining(["src/mid.ts", "ignored/outer.ts"]),
    );
  });

  it("finds skipped dependents above in-graph recovered importers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-impact-above-direct-"));
    temps.push(dir);
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "ignored"), { recursive: true });
    // ignored/outer → src/mid → gone (mid is in-graph recovered direct)
    writeFileSync(
      join(dir, "ignored", "outer.ts"),
      `import "../src/mid";\nexport {};\n`,
    );
    writeFileSync(
      join(dir, "src", "mid.ts"),
      `import { x } from "./gone";\nexport const v = x;\n`,
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { module: "ESNext", moduleResolution: "bundler", noEmit: true },
        include: ["src/**/*", "ignored/**/*"],
      }),
    );
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "impact-above-direct" }),
    );
    writeFileSync(
      join(dir, ".repopilot.json"),
      JSON.stringify({ ignore: ["ignored"] }),
    );

    const result = await runImpact({
      cwd: dir,
      files: ["src/gone.ts"],
      cache: false,
    });
    expect(result.directDependents).toContain("src/mid.ts");
    expect(result.indirectDependents).toContain("ignored/outer.ts");
  });

  it("finds skipped dependents above a multi-hop in-graph cone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-impact-above-hop-"));
    temps.push(dir);
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "ignored"), { recursive: true });
    // ignored/outer → src/a → src/mid → gone
    writeFileSync(
      join(dir, "ignored", "outer.ts"),
      `import "../src/a";\nexport {};\n`,
    );
    writeFileSync(join(dir, "src", "a.ts"), `import "./mid";\nexport {};\n`);
    writeFileSync(
      join(dir, "src", "mid.ts"),
      `import { x } from "./gone";\nexport const v = x;\n`,
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { module: "ESNext", moduleResolution: "bundler", noEmit: true },
        include: ["src/**/*", "ignored/**/*"],
      }),
    );
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "impact-above-hop" }),
    );
    writeFileSync(
      join(dir, ".repopilot.json"),
      JSON.stringify({ ignore: ["ignored"] }),
    );

    const result = await runImpact({
      cwd: dir,
      files: ["src/gone.ts"],
      cache: false,
    });
    expect(result.directDependents).toContain("src/mid.ts");
    expect(result.indirectDependents).toEqual(
      expect.arrayContaining(["src/a.ts", "ignored/outer.ts"]),
    );
  });

  it("fixpoint-peeks skipped dependents across alternating ignore/src hops", async () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-impact-l3-"));
    temps.push(dir);
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "ignored"), { recursive: true });
    // L3 → top → L2 → mid → bridge → gone
    writeFileSync(
      join(dir, "ignored", "L3.ts"),
      `import "../src/top";\nexport {};\n`,
    );
    writeFileSync(
      join(dir, "src", "top.ts"),
      `import "../ignored/L2";\nexport {};\n`,
    );
    writeFileSync(
      join(dir, "ignored", "L2.ts"),
      `import "../src/mid";\nexport {};\n`,
    );
    writeFileSync(
      join(dir, "src", "mid.ts"),
      `import "../ignored/bridge";\nexport {};\n`,
    );
    writeFileSync(
      join(dir, "ignored", "bridge.ts"),
      `import { x } from "../src/gone";\nexport const v = x;\n`,
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { module: "ESNext", moduleResolution: "bundler", noEmit: true },
        include: ["src/**/*", "ignored/**/*"],
      }),
    );
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "impact-l3" }));
    writeFileSync(
      join(dir, ".repopilot.json"),
      JSON.stringify({ ignore: ["ignored"] }),
    );

    const result = await runImpact({
      cwd: dir,
      files: ["src/gone.ts"],
      cache: false,
    });
    expect(result.directDependents).toContain("ignored/bridge.ts");
    expect(result.indirectDependents).toEqual(
      expect.arrayContaining([
        "src/mid.ts",
        "ignored/L2.ts",
        "src/top.ts",
        "ignored/L3.ts",
      ]),
    );
  });

  it("finds skipped dependents above live modified graph seeds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-impact-live-outer-"));
    temps.push(dir);
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "ignored"), { recursive: true });
    writeFileSync(
      join(dir, "ignored", "outer.ts"),
      `import "../src/a";\nexport {};\n`,
    );
    writeFileSync(
      join(dir, "src", "a.ts"),
      `import "./payment";\nexport {};\n`,
    );
    writeFileSync(join(dir, "src", "payment.ts"), `export const p = 1;\n`);
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { module: "ESNext", moduleResolution: "bundler", noEmit: true },
        include: ["src/**/*", "ignored/**/*"],
      }),
    );
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "impact-live-outer" }),
    );
    writeFileSync(
      join(dir, ".repopilot.json"),
      JSON.stringify({ ignore: ["ignored"] }),
    );

    const result = await runImpact({
      cwd: dir,
      files: ["src/payment.ts"],
      cache: false,
    });
    expect(result.directDependents).toContain("src/a.ts");
    expect(result.indirectDependents).toContain("ignored/outer.ts");
  });

  it("classifies skipped direct importers of live seeds as directDependents", async () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-impact-live-direct-"));
    temps.push(dir);
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "ignored"), { recursive: true });
    writeFileSync(
      join(dir, "ignored", "bridge.ts"),
      `import { p } from "../src/payment";\nexport const v = p;\n`,
    );
    writeFileSync(join(dir, "src", "payment.ts"), `export const p = 1;\n`);
    writeFileSync(
      join(dir, "src", "entry.ts"),
      `import "../ignored/bridge";\nexport {};\n`,
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { module: "ESNext", moduleResolution: "bundler", noEmit: true },
        include: ["src/**/*", "ignored/**/*"],
      }),
    );
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "impact-live-direct" }),
    );
    writeFileSync(
      join(dir, ".repopilot.json"),
      JSON.stringify({ ignore: ["ignored"] }),
    );

    const result = await runImpact({
      cwd: dir,
      files: ["src/payment.ts"],
      cache: false,
    });
    expect(result.directDependents).toContain("ignored/bridge.ts");
    expect(result.indirectDependents).toContain("src/entry.ts");
    expect(result.directDependents).not.toContain("src/entry.ts");
  });

  it("keeps ignored importers of a live seed when an index twin exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-impact-live-twin-"));
    temps.push(dir);
    mkdirSync(join(dir, "src", "foo"), { recursive: true });
    mkdirSync(join(dir, "ignored"), { recursive: true });
    writeFileSync(join(dir, "src", "foo.ts"), `export const x = 1;\n`);
    writeFileSync(join(dir, "src", "foo", "index.ts"), `export const y = 2;\n`);
    writeFileSync(
      join(dir, "ignored", "bridge.ts"),
      `import { x } from "../src/foo";\nexport const v = x;\n`,
    );
    writeFileSync(
      join(dir, "src", "direct.ts"),
      `import { x } from "./foo";\nexport const d = x;\n`,
    );
    writeFileSync(
      join(dir, "src", "entry.ts"),
      `import "../ignored/bridge";\nexport {};\n`,
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { module: "ESNext", moduleResolution: "bundler", noEmit: true },
        include: ["src/**/*", "ignored/**/*"],
      }),
    );
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "impact-live-twin" }),
    );
    writeFileSync(
      join(dir, ".repopilot.json"),
      JSON.stringify({ ignore: ["ignored"] }),
    );

    const result = await runImpact({
      cwd: dir,
      files: ["src/foo.ts"],
      cache: false,
    });
    expect(result.directDependents).toEqual(
      expect.arrayContaining(["src/direct.ts", "ignored/bridge.ts"]),
    );
    expect(result.indirectDependents).toContain("src/entry.ts");
  });

  it("does not attribute ignored importers of an extension twin to a live seed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-impact-live-ext-twin-"));
    temps.push(dir);
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "ignored"), { recursive: true });
    writeFileSync(join(dir, "src", "foo.ts"), `export const a = 1;\n`);
    writeFileSync(join(dir, "src", "foo.tsx"), `export const b = 2;\n`);
    writeFileSync(
      join(dir, "ignored", "uses-tsx.ts"),
      `import { b } from "../src/foo.tsx";\nexport const x = b;\n`,
    );
    writeFileSync(
      join(dir, "src", "entry.ts"),
      `import "../ignored/uses-tsx";\nexport {};\n`,
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          module: "ESNext",
          moduleResolution: "bundler",
          jsx: "react-jsx",
          noEmit: true,
        },
        include: ["src/**/*", "ignored/**/*"],
      }),
    );
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "impact-live-ext-twin" }),
    );
    writeFileSync(
      join(dir, ".repopilot.json"),
      JSON.stringify({ ignore: ["ignored"] }),
    );

    const result = await runImpact({
      cwd: dir,
      files: ["src/foo.ts"],
      cache: false,
    });
    expect(result.directDependents).not.toContain("ignored/uses-tsx.ts");
    expect(result.indirectDependents).not.toContain("src/entry.ts");
  });

  it("does not attribute NodeNext ./foo.js importers to a live .tsx twin seed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-impact-live-js-tsx-"));
    temps.push(dir);
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "ignored"), { recursive: true });
    writeFileSync(join(dir, "src", "foo.ts"), `export const a = 1;\n`);
    writeFileSync(join(dir, "src", "foo.tsx"), `export const b = 2;\n`);
    writeFileSync(
      join(dir, "ignored", "uses.ts"),
      `import { a } from "../src/foo.js";\nexport const x = a;\n`,
    );
    writeFileSync(
      join(dir, "src", "entry.ts"),
      `import "../ignored/uses";\nexport {};\n`,
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          jsx: "react-jsx",
          noEmit: true,
        },
        include: ["src/**/*", "ignored/**/*"],
      }),
    );
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "impact-live-js-tsx", type: "module" }),
    );
    writeFileSync(
      join(dir, ".repopilot.json"),
      JSON.stringify({ ignore: ["ignored"] }),
    );

    const scan = await scanFiles(dir, ["ignored"]);
    const { parsed } = await loadProjectGraph(dir, scan.files, { cache: false });
    expect(findImportersOfMissingSeed(parsed, "src/foo.tsx")).toEqual([]);

    const result = await runImpact({
      cwd: dir,
      files: ["src/foo.tsx"],
      cache: false,
    });
    expect(result.directDependents).not.toContain("ignored/uses.ts");
    expect(result.indirectDependents).not.toContain("src/entry.ts");
  });

  it("does not attribute NodeNext ./foo.js to a deleted .tsx when .ts twin lives", async () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-impact-del-tsx-js-"));
    temps.push(dir);
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "ignored"), { recursive: true });
    writeFileSync(join(dir, "src", "foo.ts"), `export const a = 1;\n`);
    writeFileSync(
      join(dir, "ignored", "uses.ts"),
      `import { a } from "../src/foo.js";\nexport const x = a;\n`,
    );
    writeFileSync(
      join(dir, "src", "entry.ts"),
      `import "../ignored/uses";\nexport {};\n`,
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          jsx: "react-jsx",
          noEmit: true,
        },
        include: ["src/**/*", "ignored/**/*"],
      }),
    );
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "impact-del-tsx-js", type: "module" }),
    );
    writeFileSync(
      join(dir, ".repopilot.json"),
      JSON.stringify({ ignore: ["ignored"] }),
    );

    const scan = await scanFiles(dir, ["ignored"]);
    const { parsed } = await loadProjectGraph(dir, scan.files, { cache: false });
    expect(findImportersOfMissingSeed(parsed, "src/foo.tsx")).toEqual([]);
    expect(findImportersOfMissingSeed(parsed, "src/foo.ts")).toEqual([
      "ignored/uses.ts",
    ]);

    const result = await runImpact({
      cwd: dir,
      files: ["src/foo.tsx"],
      cache: false,
    });
    expect(result.directDependents).not.toContain("ignored/uses.ts");
    expect(result.indirectDependents).not.toContain("src/entry.ts");
  });

  it("recovers explicit ./foo.ts imports when TS remaps resolution to a live twin", async () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-impact-explicit-del-"));
    temps.push(dir);
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "foo.tsx"), `export const b = 2;\n`);
    writeFileSync(
      join(dir, "src", "stale.ts"),
      `import { a } from "./foo.ts";\nexport const x = a;\n`,
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          module: "ESNext",
          moduleResolution: "bundler",
          jsx: "react-jsx",
          noEmit: true,
        },
        include: ["src/**/*"],
      }),
    );
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "impact-explicit-del" }),
    );

    const result = await runImpact({
      cwd: dir,
      files: ["src/foo.ts"],
      cache: false,
    });
    expect(result.directDependents).toContain("src/stale.ts");
  });

  it("recovers ./foo.js imports of a deleted .ts seed when a twin remaps resolution", async () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-impact-js-ext-del-"));
    temps.push(dir);
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "foo.tsx"), `export const b = 2;\n`);
    writeFileSync(
      join(dir, "src", "stale.ts"),
      `import { a } from "./foo.js";\nexport const x = a;\n`,
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          jsx: "react-jsx",
          noEmit: true,
        },
        include: ["src/**/*"],
      }),
    );
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "impact-js-ext-del", type: "module" }),
    );

    const result = await runImpact({
      cwd: dir,
      files: ["src/foo.ts"],
      cache: false,
    });
    expect(result.directDependents).toContain("src/stale.ts");
  });

  it("recovers unresolved ./foo.mjs imports of a deleted .mts seed when a twin exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-impact-mjs-ext-del-"));
    temps.push(dir);
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "foo.tsx"), `export const b = 2;\n`);
    writeFileSync(
      join(dir, "src", "stale.ts"),
      `import { a } from "./foo.mjs";\nexport const x = a;\n`,
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          jsx: "react-jsx",
          noEmit: true,
        },
        include: ["src/**/*"],
      }),
    );
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "impact-mjs-ext-del", type: "module" }),
    );

    const result = await runImpact({
      cwd: dir,
      files: ["src/foo.mts"],
      cache: false,
    });
    expect(result.directDependents).toContain("src/stale.ts");
  });

  it("does not attribute ./foo.js importers to a deleted .mts seed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-impact-js-mts-"));
    temps.push(dir);
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "foo.tsx"), `export const b = 2;\n`);
    writeFileSync(
      join(dir, "src", "stale.ts"),
      `import { a } from "./foo.js";\nexport const x = a;\n`,
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          jsx: "react-jsx",
          noEmit: true,
        },
        include: ["src/**/*"],
      }),
    );
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "impact-js-mts", type: "module" }),
    );

    const scan = await scanFiles(dir, []);
    const { parsed } = await loadProjectGraph(dir, scan.files, { cache: false });
    expect(findImportersOfMissingSeed(parsed, "src/foo.mts")).toEqual([]);

    const result = await runImpact({
      cwd: dir,
      files: ["src/foo.mts"],
      cache: false,
    });
    expect(result.directDependents).not.toContain("src/stale.ts");
  });

  it("recovers ./foo.js for deleted .tsx when only an unrelated .mts sibling lives", async () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-impact-js-tsx-mts-"));
    temps.push(dir);
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "foo.mts"), `export const a = 1;\n`);
    writeFileSync(
      join(dir, "src", "stale.ts"),
      `import { b } from "./foo.js";\nexport const x = b;\n`,
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          jsx: "react-jsx",
          noEmit: true,
        },
        include: ["src/**/*"],
      }),
    );
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "impact-js-tsx-mts", type: "module" }),
    );

    const scan = await scanFiles(dir, []);
    const { parsed } = await loadProjectGraph(dir, scan.files, { cache: false });
    expect(findImportersOfMissingSeed(parsed, "src/foo.tsx")).toEqual([
      "src/stale.ts",
    ]);

    const result = await runImpact({
      cwd: dir,
      files: ["src/foo.tsx"],
      cache: false,
    });
    expect(result.directDependents).toContain("src/stale.ts");
  });

  it("fixpoint-peeks deep alternating ignore/src chains without a depth cap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-impact-deep-"));
    temps.push(dir);
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "ignored"), { recursive: true });
    // Build: ignored/L{n} → src/n → … → ignored/L0 → src/gone
    // Depth past the old fixed maxRounds budget (~40) without making CI too slow.
    const hops = 42;
    writeFileSync(
      join(dir, "ignored", "L0.ts"),
      `import { x } from "../src/gone";\nexport const v = x;\n`,
    );
    for (let i = 0; i < hops; i++) {
      writeFileSync(
        join(dir, "src", `n${i}.ts`),
        `import "../ignored/L${i}";\nexport {};\n`,
      );
      writeFileSync(
        join(dir, "ignored", `L${i + 1}.ts`),
        `import "../src/n${i}";\nexport {};\n`,
      );
    }
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { module: "ESNext", moduleResolution: "bundler", noEmit: true },
        include: ["src/**/*", "ignored/**/*"],
      }),
    );
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "impact-deep" }));
    writeFileSync(
      join(dir, ".repopilot.json"),
      JSON.stringify({ ignore: ["ignored"] }),
    );

    const result = await runImpact({
      cwd: dir,
      files: ["src/gone.ts"],
      cache: false,
    });
    expect(result.directDependents).toContain("ignored/L0.ts");
    expect(result.indirectDependents).toContain(`ignored/L${hops}.ts`);
    expect(result.indirectDependents).toContain(`src/n${hops - 1}.ts`);
  });

  it("rejects file args that escape the project root", async () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-impact-escape-"));
    temps.push(dir);
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { module: "ESNext", moduleResolution: "bundler", noEmit: true },
        include: ["src/**/*"],
      }),
    );
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "impact-escape" }));

    await expect(
      runImpact({
        cwd: dir,
        files: ["../outside.ts", "/etc/passwd"],
        cache: false,
      }),
    ).rejects.toThrow(/No valid project files/);
  });

  it("resolves file args relative to cwd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-impact-cwd-"));
    temps.push(dir);
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "payment.ts"), `export const p = 1;\n`);
    writeFileSync(
      join(dir, "src", "order.ts"),
      `import { p } from "./payment";\nexport const o = p;\n`,
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { module: "ESNext", moduleResolution: "bundler", noEmit: true },
        include: ["src/**/*"],
      }),
    );
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "impact-cwd" }));

    const result = await runImpact({
      cwd: join(dir, "src"),
      files: ["payment.ts"],
      cache: false,
    });
    expect(result.changed).toEqual(["src/payment.ts"]);
    expect(result.directDependents).toEqual(["src/order.ts"]);
  });

  it("does not recover # importers when a live sibling exists", () => {
    const parsed = makeParsed([
      { file: "src/order.ts", imports: [{ specifier: "#/payment", resolvedPath: null }] },
      { file: "src/payment.tsx" },
    ], { compilerOptions: { baseUrl: ".", paths: { "#/*": ["src/*"] } } });

    expect(findImportersOfMissingSeed(parsed, "src/payment.ts")).toEqual([]);
  });

  it("does not recover ignored-path seeds when a live ignored sibling exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-impact-ignored-sib-"));
    temps.push(dir);
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "ignored"), { recursive: true });
    writeFileSync(
      join(dir, "src", "order.ts"),
      `import { x } from "../ignored/foo";\nexport const o = x;\n`,
    );
    writeFileSync(join(dir, "ignored", "foo.tsx"), `export const x = 1;\n`);
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { module: "ESNext", moduleResolution: "bundler", noEmit: true },
        include: ["src/**/*", "ignored/**/*"],
      }),
    );
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "ignored-sib" }));
    writeFileSync(
      join(dir, ".repopilot.json"),
      JSON.stringify({ ignore: ["ignored"] }),
    );

    const result = await runImpact({
      cwd: dir,
      files: ["ignored/foo.ts"],
      cache: false,
    });
    expect(result.directDependents).not.toContain("src/order.ts");
  });

  it("rejects invalid --since refs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-impact-since-"));
    temps.push(dir);
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { module: "ESNext", moduleResolution: "bundler", noEmit: true },
        include: ["src/**/*"],
      }),
    );
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "since-bad" }));

    // Initialize a git repo so --since validation runs
    const { spawnSync } = await import("node:child_process");
    spawnSync("git", ["init"], { cwd: dir, encoding: "utf8" });
    spawnSync("git", ["add", "."], { cwd: dir, encoding: "utf8" });
    spawnSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"],
      { cwd: dir, encoding: "utf8" },
    );

    await expect(
      runImpact({
        cwd: dir,
        files: ["src/a.ts"],
        since: "definitely-not-a-ref-zz",
        cache: false,
      }),
    ).rejects.toThrow(/Invalid --since/);
  });
});

describe("deleted-seed transitive dependents", () => {
  it("marks recovered importers as direct and their dependents as indirect", () => {
    const g = new ProjectGraph();
    g.addNode("order.ts", "order.ts");
    g.addNode("api.ts", "api.ts");
    g.addEdge("api.ts", "order.ts");

    // Simulate: payment deleted; order recovered as direct importer
    const recovered = ["order.ts"];
    const fromRecovered = collectDependents(g, recovered);
    const directSet = new Set(recovered);
    const indirectSet = new Set([
      ...fromRecovered.direct,
      ...fromRecovered.indirect,
    ]);
    for (const d of directSet) indirectSet.delete(d);

    expect([...directSet]).toEqual(["order.ts"]);
    expect([...indirectSet]).toEqual(["api.ts"]);
  });

  it("keeps recovered test importers out of directDependents", () => {
    const recovered = ["src/order.ts", "src/payment.test.ts"];
    const nonTests = recovered.filter((p) => !p.includes(".test."));
    expect(nonTests).toEqual(["src/order.ts"]);
  });
});

describe("diffTouchesExports", () => {
  it("detects export line changes in unified diffs", () => {
    const diff = `@@ -1,3 +1,3 @@
-export function charge(amount: number): number {
+export function charge(amount: number, retry = false): number {
   return amount;
 }
`;
    expect(diffTouchesExports(diff)).toBe(true);
    expect(diffTouchesExports("@@ -1 +1 @@\n-const x = 1;\n+const x = 2;\n")).toBe(
      false,
    );
  });

  it("detects export{…} without whitespace", () => {
    expect(diffTouchesExports("+export{foo}\n")).toBe(true);
    expect(diffTouchesExports("+export* from './m'\n")).toBe(true);
  });
});

describe("computeRisk", () => {
  it("returns high when exported API changed", () => {
    const result = computeRisk({
      changed: ["src/payment.ts"],
      direct: ["src/order.ts"],
      indirect: [],
      affectedTests: ["src/payment.test.ts"],
      exportedApiChanged: true,
      moduleExportsPublicSymbols: true,
      graph: null,
    });
    expect(result.risk).toBe("high");
    expect(result.reasons.some((r) => r.includes("exported API"))).toBe(true);
  });

  it("returns medium for source with dependents", () => {
    const result = computeRisk({
      changed: ["src/payment.ts"],
      direct: ["src/order.ts"],
      indirect: ["src/api.ts"],
      affectedTests: [],
      exportedApiChanged: false,
      moduleExportsPublicSymbols: true,
      graph: null,
    });
    expect(result.risk).toBe("medium");
  });

  it("returns low for docs-only", () => {
    const result = computeRisk({
      changed: ["README.md"],
      direct: [],
      indirect: [],
      affectedTests: [],
      exportedApiChanged: false,
      moduleExportsPublicSymbols: false,
      graph: null,
    });
    expect(result.risk).toBe("low");
  });
});

describe("buildSuggestedValidation", () => {
  it("builds bun and npm test suggestions", () => {
    const cmds = buildSuggestedValidation([
      "src/payment.test.ts",
      "src/order.spec.ts",
    ]);
    expect(cmds[0]).toBe("bun test payment order");
    expect(cmds[1]).toBe("npm test -- payment order");
  });
});
