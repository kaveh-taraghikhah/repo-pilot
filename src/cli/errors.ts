import { printJson } from "../output/json.ts";
import { printError } from "../output/terminal.ts";
import type { OutputOptions } from "../output/types.ts";

/** Normalize thrown values to a printable message. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type CommandErrorMode = "auto" | "json" | "human";

/**
 * Shared failure path for CLI commands: print `{ error }` JSON or a human
 * error line, then return exit code 1.
 */
export function failCommand(
  error: unknown,
  options: OutputOptions,
  mode: CommandErrorMode = "auto",
): 1 {
  const message = errorMessage(error);
  const asJson =
    mode === "json" || (mode === "auto" && Boolean(options.json));

  if (asJson) {
    printJson({ error: message });
  } else {
    printError(message, options);
  }
  return 1;
}

/** Run a command body and map any throw to `failCommand`. */
export async function runCommand(
  options: OutputOptions,
  body: () => Promise<number>,
  mode: CommandErrorMode = "auto",
): Promise<number> {
  try {
    return await body();
  } catch (error) {
    return failCommand(error, options, mode);
  }
}
