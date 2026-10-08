import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { pluginsListCommand } from "../../src/cli/commands/plugins.ts";
import { nextPlugin, listNextRoutes } from "../../src/plugins/builtins/next.ts";
import { createProjectContext } from "../../src/plugins/context.ts";
import { loadPlugins } from "../../src/plugins/loader.ts";
import type { OutputOptions } from "../../src/output/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const nextLite = join(here, "../fixtures/next-lite");
const dockerLite = join(here, "../fixtures/docker-lite");

function opts(cwd: string): OutputOptions {
  return { json: true, quiet: true, color: false, cache: true, cwd };
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

describe("plugins integration", () => {
  it("plugins list --json shows next active on next-lite", async () => {
    const { code, data } = await captureJson<{
      plugins: Array<{ name: string; active: boolean }>;
    }>(() => pluginsListCommand(opts(nextLite)));

    expect(code).toBe(0);
    const next = data.plugins.find((p) => p.name === "next");
    expect(next?.active).toBe(true);
    const docker = data.plugins.find((p) => p.name === "docker");
    expect(docker?.active).toBe(false);
  });

  it("next routes finds fixture pages", async () => {
    const ctx = await createProjectContext(nextLite);
    expect(await nextPlugin.detect(ctx)).toBe(true);
    const routes = listNextRoutes(ctx);
    expect(routes).toEqual(
      expect.arrayContaining(["app/api/hello/route.ts", "app/page.tsx"]),
    );

    const routesCmd = nextPlugin.commands?.find((c) => c.name === "routes");
    expect(routesCmd).toBeDefined();
    const { code, data } = await captureJson<{ routes: string[] }>(() =>
      routesCmd!.run(ctx, opts(nextLite)),
    );
    expect(code).toBe(0);
    expect(data.routes).toEqual(
      expect.arrayContaining(["app/api/hello/route.ts", "app/page.tsx"]),
    );
  });

  it("detects docker plugin on docker-lite", async () => {
    const { registry } = await loadPlugins(dockerLite);
    const docker = registry.list().find((p) => p.name === "docker");
    expect(docker?.active).toBe(true);
    const next = registry.list().find((p) => p.name === "next");
    expect(next?.active).toBe(false);
  });
});
