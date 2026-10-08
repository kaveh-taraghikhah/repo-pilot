import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { loadConfig } from "../config/loader.ts";
import { isEscapingRelative } from "../path-utils.ts";
import { dockerPlugin } from "./builtins/docker.ts";
import { nextPlugin } from "./builtins/next.ts";
import { testRunnerPlugin } from "./builtins/test-runner.ts";
import { createProjectContext } from "./context.ts";
import { PluginRegistry } from "./registry.ts";
import type { ProjectContext, RepoPilotPlugin } from "./types.ts";

export async function loadPlugins(root: string): Promise<{
  registry: PluginRegistry;
  context: ProjectContext;
  warnings: string[];
}> {
  const registry = new PluginRegistry();
  const context = await createProjectContext(root);
  const config = await loadConfig(root);
  const warnings: string[] = [];

  const builtins: RepoPilotPlugin[] = [nextPlugin, dockerPlugin, testRunnerPlugin];
  for (const plugin of builtins) {
    registry.register(plugin, { builtin: true });
  }

  for (const spec of config.plugins ?? []) {
    const loaded = await loadExternalPlugin(root, spec);
    if (loaded.warning) warnings.push(loaded.warning);
    if (!loaded.plugin) continue;
    const result = registry.register(loaded.plugin, { builtin: false });
    if (!result.ok && result.reason) warnings.push(result.reason);
  }

  for (const entry of registry.list()) {
    const plugin = registry.get(entry.name);
    if (!plugin) continue;
    try {
      const active = await plugin.detect(context);
      registry.markActive(plugin.name, Boolean(active));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`Plugin "${plugin.name}" detect() failed: ${msg}`);
      registry.markActive(plugin.name, false);
    }
  }

  return { registry, context, warnings };
}

async function loadExternalPlugin(
  root: string,
  spec: string,
): Promise<{ plugin: RepoPilotPlugin | null; warning?: string }> {
  try {
    const resolved = isAbsolute(spec) ? resolve(spec) : resolve(root, spec);
    if (!existsSync(resolved)) {
      return {
        plugin: null,
        warning: `Plugin not found: ${spec}`,
      };
    }

    let realRoot: string;
    let realPlugin: string;
    try {
      realRoot = realpathSync(root);
      realPlugin = realpathSync(resolved);
    } catch {
      return {
        plugin: null,
        warning: `Plugin path could not be resolved: ${spec}`,
      };
    }

    const rel = relative(realRoot, realPlugin);
    if (isEscapingRelative(rel)) {
      return {
        plugin: null,
        warning: `Plugin path escapes project root (skipped): ${spec}`,
      };
    }

    const mod = (await importPluginModule(realPlugin)) as {
      default?: RepoPilotPlugin;
      plugin?: RepoPilotPlugin;
    };
    const plugin = mod.default ?? mod.plugin;
    if (!plugin || typeof plugin.name !== "string" || typeof plugin.detect !== "function") {
      return {
        plugin: null,
        warning: `Plugin at ${spec} is missing a valid default/plugin export`,
      };
    }
    return { plugin };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      plugin: null,
      warning: `Failed to load plugin ${spec}: ${msg}`,
    };
  }
}

const TS_SPECIFIER_EXT = /\.[cm]?[jt]sx?$/i;

/**
 * Import a plugin module. TypeScript sources are transpiled beside the source
 * file so relative imports and `import.meta.url` resolve against the plugin
 * directory (not a system temp dir). Relative `.ts`/`.tsx`/`.mts`/`.cts`
 * imports are rewritten to sibling `.repopilot.*.mjs` artifacts so Node can load them.
 */
export async function importPluginModule(
  absolutePath: string,
): Promise<Record<string, unknown>> {
  const lower = absolutePath.toLowerCase();
  const isTs =
    lower.endsWith(".ts") ||
    lower.endsWith(".mts") ||
    lower.endsWith(".tsx") ||
    lower.endsWith(".cts");

  if (!isTs) {
    return (await import(pathToFileURL(absolutePath).href)) as Record<string, unknown>;
  }

  const emitted = new Map<string, string>();
  const outPath = transpilePluginTs(absolutePath, emitted);
  return (await import(pathToFileURL(outPath).href)) as Record<string, unknown>;
}

function transpilePluginTs(
  absolutePath: string,
  emitted: Map<string, string>,
): string {
  const existing = emitted.get(absolutePath);
  if (existing) return existing;

  const source = readFileSync(absolutePath, "utf8");
  const hash = createHash("sha256").update(source).digest("hex").slice(0, 12);
  const dir = dirname(absolutePath);
  const stem = basename(absolutePath).replace(/\.[cm]?[jt]sx?$/i, "");
  const outPath = join(dir, `${stem}.repopilot.${hash}.mjs`);
  // Mark before rewriting imports so cycles don't recurse forever.
  emitted.set(absolutePath, outPath);

  let { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.ReactJSX,
    },
    fileName: absolutePath,
  });

  outputText = rewriteRelativeTsImports(outputText, absolutePath, emitted);
  writeFileSync(outPath, outputText, "utf8");
  cleanupStalePluginArtifacts(dir, stem, outPath);
  return outPath;
}

/**
 * Rewrite relative TypeScript specifiers in emitted ESM to point at transpiled
 * `.repopilot.*.mjs` siblings (and transpile those deps).
 */
function rewriteRelativeTsImports(
  code: string,
  fromFile: string,
  emitted: Map<string, string>,
): string {
  return code.replace(
    /\b((?:import|export)\s+(?:[^"'();]+?\s+from\s+)?|import\s*\(\s*)(["'])(\.[^"']+)\2/g,
    (full, prefix: string, quote: string, spec: string) => {
      if (!TS_SPECIFIER_EXT.test(spec)) return full;
      const target = resolve(dirname(fromFile), spec);
      if (!existsSync(target)) return full;
      const artifact = transpilePluginTs(target, emitted);
      let rel = relative(dirname(fromFile), artifact).replaceAll("\\", "/");
      if (!rel.startsWith(".")) rel = `./${rel}`;
      return `${prefix}${quote}${rel}${quote}`;
    },
  );
}

export function cleanupStalePluginArtifacts(
  dir: string,
  stem: string,
  keepPath: string,
): void {
  const prefix = `${stem}.repopilot.`;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(prefix) || !name.endsWith(".mjs")) continue;
    const full = join(dir, name);
    if (full === keepPath) continue;
    try {
      unlinkSync(full);
    } catch {
      // ignore
    }
  }
}
