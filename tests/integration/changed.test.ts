import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { changedCommand } from "../../src/cli/commands/changed.ts";
import type { ChangedResult } from "../../src/output/types.ts";

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
  });
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

describe("changed command integration", () => {
  let repo: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "repopilot-git-"));
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "RepoPilot Test"]);
    // Default branch name
    git(repo, ["checkout", "-b", "main"]);

    write(
      repo,
      "package.json",
      JSON.stringify({ name: "git-changed-fixture", private: true, type: "module" }),
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
    write(repo, "README.md", "# fixture\n");

    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "initial"]);

    // Feature branch with committed change
    git(repo, ["checkout", "-b", "feature/payment-retry"]);
    write(
      repo,
      "src/payment.ts",
      `export function charge(amount: number): number {\n  return amount * 2;\n}\n`,
    );
    write(repo, "README.md", "# fixture\n\nupdated\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "payment retry"]);

    // Local uncommitted edit
    write(
      repo,
      "src/order.ts",
      `import { charge } from "./payment";\nexport function placeOrder(n: number) {\n  return charge(n) + 1;\n}\n`,
    );
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("reports working-tree changes as JSON", async () => {
    const { code, data } = await captureJson<ChangedResult>(() =>
      changedCommand({
        json: true,
        quiet: true,
        color: false,
        cache: true,
        cwd: repo,
      }),
    );

    expect(code).toBe(0);
    expect(data.branch).toBe("feature/payment-retry");
    expect(data.since).toBeNull();
    expect(data.files.some((f) => f.path === "src/order.ts")).toBe(true);
    expect(data.summary.total).toBeGreaterThanOrEqual(1);
  });

  it("includes committed delta with --since main", async () => {
    const { code, data } = await captureJson<ChangedResult>(() =>
      changedCommand({
        json: true,
        quiet: true,
        color: false,
        cache: true,
        cwd: repo,
        since: "main",
      }),
    );

    expect(code).toBe(0);
    expect(data.since).toBe("main");
    const paths = data.files.map((f) => f.path);
    expect(paths).toEqual(expect.arrayContaining(["src/payment.ts", "README.md", "src/order.ts"]));

    const readme = data.files.find((f) => f.path === "README.md");
    expect(readme?.impact).toBe("low");

    const payment = data.files.find((f) => f.path === "src/payment.ts");
    expect(payment).toBeTruthy();
    expect(["high", "medium"]).toContain(payment!.impact);
  });

  it("rejects invalid --since refs with a clear error", async () => {
    const { code, data } = await captureJson<{ error: string }>(() =>
      changedCommand({
        json: true,
        quiet: true,
        color: false,
        cache: true,
        cwd: repo,
        since: "definitely-not-a-ref-zz",
      }),
    );

    expect(code).toBe(1);
    expect(data.error).toMatch(/Invalid --since ref/);
  });
});
