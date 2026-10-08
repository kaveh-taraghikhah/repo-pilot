import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { canonicalizePath } from "../path-utils.ts";

/**
 * Walk upward from `start` to find a project root (package.json preferred,
 * then .git). Falls back to the starting directory.
 * Returned path is realpath-canonical when possible so scan/TS/git agree.
 */
export function findProjectRoot(start: string = process.cwd()): string {
  let current = resolve(start);

  while (true) {
    if (existsSync(join(current, "package.json"))) {
      return canonicalizePath(current);
    }
    if (existsSync(join(current, ".git"))) {
      return canonicalizePath(current);
    }
    const parent = dirname(current);
    if (parent === current) {
      return canonicalizePath(resolve(start));
    }
    current = parent;
  }
}

export function isGitRepository(root: string): boolean {
  return existsSync(join(root, ".git"));
}
