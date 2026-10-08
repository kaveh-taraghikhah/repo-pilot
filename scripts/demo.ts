#!/usr/bin/env bun
/**
 * Fixture walkthrough — runs RepoPilot against checked-in fixtures so output
 * is reproducible without a dirty worktree.
 *
 *   bun run demo
 */
import { $ } from "bun";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const cli = resolve(root, "src/cli.ts");

function banner(title: string) {
  const line = "─".repeat(Math.max(8, title.length + 2));
  console.log(`\n${line}\n ${title}\n${line}\n`);
}

async function run(label: string, args: string[]) {
  banner(label);
  const result = await $`bun ${cli} ${args}`.cwd(root).nothrow().quiet();
  const out = Buffer.concat([result.stdout, result.stderr]).toString("utf8").trimEnd();
  if (out) console.log(out);
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    // 1 is an expected "check failed" / non-zero doctor style exit for demos
    console.error(`\n(command exited ${result.exitCode})`);
  }
}

console.log("RepoPilot demo — fixture walkthrough");
console.log(`repo: ${root}`);

await run("1. Impact on simple-graph (payment.ts)", [
  "impact",
  "src/payment.ts",
  "--cwd",
  "tests/fixtures/simple-graph",
  "--no-color",
]);

await run("2. Dependency graph (text)", [
  "graph",
  "--cwd",
  "tests/fixtures/simple-graph",
  "--no-color",
]);

await run("3. Architecture violation (expected FAIL)", [
  "check",
  "--skip-scripts",
  "--cwd",
  "tests/fixtures/architecture-violation",
  "--no-color",
]);

await run("4. Doctor on healthy-project", [
  "doctor",
  "--cwd",
  "tests/fixtures/healthy-project",
  "--no-color",
]);

banner("Next");
console.log(`Interactive graph viewer:
  bun run build:web
  bun src/cli.ts graph --serve --cwd tests/fixtures/simple-graph

Point at your own repo:
  bun src/cli.ts impact
  bun src/cli.ts impact path/to/file.ts
`);
