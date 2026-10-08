import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

/**
 * `realpath` when the path exists. When missing, realpath the longest existing
 * parent prefix and rejoin the missing suffix — so deleted files under in-repo
 * directory symlinks (`alias/b.ts` → `src/b.ts`) still canonicalize.
 */
export function canonicalizePath(path: string): string {
  const abs = resolve(path);
  try {
    return realpathSync(abs);
  } catch {
    const missing: string[] = [];
    let current = abs;
    for (;;) {
      const parent = dirname(current);
      if (parent === current) {
        return abs;
      }
      missing.unshift(basename(current));
      try {
        return join(realpathSync(parent), ...missing);
      } catch {
        current = parent;
      }
    }
  }
}

/**
 * True when a `path.relative()` result escapes its root.
 * Names like `..foo.ts` are allowed; `..` / `../…` are not.
 */
export function isEscapingRelative(rel: string): boolean {
  const n = rel.replaceAll("\\", "/");
  return n === ".." || n.startsWith("../") || isAbsolute(rel);
}

/**
 * Repo-relative POSIX path after canonicalization.
 * Relative `input` is resolved against `cwd` (default: project root).
 * Returns `null` when the result escapes the project root.
 */
export function toCanonicalRepoRelative(
  root: string,
  input: string,
  cwd: string = root,
): string | null {
  const canonRoot = canonicalizePath(root);
  const abs = isAbsolute(input) ? resolve(input) : resolve(cwd, input);
  const canonAbs = canonicalizePath(abs);
  const rel = relative(canonRoot, canonAbs).replaceAll("\\", "/");
  if (!rel || rel === ".") return null;
  if (isEscapingRelative(rel)) return null;
  return rel;
}
