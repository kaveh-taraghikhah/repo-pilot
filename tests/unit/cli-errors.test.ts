import { afterEach, describe, expect, it, vi } from "vitest";
import {
  errorMessage,
  failCommand,
  runCommand,
} from "../../src/cli/errors.ts";
import type { OutputOptions } from "../../src/output/types.ts";

const baseOptions = (): OutputOptions => ({
  json: false,
  quiet: false,
  color: false,
  cache: true,
  cwd: process.cwd(),
});

describe("errorMessage", () => {
  it("reads Error.message and stringifies unknowns", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("plain")).toBe("plain");
    expect(errorMessage(42)).toBe("42");
  });
});

describe("failCommand / runCommand", () => {
  const stdoutSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true);
  const stderrSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(() => true);

  afterEach(() => {
    stdoutSpy.mockClear();
    stderrSpy.mockClear();
  });

  it("prints a human error by default", () => {
    const code = failCommand(new Error("nope"), baseOptions());
    expect(code).toBe(1);
    expect(stderrSpy).toHaveBeenCalled();
    expect(String(stderrSpy.mock.calls[0]?.[0])).toContain("nope");
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it("prints JSON when options.json is set", () => {
    const code = failCommand(new Error("nope"), { ...baseOptions(), json: true });
    expect(code).toBe(1);
    expect(stdoutSpy).toHaveBeenCalled();
    const payload = JSON.parse(String(stdoutSpy.mock.calls[0]?.[0]));
    expect(payload).toEqual({ error: "nope" });
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("forces human mode even under --json when requested", () => {
    const code = failCommand(
      new Error("nope"),
      { ...baseOptions(), json: true },
      "human",
    );
    expect(code).toBe(1);
    expect(stderrSpy).toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it("maps thrown errors from runCommand to exit 1", async () => {
    const code = await runCommand(baseOptions(), async () => {
      throw new Error("explode");
    });
    expect(code).toBe(1);
    expect(stderrSpy).toHaveBeenCalled();
  });

  it("returns the body exit code on success", async () => {
    const code = await runCommand(baseOptions(), async () => 0);
    expect(code).toBe(0);
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });
});
