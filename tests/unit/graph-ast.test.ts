import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import ts from "typescript";
import { fileComplexity, isHighComplexity } from "../../src/analyzer/complexity.ts";
import { extractExports } from "../../src/analyzer/exports.ts";
import {
  aliasMapsToSeed,
  extractImports,
  isBareSpecifier,
} from "../../src/analyzer/imports.ts";
import { findUnusedExports } from "../../src/analyzer/unused-exports.ts";
import { extractSymbols } from "../../src/analyzer/symbols.ts";
import { loadProjectGraph } from "../../src/analyzer/load-graph.ts";
import { scanFiles } from "../../src/scanner/scan-files.ts";
import { ProjectGraph } from "../../src/graph/graph.ts";

function parseSource(code: string, fileName = "/proj/src/sample.ts"): ts.SourceFile {
  return ts.createSourceFile(fileName, code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
}

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("ProjectGraph cycles", () => {
  it("detects a simple A→B→C→A cycle", () => {
    const g = new ProjectGraph();
    g.addNode("a", "a.ts");
    g.addNode("b", "b.ts");
    g.addNode("c", "c.ts");
    g.addEdge("a", "b");
    g.addEdge("b", "c");
    g.addEdge("c", "a");
    const cycles = g.findCycles();
    expect(cycles.length).toBe(1);
    expect(cycles[0].sort()).toEqual(["a", "b", "c"]);
  });

  it("returns dependents and dependencies", () => {
    const g = new ProjectGraph();
    g.addNode("api", "api.ts");
    g.addNode("order", "order.ts");
    g.addEdge("api", "order");
    expect(g.dependenciesOf("api")).toEqual(["order"]);
    expect(g.dependentsOf("order")).toEqual(["api"]);
  });
});

describe("complexity", () => {
  it("scores branching and flags high complexity", () => {
    const low = parseSource(`export function f(x: number) { return x; }`);
    expect(fileComplexity(low)).toBe(1);
    expect(isHighComplexity(fileComplexity(low))).toBe(false);

    const branches = Array.from({ length: 25 }, (_, i) => `if (x === ${i}) return ${i};`).join("\n");
    const high = parseSource(`export function f(x: number) {\n${branches}\nreturn 0;\n}`);
    expect(isHighComplexity(fileComplexity(high))).toBe(true);
  });
});

describe("import/export extraction", () => {
  it("detects bare specifiers", () => {
    expect(isBareSpecifier("react")).toBe(true);
    expect(isBareSpecifier("./x")).toBe(false);
  });

  it("extracts named and default exports", () => {
    const sf = parseSource(`
      export function charge() { return 1; }
      export default function main() { return 2; }
    `);
    const exports = extractExports(sf, "/proj");
    const names = exports.map((e) => e.name).sort();
    expect(names).toContain("charge");
    expect(names).toContain("default");
  });

  it("extracts relative imports", () => {
    const sf = parseSource(
      `import { charge } from "./payment";\nexport const x = charge(1);`,
      "/proj/src/order.ts",
    );
    const options: ts.CompilerOptions = {
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      target: ts.ScriptTarget.ES2022,
    };
    const imports = extractImports(sf, "/proj", options);
    expect(imports).toHaveLength(1);
    expect(imports[0].specifier).toBe("./payment");
    expect(imports[0].external).toBe(false);
  });

  it("resolves path aliases via tsconfig paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-alias-"));
    temps.push(dir);
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src/payment.ts"), "export const charge = 1;\n");
    writeFileSync(join(dir, "src/order.ts"), `import { charge } from "@/payment";\n`);

    const realSf = ts.createSourceFile(
      join(dir, "src/order.ts"),
      `import { charge } from "@/payment";\n`,
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TS,
    );
    const diskOptions: ts.CompilerOptions = {
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      target: ts.ScriptTarget.ES2022,
      baseUrl: dir,
      paths: { "@/*": ["src/*"] },
    };
    const imports = extractImports(realSf, dir, diskOptions);
    expect(imports[0].external).toBe(false);
    expect(imports[0].resolvedPath).toBe("src/payment.ts");
  });

  it("maps aliases to deleted seeds", () => {
    const options: ts.CompilerOptions = {
      baseUrl: ".",
      paths: { "@/*": ["src/*"] },
    };
    expect(aliasMapsToSeed("@/payment", "src/payment.ts", options, "/proj")).toBe(true);
    expect(aliasMapsToSeed("@/other", "src/payment.ts", options, "/proj")).toBe(false);
    expect(aliasMapsToSeed("react", "src/payment.ts", options, "/proj")).toBe(false);
  });

  it("maps baseUrl-only path-like bare imports to deleted seeds", () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-baseurl-"));
    temps.push(dir);
    // Local first segment must exist under baseUrl (file itself may be deleted).
    mkdirSync(join(dir, "src", "utils"), { recursive: true });
    const options: ts.CompilerOptions = {
      baseUrl: "src",
    };
    expect(aliasMapsToSeed("utils/foo", "src/utils/foo.ts", options, dir)).toBe(true);
    expect(aliasMapsToSeed("utils/bar", "src/utils/foo.ts", options, dir)).toBe(false);
    // Package/builtin names must not false-positive via baseUrl
    expect(aliasMapsToSeed("react", "src/react.ts", options, dir)).toBe(false);
    expect(aliasMapsToSeed("fs", "src/fs.ts", options, dir)).toBe(false);
    expect(aliasMapsToSeed("fs/promises", "src/fs/promises.ts", options, dir)).toBe(false);
    expect(aliasMapsToSeed("next/navigation", "src/next/navigation.ts", options, dir)).toBe(
      false,
    );
    expect(aliasMapsToSeed("@scope/pkg", "src/@scope/pkg.ts", options, dir)).toBe(false);
  });

  it("does not fall through to baseUrl after a paths miss", () => {
    const options: ts.CompilerOptions = {
      baseUrl: ".",
      paths: { utils: ["src/utils/index.ts"] },
    };
    expect(aliasMapsToSeed("utils", "utils.ts", options, "/proj")).toBe(false);
  });

  it("maps # subpath aliases to deleted seeds", () => {
    const options: ts.CompilerOptions = {
      baseUrl: ".",
      paths: { "#/*": ["src/*"] },
    };
    expect(aliasMapsToSeed("#/payment", "src/payment.ts", options, "/proj")).toBe(true);
  });

  it("maps # imports via package.json imports", () => {
    const options: ts.CompilerOptions = { baseUrl: "." };
    const imports = {
      "#utils/*": "./src/utils/*",
      "#payment": "./src/payment.ts",
    };
    expect(
      aliasMapsToSeed("#payment", "src/payment.ts", options, "/proj", imports),
    ).toBe(true);
    expect(
      aliasMapsToSeed("#utils/foo", "src/utils/foo.ts", options, "/proj", imports),
    ).toBe(true);
    expect(
      aliasMapsToSeed("#utils/bar", "src/payment.ts", options, "/proj", imports),
    ).toBe(false);
  });

  it("picks the most specific paths pattern", () => {
    const options: ts.CompilerOptions = {
      baseUrl: ".",
      paths: {
        "@/*": ["src/*"],
        "@/payment": ["lib/payment.ts"],
      },
    };
    expect(aliasMapsToSeed("@/payment", "lib/payment.ts", options, "/proj")).toBe(true);
    expect(aliasMapsToSeed("@/payment", "src/payment.ts", options, "/proj")).toBe(false);
  });

  it("resolves package.json imports against package root, not baseUrl", () => {
    const options: ts.CompilerOptions = { baseUrl: "src" };
    const imports = { "#payment": "./src/payment.ts" };
    expect(
      aliasMapsToSeed("#payment", "src/payment.ts", options, "/proj", imports),
    ).toBe(true);
    // Must not resolve ./src/payment.ts relative to baseUrl (src/src/payment.ts)
    expect(
      aliasMapsToSeed("#payment", "src/src/payment.ts", options, "/proj", imports),
    ).toBe(false);
  });

  it("does not baseUrl-map uninstalled package subpaths", () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-alias-"));
    temps.push(dir);
    mkdirSync(join(dir, "src"), { recursive: true });
    // No node_modules/some-pkg and no local src/some-pkg dir.
    const options: ts.CompilerOptions = { baseUrl: "src" };
    expect(
      aliasMapsToSeed("some-pkg/sub", "src/some-pkg/sub.ts", options, dir),
    ).toBe(false);
  });

  it("maps single-segment baseUrl imports to deleted seeds", () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-helpers-"));
    temps.push(dir);
    mkdirSync(join(dir, "src"), { recursive: true });
    const options: ts.CompilerOptions = { baseUrl: "src" };
    expect(aliasMapsToSeed("helpers", "src/helpers.ts", options, dir)).toBe(true);
    expect(aliasMapsToSeed("helpers", "src/other.ts", options, dir)).toBe(false);
  });

  it("does not alias-match a deleted seed when a live sibling exists", () => {
    const options: ts.CompilerOptions = {
      baseUrl: ".",
      paths: { "#/*": ["src/*"] },
    };
    const live = new Set(["src/payment.tsx"]);
    expect(
      aliasMapsToSeed("#/payment", "src/payment.ts", options, "/proj", null, live),
    ).toBe(false);
    expect(
      aliasMapsToSeed("#/payment", "src/payment.ts", options, "/proj", null, new Set()),
    ).toBe(true);
  });

  it("does not alias-match a deleted seed when a live index module exists", () => {
    const options: ts.CompilerOptions = {
      baseUrl: ".",
      paths: { "#/*": ["src/*"] },
    };
    const live = new Set(["src/foo/index.ts"]);
    expect(
      aliasMapsToSeed("#/foo", "src/foo.ts", options, "/proj", null, live),
    ).toBe(false);
  });

  it("does not alias-match a deleted index when a live file sibling exists", () => {
    const options: ts.CompilerOptions = {
      baseUrl: ".",
      paths: { "#/*": ["src/*"] },
    };
    const live = new Set(["src/foo.ts"]);
    expect(
      aliasMapsToSeed("#/foo", "src/foo/index.ts", options, "/proj", null, live),
    ).toBe(false);
  });

  it("exact package imports still match when a live sibling exists", () => {
    const options: ts.CompilerOptions = { baseUrl: "." };
    const imports = { "#payment": "./src/payment.ts" };
    const live = new Set(["src/payment.tsx"]);
    expect(
      aliasMapsToSeed("#payment", "src/payment.ts", options, "/proj", imports, live),
    ).toBe(true);
  });
});

describe("extractSymbols route detection", () => {
  it("marks Express-style path routes", () => {
    const sf = parseSource(`
      const app = express();
      app.get("/users/:id", () => {});
    `);
    expect(extractSymbols(sf, "/proj").isRoute).toBe(true);
  });

  it("marks router.use with a path", () => {
    const sf = parseSource(`
      const router = Router();
      router.use("/api", () => {});
    `);
    expect(extractSymbols(sf, "/proj").isRoute).toBe(true);
  });

  it("marks app.use(middleware) without a path", () => {
    const sf = parseSource(`
      const app = express();
      app.use(() => {});
    `);
    expect(extractSymbols(sf, "/proj").isRoute).toBe(true);
  });

  it("marks express().get chained calls", () => {
    const sf = parseSource(`express().get("/x", () => {});`);
    expect(extractSymbols(sf, "/proj").isRoute).toBe(true);
  });

  it("marks routes on express() aliases", () => {
    const sf = parseSource(`
      const r = express();
      r.get("/x", () => {});
    `);
    expect(extractSymbols(sf, "/proj").isRoute).toBe(true);
  });

  it("marks express.Router() routes", () => {
    const sf = parseSource(`
      const r = express.Router();
      r.get("/x", () => {});
    `);
    expect(extractSymbols(sf, "/proj").isRoute).toBe(true);
  });

  it("marks require(\"express\")() routes", () => {
    const sf = parseSource(`
      const app = require("express")();
      app.get("/x", () => {});
    `);
    expect(extractSymbols(sf, "/proj").isRoute).toBe(true);
  });

  it("marks routes on wrapper factory aliases", () => {
    const sf = parseSource(`
      function createApp() {
        return express();
      }
      const app = createApp();
      app.get("/x", () => {});
    `);
    expect(extractSymbols(sf, "/proj").isRoute).toBe(true);
  });

  it("marks routes when a wrapper is used before its declaration", () => {
    const sf = parseSource(`
      const app = createApp();
      function createApp() {
        return express();
      }
      app.get("/x", () => {});
    `);
    expect(extractSymbols(sf, "/proj").isRoute).toBe(true);
  });

  it("marks routes through nested wrappers regardless of declaration order", () => {
    const sf = parseSource(`
      function createApp() {
        return createInner();
      }
      function createInner() {
        return express();
      }
      const app = createApp();
      app.get("/x", () => {});
    `);
    expect(extractSymbols(sf, "/proj").isRoute).toBe(true);
  });

  it("marks template-literal route paths", () => {
    const sf = parseSource(`
      const app = express();
      app.get(\`/users/\${id}\`, () => {});
    `);
    expect(extractSymbols(sf, "/proj").isRoute).toBe(true);
  });

  it("marks template paths with an interpolated prefix", () => {
    const sf = parseSource(`
      const app = express();
      app.get(\`\${base}/users\`, () => {});
    `);
    expect(extractSymbols(sf, "/proj").isRoute).toBe(true);
  });

  it("does not treat URL templates as route paths", () => {
    const sf = parseSource(`
      const app = express();
      app.get(\`https://\${host}/api\`, () => {});
    `);
    expect(extractSymbols(sf, "/proj").isRoute).toBe(false);
  });

  it("marks use on an express() alias named api", () => {
    const sf = parseSource(`
      const api = express();
      api.use(() => {});
    `);
    expect(extractSymbols(sf, "/proj").isRoute).toBe(true);
  });

  it("does not treat Map.get as a route", () => {
    const sf = parseSource(`
      const m = new Map();
      m.get("key");
    `);
    expect(extractSymbols(sf, "/proj").isRoute).toBe(false);
  });

  it("does not treat Map.get with a path-shaped key as a route", () => {
    const sf = parseSource(`
      const m = new Map();
      m.get("/users");
    `);
    expect(extractSymbols(sf, "/proj").isRoute).toBe(false);
  });

  it("does not treat api Map get/delete as a route", () => {
    const sf = parseSource(`
      const api = new Map();
      api.get("user");
      api.delete("user");
    `);
    expect(extractSymbols(sf, "/proj").isRoute).toBe(false);
  });

  it("does not treat api.use on a plain object as a route", () => {
    const sf = parseSource(`
      const api = { use() {} };
      api.use(() => {});
    `);
    expect(extractSymbols(sf, "/proj").isRoute).toBe(false);
  });

  it("does not treat server.use on a plain object as a route", () => {
    const sf = parseSource(`
      const server = { use() {} };
      server.use(() => {});
    `);
    expect(extractSymbols(sf, "/proj").isRoute).toBe(false);
  });

  it("does not treat plain app.get as a route without a framework factory", () => {
    const sf = parseSource(`
      const app = { get() {} };
      app.get("/y", () => {});
    `);
    expect(extractSymbols(sf, "/proj").isRoute).toBe(false);
  });

  it("does not treat plain router.get as a route without a framework factory", () => {
    const sf = parseSource(`
      const router = { get() {} };
      router.get("/x", () => {});
    `);
    expect(extractSymbols(sf, "/proj").isRoute).toBe(false);
  });

  it("does not treat Promise.all as a route", () => {
    const sf = parseSource(`Promise.all([1, 2]);`);
    expect(extractSymbols(sf, "/proj").isRoute).toBe(false);
  });

  it("does not treat axios.get(url) as a route", () => {
    const sf = parseSource(`axios.get("https://api.example.com/x");`);
    expect(extractSymbols(sf, "/proj").isRoute).toBe(false);
  });

  it("does not treat plain object.get without a path as a route", () => {
    const sf = parseSource(`
      const cache = { get() {} };
      cache.get("key");
    `);
    expect(extractSymbols(sf, "/proj").isRoute).toBe(false);
  });
});

describe("findUnusedExports", () => {
  it("counts imports from allowlist-skipped modules loaded by the program", async () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-unused-"));
    temps.push(dir);
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "ignored"), { recursive: true });
    writeFileSync(
      join(dir, "src", "lib.ts"),
      `export function onlyUsedFromIgnored() { return 1; }\n`,
    );
    writeFileSync(
      join(dir, "src", "entry.ts"),
      `import "../ignored/consumer";\n`,
    );
    writeFileSync(
      join(dir, "ignored", "consumer.ts"),
      `import { onlyUsedFromIgnored } from "../src/lib";\nexport const v = onlyUsedFromIgnored();\n`,
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { module: "ESNext", moduleResolution: "bundler", noEmit: true },
        include: ["src/**/*", "ignored/**/*"],
      }),
    );
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "unused-fix" }));

    // Scan skips ignored/; entry still pulls it into the TS program as a dependency.
    const scan = await scanFiles(dir, ["ignored"]);
    const { parsed } = await loadProjectGraph(dir, scan.files, { cache: false });
    expect(parsed.files.some((f) => f.file.includes("ignored/"))).toBe(false);

    const unused = findUnusedExports(parsed);
    expect(
      unused.some(
        (u) => u.file === "src/lib.ts" && u.name === "onlyUsedFromIgnored",
      ),
    ).toBe(false);
  });
});
