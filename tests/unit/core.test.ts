import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, parseSimpleYaml } from "../../src/config/loader.ts";
import {
  doctorExitCode,
  isNodeEngineSatisfied,
  parseMinNodeMajor,
} from "../../src/doctor/checks.ts";
import type { DoctorResult } from "../../src/output/types.ts";
import {
  missingEnvKeys,
  parseEnvKeys,
  readManifests,
} from "../../src/scanner/read-manifests.ts";
import {
  countByExtension,
  isSourceFile,
  isTestFile,
  isTypeScriptFile,
  normalizeIgnoreList,
  scanFiles,
  shouldIgnore,
} from "../../src/scanner/scan-files.ts";
import { createProgramForRoot, isPathInsideRoot } from "../../src/analyzer/program.ts";
import { parseProject } from "../../src/analyzer/parser.ts";
import { classifyScriptSpawnError } from "../../src/check/scripts.ts";
import { loadProjectGraph } from "../../src/analyzer/load-graph.ts";
import { buildProjectGraph } from "../../src/graph/build.ts";
import { findProjectRoot } from "../../src/scanner/find-root.ts";
import { makeParsed } from "../helpers/parse-fixture.ts";
import {
  canonicalizePath,
  toCanonicalRepoRelative,
} from "../../src/path-utils.ts";
import { aliasMapsToSeed } from "../../src/analyzer/imports.ts";
import { realpathSync } from "node:fs";
import ts from "typescript";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("readManifests", () => {
  it("parses tsconfig JSONC with trailing commas", async () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-tsconfig-"));
    temps.push(dir);
    writeFileSync(
      join(dir, "tsconfig.json"),
      `{
  "compilerOptions": {
    "strict": true,
    "baseUrl": ".",
  },
}`,
    );
    const manifests = await readManifests(dir);
    expect(manifests.tsconfigError).toBeNull();
    expect(manifests.tsconfig).toMatchObject({
      compilerOptions: { strict: true, baseUrl: "." },
    });
  });

  it("preserves string contents and strips inline comments", async () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-tsconfig-jsonc-"));
    temps.push(dir);
    writeFileSync(
      join(dir, "tsconfig.json"),
      `{
  // keep going
  "compilerOptions": {
    "strict": true, // inline
    "outDir": "build/* skip */dist",
    "types": ["hello,}"],
  },
}`,
    );
    writeFileSync(
      join(dir, "package.json"),
      `{
  "name": "x",
  "scripts": {
    "build": "echo /* skip */ && tsc"
  }
}
`,
    );
    const manifests = await readManifests(dir);
    expect(manifests.tsconfigError).toBeNull();
    expect(manifests.packageJsonError).toBeNull();
    expect(manifests.tsconfig).toMatchObject({
      compilerOptions: {
        strict: true,
        outDir: "build/* skip */dist",
        types: ["hello,}"],
      },
    });
    expect(manifests.packageJson?.scripts).toEqual({
      build: "echo /* skip */ && tsc",
    });
  });
});

describe("parseEnvKeys", () => {
  it("extracts keys and ignores comments", () => {
    const keys = parseEnvKeys(`
# comment
DATABASE_URL=postgres://localhost
REDIS_URL=
API_KEY="secret"
`);
    expect(keys).toEqual(["DATABASE_URL", "REDIS_URL", "API_KEY"]);
  });
});

describe("missingEnvKeys", () => {
  it("returns keys not present in defined set", () => {
    expect(missingEnvKeys(["A", "B", "C"], ["A", "C"])).toEqual(["B"]);
  });
});

describe("file classification", () => {
  it("detects test files", () => {
    expect(isTestFile("src/math.test.ts")).toBe(true);
    expect(isTestFile("src/math.spec.tsx")).toBe(true);
    expect(isTestFile("__tests__/math.ts")).toBe(true);
    expect(isTestFile("src/math.ts")).toBe(false);
  });

  it("detects typescript and source files", () => {
    expect(isTypeScriptFile(".ts")).toBe(true);
    expect(isTypeScriptFile(".tsx")).toBe(true);
    expect(isTypeScriptFile(".js")).toBe(false);
    expect(isSourceFile(".js")).toBe(true);
    expect(isSourceFile(".css")).toBe(false);
  });

  it("counts extensions", () => {
    const counts = countByExtension([
      { absolutePath: "/a.ts", relativePath: "a.ts", extension: ".ts", size: 1 },
      { absolutePath: "/b.ts", relativePath: "b.ts", extension: ".ts", size: 1 },
      { absolutePath: "/c.tsx", relativePath: "c.tsx", extension: ".tsx", size: 1 },
    ]);
    expect(counts).toEqual({ ".ts": 2, ".tsx": 1 });
  });
});

describe("parseSimpleYaml", () => {
  it("parses dockerRequired and ignore list", () => {
    const config = parseSimpleYaml(`
dockerRequired: true
ignore:
  - tmp
  - vendor
`);
    expect(config.dockerRequired).toBe(true);
    expect(config.ignore).toEqual(["tmp", "vendor"]);
  });

  it("lets a later inline ignore win over an earlier list", () => {
    const config = parseSimpleYaml(`
ignore:
  - a
ignore: [b, c]
`);
    expect(config.ignore).toEqual(["b", "c"]);
  });

  it("parses scalar ignore without wiping to empty", () => {
    expect(parseSimpleYaml("ignore: dist").ignore).toEqual(["dist"]);
    expect(parseSimpleYaml('ignore: "build"').ignore).toEqual(["build"]);
  });
});

describe("loadConfig", () => {
  it("does not let malformed .repopilot.json wipe package.json rules", async () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-cfg-"));
    temps.push(dir);
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "x",
        repopilot: {
          rules: [{ name: "api", from: "src/api/**", cannotImport: ["src/db/**"] }],
          plugins: ["./good-plugin.js"],
        },
      }),
    );
    writeFileSync(
      join(dir, ".repopilot.json"),
      JSON.stringify({
        rules: "not-an-array",
        plugins: null,
        dockerRequired: true,
      }),
    );

    const config = await loadConfig(dir);
    expect(config.dockerRequired).toBe(true);
    expect(config.rules).toEqual([
      { name: "api", from: "src/api/**", cannotImport: ["src/db/**"] },
    ]);
    expect(config.plugins).toEqual(["./good-plugin.js"]);
  });

  it("does not let all-invalid arrays wipe package.json rules", async () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-cfg-"));
    temps.push(dir);
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "x",
        repopilot: {
          rules: [{ name: "api", from: "src/api/**", cannotImport: ["src/db/**"] }],
          plugins: ["./good-plugin.js"],
          ignore: ["vendor"],
        },
      }),
    );
    writeFileSync(
      join(dir, ".repopilot.json"),
      JSON.stringify({
        rules: [{}],
        plugins: [null, 123],
        ignore: [123, false],
      }),
    );

    const config = await loadConfig(dir);
    expect(config.rules).toEqual([
      { name: "api", from: "src/api/**", cannotImport: ["src/db/**"] },
    ]);
    expect(config.plugins).toEqual(["./good-plugin.js"]);
    expect(config.ignore).toEqual(["vendor"]);
  });

  it("allows intentional empty arrays to clear package.json rules", async () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-cfg-"));
    temps.push(dir);
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "x",
        repopilot: {
          rules: [{ name: "api", from: "src/api/**", cannotImport: [] }],
          plugins: ["./p.js"],
        },
      }),
    );
    writeFileSync(
      join(dir, ".repopilot.json"),
      JSON.stringify({ rules: [], plugins: [] }),
    );

    const config = await loadConfig(dir);
    expect(config.rules).toEqual([]);
    expect(config.plugins).toEqual([]);
  });
});

describe("parseMinNodeMajor", () => {
  it("parses engines.node ranges", () => {
    expect(parseMinNodeMajor(">=18")).toBe(18);
    expect(parseMinNodeMajor("^20.1.0")).toBe(20);
    expect(parseMinNodeMajor("<18")).toBeNull();
  });
});

describe("isNodeEngineSatisfied", () => {
  it("handles lower and upper bounds", () => {
    expect(isNodeEngineSatisfied(">=18", 20)).toBe(true);
    expect(isNodeEngineSatisfied(">=18", 16)).toBe(false);
    expect(isNodeEngineSatisfied("<18", 16)).toBe(true);
    expect(isNodeEngineSatisfied("<18", 20)).toBe(false);
    expect(isNodeEngineSatisfied("^20", 20)).toBe(true);
    expect(isNodeEngineSatisfied("^18", 20)).toBe(false);
    expect(isNodeEngineSatisfied("~18", 19)).toBe(false);
    expect(isNodeEngineSatisfied(">=18 <20", 19)).toBe(true);
    expect(isNodeEngineSatisfied(">=18 <20", 20)).toBe(false);
  });

  it("handles || unions", () => {
    expect(isNodeEngineSatisfied("^18 || ^20", 18)).toBe(true);
    expect(isNodeEngineSatisfied("^18 || ^20", 20)).toBe(true);
    expect(isNodeEngineSatisfied("^18 || ^20", 19)).toBe(false);
    expect(isNodeEngineSatisfied("^18.17.0 || >=20.5.0", 18)).toBe(true);
    expect(isNodeEngineSatisfied("^18.17.0 || >=20.5.0", 20)).toBe(true);
    expect(isNodeEngineSatisfied("14 || 16 || 18", 18)).toBe(true);
    expect(isNodeEngineSatisfied("14 || 16 || 18", 17)).toBe(false);
  });
});

describe("isPathInsideRoot", () => {
  it("requires a path boundary", () => {
    expect(isPathInsideRoot("/home/proj/src/a.ts", "/home/proj")).toBe(true);
    expect(isPathInsideRoot("/home/project/src/a.ts", "/home/proj")).toBe(false);
    expect(isPathInsideRoot("/home/proj-extra/a.ts", "/home/proj")).toBe(false);
  });
});

describe("canonicalizePath", () => {
  it("prefix-realpaths deleted files under in-repo directory symlinks", () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-canon-"));
    temps.push(dir);
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "b.ts"), "export const b = 1;\n");
    try {
      symlinkSync(join(dir, "src"), join(dir, "alias"));
    } catch {
      return;
    }

    // Live file through symlink
    expect(toCanonicalRepoRelative(dir, "alias/b.ts")).toBe("src/b.ts");

    // Deleted leaf — parent symlink still canonicalizes
    rmSync(join(dir, "src", "b.ts"));
    expect(canonicalizePath(join(dir, "alias", "b.ts"))).toBe(
      join(realpathSync(join(dir, "src")), "b.ts"),
    );
    expect(toCanonicalRepoRelative(dir, "alias/b.ts")).toBe("src/b.ts");
  });

  it("rejects paths that escape the project root", () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-canon-esc-"));
    temps.push(dir);
    mkdirSync(join(dir, "src"), { recursive: true });
    expect(toCanonicalRepoRelative(dir, "../outside.ts")).toBeNull();
    expect(toCanonicalRepoRelative(dir, "/etc/passwd")).toBeNull();
  });

  it("allows in-repo names that start with .. but are not parent escapes", () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-canon-dotdot-"));
    temps.push(dir);
    writeFileSync(join(dir, "..foo.ts"), "export const x = 1;\n");
    expect(toCanonicalRepoRelative(dir, "..foo.ts")).toBe("..foo.ts");
  });

  it("resolves relative inputs against cwd, not only project root", () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-canon-cwd-"));
    temps.push(dir);
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "payment.ts"), "export const p = 1;\n");
    expect(toCanonicalRepoRelative(dir, "payment.ts", join(dir, "src"))).toBe(
      "src/payment.ts",
    );
    // Same basename from project root resolves to a different (root-level) path.
    expect(toCanonicalRepoRelative(dir, "payment.ts", dir)).toBe("payment.ts");
  });
});

describe("aliasMapsToSeed through in-tree symlink paths", () => {
  it("matches canonical seeds when paths map via a directory symlink", () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-alias-sym-"));
    temps.push(dir);
    mkdirSync(join(dir, "src"), { recursive: true });
    try {
      symlinkSync(join(dir, "src"), join(dir, "alias"));
    } catch {
      return;
    }
    const options: ts.CompilerOptions = {
      baseUrl: ".",
      paths: { "@/*": ["./alias/*"] },
    };
    expect(aliasMapsToSeed("@/payment", "src/payment.ts", options, dir)).toBe(true);
    expect(aliasMapsToSeed("@/payment", "alias/payment.ts", options, dir)).toBe(true);
  });
});

describe("ignore patterns", () => {
  it("normalizes string ignore to a single pattern", () => {
    expect(normalizeIgnoreList("vendor")).toEqual(["vendor"]);
    expect(normalizeIgnoreList(["a", "b"])).toEqual(["a", "b"]);
  });

  it("matches basenames and path prefixes/globs", () => {
    expect(shouldIgnore("node_modules/x", "node_modules", ["node_modules"])).toBe(
      true,
    );
    expect(shouldIgnore("src/generated/a.ts", "a.ts", ["src/generated"])).toBe(
      true,
    );
    expect(shouldIgnore("src/app.ts", "app.ts", ["src/generated"])).toBe(false);
    expect(shouldIgnore("build/out.js", "out.js", ["**/out.js"])).toBe(true);
  });
});

describe("scanFiles symlinks", () => {
  it("canonicalizes in-root symlinks to realpath relatives", async () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-scan-"));
    temps.push(dir);
    mkdirSync(join(dir, "real", "nested"), { recursive: true });
    writeFileSync(join(dir, "real", "nested", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(dir, "real", "b.ts"), "export const b = 2;\n");
    try {
      symlinkSync(join(dir, "real", "nested"), join(dir, "link-dir"));
      symlinkSync(join(dir, "real", "b.ts"), join(dir, "link-b.ts"));
    } catch {
      return; // platform without symlink support
    }

    const scan = await scanFiles(dir);
    const rels = scan.files.map((f) => f.relativePath).sort();
    // Canonical paths match TS resolution (not link-dir/…)
    expect(rels).toContain("real/nested/a.ts");
    expect(rels).toContain("real/b.ts");
    expect(rels).not.toContain("link-dir/a.ts");
    expect(rels).not.toContain("link-b.ts");
  });

  it("rejects symlinks whose realpath escapes the project root", async () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-scan-jail-"));
    const outside = mkdtempSync(join(tmpdir(), "repopilot-scan-out-"));
    temps.push(dir, outside);
    mkdirSync(join(outside, "secret"), { recursive: true });
    writeFileSync(join(outside, "secret", "leak.ts"), "export const leak = 1;\n");
    try {
      symlinkSync(join(outside, "secret"), join(dir, "linked-out"));
    } catch {
      return;
    }

    const scan = await scanFiles(dir);
    expect(scan.files.some((f) => f.relativePath.includes("leak"))).toBe(false);
  });

  it("keeps graph edges for modules under an in-tree directory symlink", async () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-scan-edge-"));
    temps.push(dir);
    mkdirSync(join(dir, "real", "nested"), { recursive: true });
    writeFileSync(join(dir, "real", "nested", "a.ts"), "export const a = 1;\n");
    writeFileSync(
      join(dir, "real", "nested", "b.ts"),
      `import { a } from "./a";\nexport const b = a;\n`,
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { module: "ESNext", moduleResolution: "bundler", noEmit: true },
        include: ["**/*.ts"],
      }),
    );
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "sym-edge" }));
    try {
      symlinkSync(join(dir, "real", "nested"), join(dir, "link-dir"));
    } catch {
      return;
    }

    const scan = await scanFiles(dir);
    const { graph } = await loadProjectGraph(dir, scan.files, { cache: false });
    expect(graph.getNode("real/nested/a.ts")).toBeTruthy();
    expect(graph.getNode("real/nested/b.ts")).toBeTruthy();
    expect(
      graph.getEdges().some(
        (e) => e.from === "real/nested/b.ts" && e.to === "real/nested/a.ts",
      ),
    ).toBe(true);
  });

  it("findProjectRoot canonicalizes a symlinked project root", () => {
    const real = mkdtempSync(join(tmpdir(), "repopilot-root-real-"));
    const linkParent = mkdtempSync(join(tmpdir(), "repopilot-root-link-"));
    temps.push(real, linkParent);
    writeFileSync(join(real, "package.json"), JSON.stringify({ name: "sym-root" }));
    mkdirSync(join(real, "src"), { recursive: true });
    writeFileSync(join(real, "src", "a.ts"), "export const a = 1;\n");
    const link = join(linkParent, "proj");
    try {
      symlinkSync(real, link);
    } catch {
      return;
    }

    const root = findProjectRoot(link);
    expect(root).toBe(realpathSync(real));
  });
});

describe("createProgramForRoot", () => {
  it("honors an empty scan allowlist instead of falling back to tsconfig", () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-prog-"));
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

    const ctx = createProgramForRoot(dir, []);
    expect(ctx.program.getRootFileNames()).toEqual([]);
  });

  it("discovers sources when allowlist is null and there is no tsconfig", () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-prog-noconfig-"));
    temps.push(dir);
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "ignored"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(dir, "ignored", "b.ts"), "export const b = 1;\n");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "noconfig" }));

    const ctx = createProgramForRoot(dir, null);
    const roots = ctx.program.getRootFileNames().map((f) => f.replaceAll("\\", "/"));
    expect(roots.some((f) => f.endsWith("/src/a.ts"))).toBe(true);
    expect(roots.some((f) => f.endsWith("/ignored/b.ts"))).toBe(true);
  });

  it("does not follow out-of-root directory symlinks when discovering sources", () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-prog-jail-"));
    const outside = mkdtempSync(join(tmpdir(), "repopilot-prog-out-"));
    temps.push(dir, outside);
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(outside, "secret"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(outside, "secret", "leak.ts"), "export const leak = 1;\n");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "jail" }));
    try {
      symlinkSync(join(outside, "secret"), join(dir, "linked-out"));
    } catch {
      return;
    }

    const ctx = createProgramForRoot(dir, null);
    const roots = ctx.program.getRootFileNames().map((f) => f.replaceAll("\\", "/"));
    expect(roots.some((f) => f.endsWith("/src/a.ts"))).toBe(true);
    expect(roots.some((f) => f.includes("leak.ts"))).toBe(false);
  });

  it("uses tsconfig fileNames when scan allowlist is omitted", () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-prog-omit-"));
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

    const ctx = createProgramForRoot(dir);
    expect(ctx.program.getRootFileNames().length).toBeGreaterThan(0);

    const parsed = parseProject(dir);
    expect(parsed.files.some((f) => f.file.endsWith("a.ts"))).toBe(true);
  });

  it("parseProject honors scannedFiles allowlist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "repopilot-parse-allow-"));
    temps.push(dir);
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "ignored"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), `import "../ignored/secret";\nexport const a = 1;\n`);
    writeFileSync(join(dir, "ignored", "secret.ts"), `export const s = 1;\n`);
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { module: "ESNext", moduleResolution: "bundler", noEmit: true },
        include: ["src/**/*", "ignored/**/*"],
      }),
    );
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "parse-allow" }));

    const scan = await scanFiles(dir, ["ignored"]);
    const parsed = parseProject(dir, scan.files);
    expect(parsed.files.some((f) => f.file.includes("ignored/"))).toBe(false);
    expect(parsed.files.some((f) => f.file.endsWith("a.ts"))).toBe(true);
  });
});

describe("buildProjectGraph", () => {
  it("does not create ghost nodes for unparsed resolved targets", () => {
    const parsed = makeParsed([
      {
        file: "src/a.ts",
        imports: [
          {
            specifier: "../dist/b",
            resolvedPath: "dist/b.js",
          },
        ],
      },
    ]);

    const graph = buildProjectGraph(parsed);
    expect(graph.getNode("dist/b.js")).toBeUndefined();
    expect(graph.getEdges()).toEqual([]);
  });
});

describe("classifyScriptSpawnError", () => {
  it("skips maxBuffer overflows instead of failing", () => {
    const overflow = classifyScriptSpawnError(
      Object.assign(new Error("stdout maxBuffer length exceeded"), {
        code: "ENOBUFS",
      }),
    );
    expect(overflow.status).toBe("skip");
    expect(overflow.message).toMatch(/buffer limit/i);
  });

  it("fails on other spawn errors", () => {
    const other = classifyScriptSpawnError(
      Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
    );
    expect(other.status).toBe("fail");
    expect(other.message).toMatch(/ENOENT/);
  });
});

describe("doctorExitCode", () => {
  it("returns 1 when any check failed", () => {
    const failed: DoctorResult = {
      root: "/",
      checks: [
        { id: "x", label: "x", status: "fail", message: "fail" },
        { id: "y", label: "y", status: "warn", message: "warn" },
      ],
      summary: { passed: 0, warnings: 1, failed: 1 },
    };
    expect(doctorExitCode(failed)).toBe(1);

    const ok: DoctorResult = {
      root: "/",
      checks: [{ id: "y", label: "y", status: "warn", message: "warn" }],
      summary: { passed: 0, warnings: 1, failed: 0 },
    };
    expect(doctorExitCode(ok)).toBe(0);
  });
});
