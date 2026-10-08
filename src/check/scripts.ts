import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export type ScriptStatus = "pass" | "fail" | "skip";

export interface ScriptCheckResult {
  name: string;
  status: ScriptStatus;
  command?: string;
  message?: string;
}

const CANDIDATES: Array<{ name: string; keys: string[]; label: string }> = [
  { name: "typecheck", keys: ["typecheck", "tsc"], label: "TypeScript" },
  { name: "lint", keys: ["lint"], label: "Lint" },
  { name: "test", keys: ["test"], label: "Unit tests" },
];

export function discoverScripts(packageScripts: Record<string, string>): Array<{
  name: string;
  scriptKey: string;
  label: string;
}> {
  const found: Array<{ name: string; scriptKey: string; label: string }> = [];
  for (const cand of CANDIDATES) {
    const key = cand.keys.find((k) => k in packageScripts);
    if (key) found.push({ name: cand.name, scriptKey: key, label: cand.label });
  }
  return found;
}

export function classifyScriptSpawnError(error: NodeJS.ErrnoException): {
  status: ScriptStatus;
  message: string;
} {
  const overflow =
    error.code === "ENOBUFS" || /maxBuffer|ENOBUFS/i.test(error.message);
  return {
    // Overflow kills the child before we observe exit status — do not
    // treat that as a script failure (would fail CI incorrectly).
    status: overflow ? "skip" : "fail",
    message: overflow
      ? "script output exceeded buffer limit; run it directly to verify"
      : error.message,
  };
}

export async function runProjectScripts(
  root: string,
): Promise<ScriptCheckResult[]> {
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) return [];

  let scripts: Record<string, string> = {};
  try {
    const raw = JSON.parse(await readFile(pkgPath, "utf8")) as {
      scripts?: Record<string, string>;
    };
    scripts = raw.scripts ?? {};
  } catch {
    return [];
  }

  const discovered = discoverScripts(scripts);
  const runner = resolveRunner();
  const results: ScriptCheckResult[] = [];

  for (const item of discovered) {
    const command = `${runner} ${item.scriptKey}`;
    const result = spawnSync(
      runner === "bun run" ? "bun" : "npm",
      runner === "bun run" ? ["run", item.scriptKey] : ["run", item.scriptKey],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, CI: "1", FORCE_COLOR: "0" },
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 10 * 1024 * 1024,
      },
    );

    if (result.error) {
      const classified = classifyScriptSpawnError(
        result.error as NodeJS.ErrnoException,
      );
      results.push({
        name: item.label,
        status: classified.status,
        command,
        message: classified.message,
      });
      continue;
    }

    if (result.status === 0) {
      results.push({
        name: item.label,
        status: "pass",
        command,
      });
    } else {
      const stderr = (result.stderr ?? "").trim();
      results.push({
        name: item.label,
        status: "fail",
        command,
        message: stderr.split("\n").slice(0, 5).join("\n") || `exit ${result.status}`,
      });
    }
  }

  return results;
}

function resolveRunner(): "bun run" | "npm run" {
  const bun = spawnSync("bun", ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return bun.status === 0 ? "bun run" : "npm run";
}
