import { $ } from "bun";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const cliOnly = process.argv.includes("--cli-only");

if (cliOnly) {
  // Preserve dist/web from a prior full build (npm publish runs prepare after
  // prepublishOnly; wiping all of dist would drop viewer assets from the tarball).
  mkdirSync("dist", { recursive: true });
  for (const name of [
    "cli.js",
    "cli.js.map",
    "index.js",
    "index.js.map",
  ]) {
    const path = join("dist", name);
    if (existsSync(path)) rmSync(path, { force: true });
  }
} else {
  await $`rm -rf dist`;
}

const result = await Bun.build({
  entrypoints: ["./src/cli.ts", "./src/index.ts"],
  outdir: "./dist",
  target: "node",
  format: "esm",
  sourcemap: "external",
  minify: false,
});

if (!result.success) {
  console.error("Build failed");
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

const cliPath = "./dist/cli.js";
const source = readFileSync(cliPath, "utf8").replace(/^#!.*\n/, "");
writeFileSync(cliPath, `#!/usr/bin/env node\n${source}`);
chmodSync(cliPath, 0o755);

console.log("Built dist/cli.js and dist/index.js");

if (!cliOnly) {
  console.log("Building graph viewer…");
  await $`cd web/graph-viewer && bun install`;
  await $`cd web/graph-viewer && bun run build`;
  console.log("Built dist/web");
}
