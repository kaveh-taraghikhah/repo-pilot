import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { impactCommand } from "../../src/cli/commands/impact.ts";
import type { ImpactResult } from "../../src/output/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const simpleGraph = join(here, "../fixtures/simple-graph");

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

function write(cwd: string, rel: string, contents: string): void {
  const full = join(cwd, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents);
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

describe("impact with explicit file args", () => {
  it("reports dependents for simple-graph payment.ts", async () => {
    const { code, data } = await captureJson<ImpactResult>(() =>
      impactCommand({
        json: true,
        quiet: true,
        color: false,
        cache: true,
        cwd: simpleGraph,
        files: ["src/payment.ts"],
      }),
    );

    expect(code).toBe(0);
    expect(data.changed).toEqual(["src/payment.ts"]);
    expect(data.directDependents).toEqual(["src/order.ts"]);
    expect(data.indirectDependents).toEqual(["src/api.ts"]);
    expect(data.affectedTests).toEqual(expect.arrayContaining(["src/payment.test.ts"]));
    expect(["high", "medium"]).toContain(data.risk);
    expect(data.summary.changed).toBe(1);
    expect(data.suggestedValidation.length).toBeGreaterThan(0);
  });
});

describe("impact with git changes", () => {
  let repo: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "repopilot-impact-"));
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "RepoPilot Test"]);
    git(repo, ["checkout", "-b", "main"]);

    write(
      repo,
      "package.json",
      JSON.stringify({ name: "impact-fixture", private: true, type: "module" }),
    );
    write(
      repo,
      "tsconfig.json",
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
    write(
      repo,
      "src/payment.ts",
      `export function charge(amount: number): number {\n  return amount;\n}\n`,
    );
    write(
      repo,
      "src/order.ts",
      `import { charge } from "./payment";\nexport function placeOrder(n: number) {\n  return charge(n);\n}\n`,
    );
    write(
      repo,
      "src/api.ts",
      `import { placeOrder } from "./order";\nexport function handle(n: number) {\n  return placeOrder(n);\n}\n`,
    );
    write(
      repo,
      "src/payment.test.ts",
      `import { charge } from "./payment";\nexport function testCharge() {\n  return charge(1);\n}\n`,
    );

    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "initial"]);

    write(
      repo,
      "src/payment.ts",
      `export function charge(amount: number): number {\n  return amount * 2;\n}\n`,
    );
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("analyzes dirty worktree via impact --json", async () => {
    const { code, data } = await captureJson<ImpactResult>(() =>
      impactCommand({
        json: true,
        quiet: true,
        color: false,
        cache: true,
        cwd: repo,
      }),
    );

    expect(code).toBe(0);
    expect(data.changed).toEqual(expect.arrayContaining(["src/payment.ts"]));
    expect(data.directDependents).toEqual(["src/order.ts"]);
    expect(data.indirectDependents).toEqual(["src/api.ts"]);
    expect(data.affectedTests).toEqual(expect.arrayContaining(["src/payment.test.ts"]));
    expect(data.risk).toBeTruthy();
  });
});
