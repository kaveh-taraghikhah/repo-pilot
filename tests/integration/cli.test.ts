import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { analyzeCommand } from "../../src/cli/commands/analyze.ts";
import { doctorCommand } from "../../src/cli/commands/doctor.ts";
import { graphCommand } from "../../src/cli/commands/graph.ts";
import type { OutputOptions } from "../../src/output/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "../fixtures");
const healthy = join(fixtures, "healthy-project");
const brokenEnv = join(fixtures, "broken-env");
const circular = join(fixtures, "circular-dependency");
const simpleGraph = join(fixtures, "simple-graph");

function opts(cwd: string): OutputOptions {
  return { json: true, quiet: true, color: false, cache: true, cwd };
}

async function captureJson<T>(fn: () => Promise<number>): Promise<{ code: number; data: T }> {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;

  try {
    const code = await fn();
    return { code, data: JSON.parse(chunks.join("")) as T };
  } finally {
    process.stdout.write = original;
  }
}

beforeAll(() => {
  for (const root of [healthy, brokenEnv, circular, simpleGraph]) {
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    mkdirSync(join(root, "node_modules"), { recursive: true });
  }
});

describe("doctor command", () => {
  it("passes on healthy-project (exit 0)", async () => {
    const { code, data } = await captureJson<{
      summary: { failed: number };
      checks: Array<{ id: string; status: string }>;
    }>(() => doctorCommand(opts(healthy)));

    expect(code).toBe(0);
    expect(data.summary.failed).toBe(0);
    const ids = data.checks.map((c) => c.id);
    expect(ids).toContain("git");
    expect(ids).toContain("package-json");
    expect(ids).toContain("lockfile");
    expect(ids).toContain("tsconfig");
    expect(ids).toContain("env");
    const env = data.checks.find((c) => c.id === "env");
    expect(env?.status).toBe("pass");
  });

  it("warns on missing env keys for broken-env", async () => {
    const { code, data } = await captureJson<{
      checks: Array<{ id: string; status: string; details?: string[] }>;
    }>(() => doctorCommand(opts(brokenEnv)));

    expect(code).toBe(0);
    const env = data.checks.find((c) => c.id === "env");
    expect(env?.status).toBe("warn");
    expect(env?.details).toEqual(
      expect.arrayContaining(["REDIS_URL", "STRIPE_SECRET_KEY"]),
    );
  });
});

describe("analyze command", () => {
  it("returns stable JSON shape for healthy-project", async () => {
    const { code, data } = await captureJson<Record<string, unknown>>(() =>
      analyzeCommand(opts(healthy)),
    );

    expect(code).toBe(0);
    expect(data.project).toBe("healthy-project");
    expect(data.files).toBeGreaterThan(0);
    expect(data.typescriptPercentage).toBeGreaterThan(0);
    expect(data.reactComponents).toBeGreaterThanOrEqual(1);
    expect(data.testFiles).toBeGreaterThanOrEqual(1);
    expect(data.modules).toBeGreaterThan(0);
    expect(data.functions).toBeGreaterThan(0);
    expect(typeof data.circularDependencies).toBe("number");
    expect(typeof data.unusedExports).toBe("number");
    expect(typeof data.highComplexityFiles).toBe("number");
    expect(Array.isArray(data.architecture)).toBe(true);
    expect(Array.isArray(data.issues)).toBe(true);
  });

  it("reports circular dependencies for circular-dependency fixture", async () => {
    const { code, data } = await captureJson<{
      circularDependencies: number;
      issues: Array<{ message: string }>;
    }>(() => analyzeCommand(opts(circular)));

    expect(code).toBe(0);
    expect(data.circularDependencies).toBeGreaterThanOrEqual(1);
    expect(data.issues.some((i) => i.message.includes("circular"))).toBe(true);
  });
});

describe("graph command", () => {
  it("returns expected edges for simple-graph", async () => {
    const { code, data } = await captureJson<{
      edges: Array<{ from: string; to: string }>;
      nodes: Array<{ id: string }>;
      cycles: string[][];
    }>(() => graphCommand({ ...opts(simpleGraph), format: "json" }));

    expect(code).toBe(0);
    const edgeSet = new Set(data.edges.map((e) => `${e.from}->${e.to}`));
    expect(edgeSet.has("src/api.ts->src/order.ts")).toBe(true);
    expect(edgeSet.has("src/order.ts->src/payment.ts")).toBe(true);
    expect(edgeSet.has("src/payment.test.ts->src/payment.ts")).toBe(true);
    expect(data.nodes.some((n) => n.id === "src/payment.ts")).toBe(true);
    expect(data.cycles.length).toBe(0);
  });
});
