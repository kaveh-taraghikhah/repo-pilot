import { printJson } from "../../output/json.ts";
import { hasDependency, hasRootFile } from "../context.ts";
import type { PluginCommand, ProjectContext, RepoPilotPlugin } from "../types.ts";

function isNextRouteFile(path: string): boolean {
  const p = path.replaceAll("\\", "/");
  if (
    /(^|\/)app\/(?:.+\/)?page\.[cm]?[jt]sx?$/.test(p) ||
    /(^|\/)app\/(?:.+\/)?route\.[cm]?[jt]sx?$/.test(p)
  ) {
    return true;
  }
  // Pages router: skip private files (_app, _document, _error, _middleware, …).
  if (!/(^|\/)pages\/.+\.[cm]?[jt]sx?$/.test(p)) return false;
  const base = p.slice(p.lastIndexOf("/") + 1);
  return !base.startsWith("_");
}

export function listNextRoutes(ctx: ProjectContext): string[] {
  return ctx.files.filter(isNextRouteFile).sort();
}

const routesCommand: PluginCommand = {
  name: "routes",
  description: "List Next.js app/pages routes",
  async run(ctx, options) {
    const routes = listNextRoutes(ctx);
    if (options.json) {
      printJson({ plugin: "next", routes });
    } else if (!options.quiet) {
      process.stdout.write(`\nNext.js routes (${routes.length})\n\n`);
      if (routes.length === 0) {
        process.stdout.write("  (none found)\n\n");
      } else {
        for (const route of routes) {
          process.stdout.write(`  ${route}\n`);
        }
        process.stdout.write("\n");
      }
    }
    return 0;
  },
};

export const nextPlugin: RepoPilotPlugin = {
  name: "next",
  detect(ctx) {
    if (hasDependency(ctx.packageJson, "next")) return true;
    return hasRootFile(ctx.root, [
      "next.config.js",
      "next.config.mjs",
      "next.config.cjs",
      "next.config.ts",
    ]);
  },
  commands: [routesCommand],
};
