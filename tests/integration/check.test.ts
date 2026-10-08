import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkCommand } from "../../src/cli/commands/check.ts";
import type { CheckResult } from "../../src/output/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const violation = join(here, "../fixtures/architecture-violation");
const ok = join(here, "../fixtures/architecture-ok");

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

describe("check command", () => {
  it("fails on architecture-violation fixture", async () => {
    const { code, data } = await captureJson<CheckResult>(() =>
      checkCommand({
        json: true,
        quiet: true,
        color: false,
        cache: true,
        cwd: violation,
        skipScripts: true,
      }),
    );

    expect(code).toBe(1);
    expect(data.passed).toBe(false);
    expect(data.architecture.violations.length).toBeGreaterThanOrEqual(1);
    expect(data.architecture.violations[0]?.rule).toBe("api-cannot-import-database");
    expect(data.architecture.violations[0]?.from).toContain("src/api/");
    expect(data.architecture.violations[0]?.to).toContain("src/repositories/");
  });

  it("passes on architecture-ok fixture", async () => {
    const { code, data } = await captureJson<CheckResult>(() =>
      checkCommand({
        json: true,
        quiet: true,
        color: false,
        cache: true,
        cwd: ok,
        skipScripts: true,
      }),
    );

    expect(code).toBe(0);
    expect(data.passed).toBe(true);
    expect(data.architecture.violations).toHaveLength(0);
    expect(data.architecture.rulesEvaluated).toBe(1);
  });
});
