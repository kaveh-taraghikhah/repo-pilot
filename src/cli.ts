#!/usr/bin/env bun
import { createProgram } from "./cli/program.ts";

const program = await createProgram();

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 2;
});
