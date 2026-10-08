import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ParsedFile } from "../analyzer/parser.ts";
import { CACHE_SCHEMA_VERSION, type CacheManifest } from "./types.ts";

export function cacheRoot(projectRoot: string): string {
  return join(projectRoot, ".repopilot", "cache");
}

function manifestPath(projectRoot: string): string {
  return join(cacheRoot(projectRoot), "manifest.json");
}

/** Collision-free cache filename derived from the relative path. */
export function fileEntryPath(projectRoot: string, relativePath: string): string {
  const key = createHash("sha256")
    .update(relativePath.replaceAll("\\", "/"))
    .digest("hex")
    .slice(0, 32);
  return join(cacheRoot(projectRoot), "files", `${key}.json`);
}

export async function loadManifest(projectRoot: string): Promise<CacheManifest | null> {
  try {
    const raw = await readFile(manifestPath(projectRoot), "utf8");
    const parsed = JSON.parse(raw) as CacheManifest;
    if (parsed.schemaVersion !== CACHE_SCHEMA_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function saveManifest(
  projectRoot: string,
  manifest: CacheManifest,
): Promise<void> {
  await mkdir(cacheRoot(projectRoot), { recursive: true });
  await writeFile(manifestPath(projectRoot), JSON.stringify(manifest, null, 2), "utf8");
}

export async function loadCachedFile(
  projectRoot: string,
  relativePath: string,
  expectedHash: string,
): Promise<ParsedFile | null> {
  try {
    const raw = await readFile(fileEntryPath(projectRoot, relativePath), "utf8");
    const parsed = JSON.parse(raw) as { hash: string; data: ParsedFile };
    if (parsed.hash !== expectedHash) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

export async function saveCachedFile(
  projectRoot: string,
  relativePath: string,
  hash: string,
  data: ParsedFile,
): Promise<void> {
  const dir = join(cacheRoot(projectRoot), "files");
  await mkdir(dir, { recursive: true });
  await writeFile(
    fileEntryPath(projectRoot, relativePath),
    JSON.stringify({ hash, data }, null, 2),
    "utf8",
  );
}

export async function clearCache(projectRoot: string): Promise<boolean> {
  const root = join(projectRoot, ".repopilot");
  const cache = cacheRoot(projectRoot);
  try {
    await rm(cache, { recursive: true, force: true });
  } catch {
    return false;
  }

  // Remove empty .repopilot if nothing else remains
  try {
    const remaining = await readdir(root);
    if (remaining.length === 0) {
      await rm(root, { recursive: true, force: true });
    }
  } catch {
    // ignore
  }
  return true;
}
