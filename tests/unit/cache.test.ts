import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mapPool } from "../../src/cache/concurrency.ts";
import { hashText, projectFingerprint, toolCacheIdentity } from "../../src/cache/fingerprint.ts";
import {
  clearCache,
  fileEntryPath,
  loadCachedFile,
  loadManifest,
  saveCachedFile,
  saveManifest,
} from "../../src/cache/store.ts";
import { CACHE_SCHEMA_VERSION } from "../../src/cache/types.ts";
import { parseProjectIncremental } from "../../src/analyzer/parse-incremental.ts";
import { scanFiles } from "../../src/scanner/scan-files.ts";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "repopilot-cache-"));
  temps.push(dir);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "cache-fixture", private: true, type: "module" }),
  );
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        strict: true,
        noEmit: true,
      },
      include: ["src/**/*"],
    }),
  );
  writeFileSync(join(dir, "src/a.ts"), `export const a = 1;\n`);
  writeFileSync(join(dir, "src/b.ts"), `import { a } from "./a";\nexport const b = a;\n`);
  return dir;
}

describe("fingerprint", () => {
  it("hashes text stably", () => {
    expect(hashText("hello")).toBe(hashText("hello"));
    expect(hashText("hello")).not.toBe(hashText("world"));
  });

  it("includes tool version and schema in the cache identity", () => {
    const id = toolCacheIdentity();
    expect(id).toMatch(/^repopilot:\d+\.\d+\.\d+:schema\d+$/);
    expect(id).toContain(`schema${CACHE_SCHEMA_VERSION}`);
    expect(id).not.toContain(":unknown:");
  });

  it("changes project fingerprint when package.json changes", async () => {
    const dir = tempProject();
    const first = await projectFingerprint(dir);
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "cache-fixture-2", private: true }),
    );
    const second = await projectFingerprint(dir);
    expect(first).not.toBe(second);
  });

  it("changes fingerprint when extended tsconfig changes", async () => {
    const dir = tempProject();
    writeFileSync(
      join(dir, "tsconfig.base.json"),
      JSON.stringify({ compilerOptions: { strict: true } }),
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        extends: "./tsconfig.base.json",
        compilerOptions: { module: "ESNext", moduleResolution: "bundler", noEmit: true },
        include: ["src/**/*"],
      }),
    );
    const first = await projectFingerprint(dir, ["src/a.ts", "src/b.ts"]);
    writeFileSync(
      join(dir, "tsconfig.base.json"),
      JSON.stringify({ compilerOptions: { strict: false } }),
    );
    const second = await projectFingerprint(dir, ["src/a.ts", "src/b.ts"]);
    expect(first).not.toBe(second);
  });

  it("changes fingerprint when source inventory changes", async () => {
    const dir = tempProject();
    const first = await projectFingerprint(dir, ["src/a.ts", "src/b.ts"]);
    const second = await projectFingerprint(dir, ["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(first).not.toBe(second);
  });

  it("changes fingerprint when package-style extends content changes", async () => {
    const dir = tempProject();
    mkdirSync(join(dir, "node_modules", "@tsconfig", "node18"), { recursive: true });
    writeFileSync(
      join(dir, "node_modules", "@tsconfig", "node18", "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true } }),
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        extends: "@tsconfig/node18",
        compilerOptions: { module: "ESNext", moduleResolution: "bundler", noEmit: true },
        include: ["src/**/*"],
      }),
    );
    const first = await projectFingerprint(dir, ["src/a.ts"]);
    writeFileSync(
      join(dir, "node_modules", "@tsconfig", "node18", "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: false } }),
    );
    const second = await projectFingerprint(dir, ["src/a.ts"]);
    expect(first).not.toBe(second);
  });

  it("changes fingerprint when JSONC array extends parent changes", async () => {
    const dir = tempProject();
    writeFileSync(
      join(dir, "tsconfig.a.json"),
      JSON.stringify({ compilerOptions: { strict: true } }),
    );
    writeFileSync(
      join(dir, "tsconfig.b.json"),
      JSON.stringify({ compilerOptions: { skipLibCheck: true } }),
    );
    // Trailing commas / comments — typical JSONC tsconfig
    writeFileSync(
      join(dir, "tsconfig.json"),
      `{
  // base configs
  "extends": ["./tsconfig.a.json", "./tsconfig.b.json"],
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "bundler",
    "noEmit": true,
  },
  "include": ["src/**/*"],
}
`,
    );
    const first = await projectFingerprint(dir, ["src/a.ts"]);
    writeFileSync(
      join(dir, "tsconfig.b.json"),
      JSON.stringify({ compilerOptions: { skipLibCheck: false } }),
    );
    const second = await projectFingerprint(dir, ["src/a.ts"]);
    expect(first).not.toBe(second);
  });
});

describe("mapPool", () => {
  it("maps with concurrency", async () => {
    const out = await mapPool([1, 2, 3, 4], 2, async (n) => n * 2);
    expect(out).toEqual([2, 4, 6, 8]);
  });
});

describe("cache store", () => {
  it("uses distinct paths for slash vs underscore relatives", () => {
    const dir = tempProject();
    expect(fileEntryPath(dir, "src/a/b.ts")).not.toBe(
      fileEntryPath(dir, "src/a__b.ts"),
    );
  });

  it("round-trips file entries and clears", async () => {
    const dir = tempProject();
    await saveManifest(dir, {
      schemaVersion: CACHE_SCHEMA_VERSION,
      projectFingerprint: "abc",
      files: { "src/a.ts": "hash1" },
    });
    await saveCachedFile(dir, "src/a.ts", "hash1", {
      file: "src/a.ts",
      imports: [],
      exports: [{ file: "src/a.ts", name: "a", kind: "named" }],
      symbols: {
        file: "src/a.ts",
        functions: [],
        classes: [],
        isRoute: false,
        isTest: false,
      },
      complexity: 1,
    });

    const hit = await loadCachedFile(dir, "src/a.ts", "hash1");
    expect(hit?.file).toBe("src/a.ts");
    const miss = await loadCachedFile(dir, "src/a.ts", "wrong");
    expect(miss).toBeNull();

    await clearCache(dir);
    expect(await loadManifest(dir)).toBeNull();
  });
});

describe("parseProjectIncremental", () => {
  it("caches on second run and reparses touched files", async () => {
    const dir = tempProject();
    const scan = await scanFiles(dir);

    const first = await parseProjectIncremental(dir, scan.files, { cache: true });
    expect(first.stats.filesParsed).toBeGreaterThan(0);
    expect(first.stats.filesCached).toBe(0);

    const second = await parseProjectIncremental(dir, scan.files, { cache: true });
    expect(second.stats.filesCached).toBe(second.stats.filesTotal);
    expect(second.stats.filesParsed).toBe(0);

    writeFileSync(join(dir, "src/a.ts"), `export const a = 2;\n`);
    const third = await parseProjectIncremental(dir, scan.files, { cache: true });
    expect(third.stats.filesParsed).toBeGreaterThanOrEqual(1);
    expect(third.stats.filesCached).toBeLessThan(third.stats.filesTotal);

    // Ensure cache files were written
    const manifest = readFileSync(join(dir, ".repopilot/cache/manifest.json"), "utf8");
    expect(manifest).toContain("projectFingerprint");
  });
});
