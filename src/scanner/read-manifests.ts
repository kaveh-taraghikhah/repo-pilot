import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { stripJsonc } from "../cache/fingerprint.ts";

export interface PackageManifest {
  name?: string;
  version?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  engines?: Record<string, string>;
  [key: string]: unknown;
}

export interface ManifestSnapshot {
  packageJson: PackageManifest | null;
  packageJsonError: string | null;
  tsconfig: Record<string, unknown> | null;
  tsconfigError: string | null;
  lockfile: string | null;
  hasNodeModules: boolean;
  envExampleKeys: string[];
  envLocalKeys: string[];
  envKeys: string[];
}

const LOCKFILES = [
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
] as const;

export async function readManifests(root: string): Promise<ManifestSnapshot> {
  const packageResult = await readJsonFile<PackageManifest>(join(root, "package.json"));
  const tsconfigResult = await readJsonFile<Record<string, unknown>>(
    join(root, "tsconfig.json"),
  );

  return {
    packageJson: packageResult.value,
    packageJsonError: packageResult.error,
    tsconfig: tsconfigResult.value,
    tsconfigError: tsconfigResult.error,
    lockfile: detectLockfile(root),
    hasNodeModules: existsSync(join(root, "node_modules")),
    envExampleKeys: await readEnvKeys(join(root, ".env.example")),
    envLocalKeys: await readEnvKeys(join(root, ".env.local")),
    envKeys: await readEnvKeys(join(root, ".env")),
  };
}

function detectLockfile(root: string): string | null {
  for (const name of LOCKFILES) {
    if (existsSync(join(root, name))) return name;
  }
  return null;
}

async function readJsonFile<T>(path: string): Promise<{ value: T | null; error: string | null }> {
  if (!existsSync(path)) {
    return { value: null, error: null };
  }
  try {
    const text = await readFile(path, "utf8");
    // Strip BOM, then JSONC comments / trailing commas without mutating strings.
    const cleaned = stripJsonc(text.replace(/^\uFEFF/, ""));
    return { value: JSON.parse(cleaned) as T, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { value: null, error: message };
  }
}

export async function readEnvKeys(path: string): Promise<string[]> {
  if (!existsSync(path)) return [];
  try {
    const text = await readFile(path, "utf8");
    return parseEnvKeys(text);
  } catch {
    return [];
  }
}

export function parseEnvKeys(text: string): string[] {
  const keys: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (match) keys.push(match[1]);
  }
  return keys;
}

export function missingEnvKeys(
  required: string[],
  defined: Iterable<string>,
): string[] {
  const have = new Set(defined);
  return required.filter((key) => !have.has(key));
}

export function hasTypeScriptDependency(pkg: PackageManifest | null): boolean {
  if (!pkg) return false;
  return Boolean(
    pkg.dependencies?.typescript ||
      pkg.devDependencies?.typescript ||
      pkg.peerDependencies?.typescript,
  );
}
