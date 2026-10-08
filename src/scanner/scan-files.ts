import { readdir, realpath, stat } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import { minimatch } from "minimatch";

const DEFAULT_IGNORE = [
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".git",
  ".next",
  ".turbo",
  ".cache",
  ".vercel",
  "out",
  "vendor",
  "**/*.repopilot.*.mjs",
];

export interface ScannedFile {
  absolutePath: string;
  relativePath: string;
  extension: string;
  size: number;
}

export interface ScanResult {
  root: string;
  files: ScannedFile[];
}

export async function scanFiles(
  root: string,
  extraIgnore: string[] = [],
): Promise<ScanResult> {
  const patterns = [...DEFAULT_IGNORE, ...normalizeIgnoreList(extraIgnore)];
  const files: ScannedFile[] = [];
  const seenDirs = new Set<string>();
  const seenFiles = new Set<string>();
  const rootAbs = resolve(root);
  let rootReal = rootAbs;
  try {
    rootReal = await realpath(rootAbs);
  } catch {
    // keep rootAbs
  }

  /** Resolve to realpath and return it only when it stays inside the project root. */
  async function realpathInsideRoot(absPath: string): Promise<string | null> {
    try {
      const real = await realpath(absPath);
      if (!pathInsideRoot(real, rootReal)) return null;
      return real;
    } catch {
      return null;
    }
  }

  async function walk(dir: string): Promise<void> {
    const realDir = await realpathInsideRoot(dir);
    if (!realDir) return;
    if (seenDirs.has(realDir)) return;
    seenDirs.add(realDir);

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        // Still allow scanning known env files at root via dedicated readers;
        // skip hidden dirs/files for general inventory.
        continue;
      }

      const absolutePath = join(dir, entry.name);
      const linkRel = relative(rootAbs, absolutePath).replaceAll("\\", "/");

      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const info = await stat(absolutePath);
          isDir = info.isDirectory();
          isFile = info.isFile();
        } catch {
          continue;
        }
      }

      if (isDir) {
        if (shouldIgnore(linkRel, entry.name, patterns)) continue;
        const real = await realpathInsideRoot(absolutePath);
        if (!real) continue;
        const realRel = relative(rootReal, real).replaceAll("\\", "/");
        if (shouldIgnore(realRel, entry.name, patterns)) continue;
        await walk(absolutePath);
        continue;
      }

      if (!isFile) continue;

      // Jail + canonicalize on realpath so TS resolution paths match scan paths
      // (avoids link-dir/a.ts vs real/a.ts ghost-edge drops).
      const real = await realpathInsideRoot(absolutePath);
      if (!real) continue;
      if (seenFiles.has(real)) continue;

      const realRel = relative(rootReal, real).replaceAll("\\", "/");
      if (
        shouldIgnore(linkRel, entry.name, patterns) ||
        shouldIgnore(realRel, basename(real), patterns)
      ) {
        continue;
      }

      seenFiles.add(real);
      try {
        const info = await stat(real);
        files.push({
          absolutePath: real,
          relativePath: realRel,
          extension: extname(real).toLowerCase(),
          size: info.size,
        });
      } catch {
        // skip unreadable
      }
    }
  }

  await walk(rootAbs);
  return { root: rootReal, files };
}

function pathInsideRoot(path: string, root: string): boolean {
  const normalizedPath = resolve(path).replaceAll("\\", "/");
  const normalizedRoot = resolve(root).replaceAll("\\", "/");
  if (normalizedPath === normalizedRoot) return true;
  const prefix = normalizedRoot.endsWith("/")
    ? normalizedRoot
    : `${normalizedRoot}/`;
  return normalizedPath.startsWith(prefix);
}

/** Coerce ignore config to a string array (avoids spreading a string into chars). */
export function normalizeIgnoreList(extraIgnore: string[] | string | undefined): string[] {
  if (!extraIgnore) return [];
  if (typeof extraIgnore === "string") {
    return extraIgnore.length > 0 ? [extraIgnore] : [];
  }
  if (!Array.isArray(extraIgnore)) return [];
  return extraIgnore.filter((p): p is string => typeof p === "string" && p.length > 0);
}

export function shouldIgnore(
  relativePath: string,
  entryName: string,
  patterns: string[],
): boolean {
  const posix = relativePath.replaceAll("\\", "/");
  for (const pattern of patterns) {
    // Exact basename match (legacy + defaults like node_modules)
    if (pattern === entryName) return true;
    // Path / glob match against full relative path
    if (minimatch(posix, pattern, { dot: true })) return true;
    // Also match when pattern is a path prefix directory
    if (!pattern.includes("*") && !pattern.includes("?") && !pattern.includes("[")) {
      if (posix === pattern || posix.startsWith(`${pattern}/`)) return true;
    }
  }
  return false;
}

export function countByExtension(files: ScannedFile[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const file of files) {
    const key = file.extension || "(none)";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export function isTestFile(relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/");
  if (normalized.includes("/__tests__/") || normalized.startsWith("__tests__/")) {
    return true;
  }
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(normalized);
}

export function isTypeScriptFile(extension: string): boolean {
  return extension === ".ts" || extension === ".tsx" || extension === ".mts" || extension === ".cts";
}

export function isJavaScriptFile(extension: string): boolean {
  return (
    extension === ".js" ||
    extension === ".jsx" ||
    extension === ".mjs" ||
    extension === ".cjs"
  );
}

export function isSourceFile(extension: string): boolean {
  return isTypeScriptFile(extension) || isJavaScriptFile(extension);
}
