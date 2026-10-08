import type { OutputOptions } from "./types.ts";

export function printJson(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

export function shouldEmitHuman(options: OutputOptions): boolean {
  return !options.json && !options.quiet;
}
