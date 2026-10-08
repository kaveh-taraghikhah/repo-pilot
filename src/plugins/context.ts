import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config/loader.ts";
import { readManifests } from "../scanner/read-manifests.ts";
import { scanFiles } from "../scanner/scan-files.ts";
import type { ProjectContext } from "./types.ts";

export async function createProjectContext(root: string): Promise<ProjectContext> {
  const config = await loadConfig(root);
  const [manifests, scan] = await Promise.all([
    readManifests(root),
    scanFiles(root, config.ignore ?? []),
  ]);

  return {
    root,
    packageJson: (manifests.packageJson as Record<string, unknown> | null) ?? null,
    files: scan.files.map((f) => f.relativePath),
  };
}

export function hasDependency(
  pkg: Record<string, unknown> | null,
  name: string,
): boolean {
  if (!pkg) return false;
  const deps = {
    ...(pkg.dependencies as Record<string, string> | undefined),
    ...(pkg.devDependencies as Record<string, string> | undefined),
    ...(pkg.peerDependencies as Record<string, string> | undefined),
  };
  return Object.hasOwn(deps, name);
}

export function hasRootFile(root: string, names: string[]): boolean {
  return names.some((name) => existsSync(join(root, name)));
}
