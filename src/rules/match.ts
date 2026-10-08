import { minimatch } from "minimatch";

export function matchesGlob(path: string, pattern: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  const pat = pattern.replaceAll("\\", "/");
  return minimatch(normalized, pat, { dot: true });
}

export function matchesAnyGlob(path: string, patterns: string[]): boolean {
  return patterns.some((p) => matchesGlob(path, p));
}
