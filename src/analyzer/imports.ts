import ts from "typescript";
import { existsSync } from "node:fs";
import { isAbsolute, join, normalize as pathNormalize, relative, resolve } from "node:path";
import { canonicalizePath, toCanonicalRepoRelative } from "../path-utils.ts";
import { isProjectSourceFile, toPosixRelative } from "./program.ts";

export interface ResolvedImport {
  fromFile: string;
  specifier: string;
  resolvedPath: string | null;
  external: boolean;
  kind: "import" | "reexport" | "require" | "dynamic";
}

export function extractImports(
  sourceFile: ts.SourceFile,
  root: string,
  compilerOptions: ts.CompilerOptions,
): ResolvedImport[] {
  const fromFile = toPosixRelative(root, sourceFile.fileName);
  const results: ResolvedImport[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      results.push(
        resolveSpecifier(fromFile, node.moduleSpecifier.text, "import", sourceFile, root, compilerOptions),
      );
    }

    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      results.push(
        resolveSpecifier(fromFile, node.moduleSpecifier.text, "reexport", sourceFile, root, compilerOptions),
      );
    }

    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      results.push(
        resolveSpecifier(
          fromFile,
          node.arguments[0].text,
          "dynamic",
          sourceFile,
          root,
          compilerOptions,
        ),
      );
    }

    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      results.push(
        resolveSpecifier(
          fromFile,
          node.arguments[0].text,
          "require",
          sourceFile,
          root,
          compilerOptions,
        ),
      );
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return results;
}

function resolveSpecifier(
  fromFile: string,
  specifier: string,
  kind: ResolvedImport["kind"],
  sourceFile: ts.SourceFile,
  root: string,
  compilerOptions: ts.CompilerOptions,
): ResolvedImport {
  // Always try the compiler first so tsconfig `paths` aliases (e.g. `@/…`) resolve.
  const resolved = tryResolveWithCompiler(specifier, sourceFile, root, compilerOptions);
  if (resolved) {
    return {
      fromFile,
      specifier,
      resolvedPath: resolved,
      external: false,
      kind,
    };
  }

  if (isBareSpecifier(specifier)) {
    return {
      fromFile,
      specifier,
      resolvedPath: null,
      external: true,
      kind,
    };
  }

  return {
    fromFile,
    specifier,
    resolvedPath: null,
    external: false,
    kind,
  };
}

function tryResolveWithCompiler(
  specifier: string,
  sourceFile: ts.SourceFile,
  root: string,
  compilerOptions: ts.CompilerOptions,
): string | null {
  const result = ts.resolveModuleName(
    specifier,
    sourceFile.fileName,
    compilerOptions,
    ts.sys,
  );

  const resolved = result.resolvedModule?.resolvedFileName;
  if (!resolved) return null;
  if (resolved.includes("/node_modules/") || resolved.includes("\\node_modules\\")) {
    return null;
  }

  const fake = {
    fileName: resolved,
    isDeclarationFile: resolved.endsWith(".d.ts"),
  } as ts.SourceFile;
  if (!isProjectSourceFile(fake, root)) {
    return null;
  }

  return toPosixRelative(root, resolved);
}

export function isBareSpecifier(specifier: string): boolean {
  return !(
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier.startsWith("/") ||
    specifier.startsWith("#")
  );
}

/** Node builtins (and common subpath roots) that must never match via baseUrl. */
const NODE_BUILTIN_ROOTS = new Set([
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "domain",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "stream",
  "string_decoder",
  "sys",
  "timers",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
]);

/** Common packages with subpath imports — never treat as baseUrl locals. */
const COMMON_PACKAGE_ROOTS = new Set([
  "next",
  "react",
  "react-dom",
  "react-native",
  "lodash",
  "lodash-es",
  "express",
  "vue",
  "nuxt",
  "svelte",
  "rxjs",
  "firebase",
  "axios",
  "zod",
  "date-fns",
  "moment",
  "jquery",
  "webpack",
  "vite",
  "vitest",
  "jest",
  "chai",
  "mocha",
  "typescript",
  "tslib",
  "ts-node",
  "esbuild",
  "rollup",
  "prisma",
  "graphql",
  "apollo-client",
  "redux",
  "zustand",
  "mobx",
  "three",
  "d3",
  "chart.js",
  "socket.io",
  "ws",
  "undici",
  "node-fetch",
  "uuid",
  "nanoid",
  "chalk",
  "commander",
  "yargs",
  "minimatch",
  "glob",
  "rimraf",
  "semver",
  "debug",
  "ms",
  "picocolors",
]);

export function looksLikeExternalPackage(
  specifier: string,
  root: string,
  baseUrl?: string | null,
): boolean {
  if (specifier.startsWith("node:") || specifier.startsWith("@")) return true;
  const first = specifier.split("/")[0] ?? "";
  if (!first) return true;
  if (NODE_BUILTIN_ROOTS.has(first)) return true;
  if (COMMON_PACKAGE_ROOTS.has(first)) return true;
  try {
    if (existsSync(join(root, "node_modules", first))) return true;
  } catch {
    // ignore
  }
  // Multi-segment bare imports are packages unless the first segment exists
  // as a local directory under baseUrl/root (project-relative path mapping).
  if (specifier.includes("/")) {
    for (const base of [baseUrl, root]) {
      if (!base) continue;
      try {
        if (existsSync(join(base, first))) return false;
      } catch {
        // ignore
      }
    }
    return true;
  }
  return false;
}

/**
 * Whether a bare/alias/# specifier would map to `seed` via compilerOptions.paths,
 * package.json `imports`, or baseUrl (when the target file is deleted).
 */
export function aliasMapsToSeed(
  specifier: string,
  seed: string,
  compilerOptions: ts.CompilerOptions,
  root: string,
  packageImports?: Record<string, unknown> | null,
  /** Live modules — used to avoid matching a deleted seed when a sibling still exists. */
  liveFiles?: ReadonlySet<string> | null,
): boolean {
  if (!isBareSpecifier(specifier) && !specifier.startsWith("#")) {
    return false;
  }

  // Canonicalize seed so alias/… (symlink) and src/… (realpath) compare equal.
  const seedNorm = (
    toCanonicalRepoRelative(root, seed) ??
    seed.replaceAll("\\", "/").replace(/^\.\//, "")
  ).replace(/^\.\//, "");
  const seedStem = seedNorm.replace(/\.[cm]?[jt]sx?$/, "");
  const matchesSeed = (rel: string): boolean =>
    relMatchesSeed(rel, seedNorm, seedStem, liveFiles);

  // package.json "imports" is the primary mechanism for `#…` subpaths.
  // Node resolves these relative to the package root only (not baseUrl).
  if (specifier.startsWith("#") && packageImports && Object.keys(packageImports).length > 0) {
    const matches = collectPatternMatches(packageImports, specifier);
    if (matches.length > 0) {
      const best = pickMostSpecific(matches);
      for (const raw of flattenImportTargets(best.target)) {
        const expanded = raw.replace(/\*/g, best.capture).replace(/^\.\//, "");
        const abs = isAbsolute(expanded) ? expanded : resolve(root, expanded);
        if (matchesSeed(repoRelativeCanonical(root, abs))) {
          return true;
        }
      }
      return false;
    }
  }

  const baseUrl = compilerOptions.baseUrl
    ? resolve(root, compilerOptions.baseUrl)
    : null;

  const paths = compilerOptions.paths;
  if (paths && Object.keys(paths).length > 0) {
    const pathBase = baseUrl ?? root;
    const matches = collectPatternMatches(paths as Record<string, unknown>, specifier);
    if (matches.length > 0) {
      const best = pickMostSpecific(matches);
      const targets = Array.isArray(best.target)
        ? best.target.filter((t): t is string => typeof t === "string")
        : flattenImportTargets(best.target);
      for (const target of targets) {
        const expanded = target.replace(/\*/g, best.capture);
        const abs = isAbsolute(expanded) ? expanded : resolve(pathBase, expanded);
        if (matchesSeed(repoRelativeCanonical(root, abs))) {
          return true;
        }
      }
      // Most-specific match wins over baseUrl even when no target hits the seed.
      return false;
    }
  }

  // baseUrl fallback for project-relative bare imports (`helpers`, `utils/foo`),
  // never for packages/builtins (`fs/promises`, `next/nav`, `@scope/x`).
  if (
    baseUrl &&
    !specifier.startsWith("#") &&
    !looksLikeExternalPackage(specifier, root, baseUrl)
  ) {
    // Single-segment: only treat as local when the seed clearly lives under baseUrl
    // at that name (deleted file), or a same-named path still exists on disk.
    if (!specifier.includes("/")) {
      const seedAbs = canonicalizePath(resolve(root, seedNorm));
      const seedRel = relative(canonicalizePath(baseUrl), seedAbs).replaceAll("\\", "/");
      if (seedRel.startsWith("..")) {
        // seed outside baseUrl
      } else {
        const seedStemRel = seedRel.replace(/\.[cm]?[jt]sx?$/, "");
        const localExists =
          existsSync(join(baseUrl, specifier)) ||
          existsSync(join(baseUrl, `${specifier}.ts`)) ||
          existsSync(join(baseUrl, `${specifier}.tsx`)) ||
          existsSync(join(baseUrl, `${specifier}.js`));
        if (
          !localExists &&
          seedStemRel !== specifier &&
          seedStemRel !== `${specifier}/index`
        ) {
          return false;
        }
      }
    }
    const abs = resolve(baseUrl, specifier);
    if (matchesSeed(repoRelativeCanonical(root, abs))) {
      return true;
    }
  }

  return false;
}

/** Canonical repo-relative path for alias targets (follows in-tree symlink prefixes). */
function repoRelativeCanonical(root: string, abs: string): string {
  return (
    toCanonicalRepoRelative(root, abs) ??
    relative(canonicalizePath(root), canonicalizePath(abs)).replaceAll("\\", "/")
  );
}

function flattenImportTargets(target: unknown): string[] {
  if (typeof target === "string") return [target];
  if (!target || typeof target !== "object") return [];
  const out: string[] = [];
  for (const value of Object.values(target as Record<string, unknown>)) {
    if (typeof value === "string") out.push(value);
    else if (value && typeof value === "object") {
      out.push(...flattenImportTargets(value));
    }
  }
  return out;
}

interface PatternMatch {
  pattern: string;
  capture: string;
  target: unknown;
  specificity: number;
}

function collectPatternMatches(
  map: Record<string, unknown>,
  specifier: string,
): PatternMatch[] {
  const out: PatternMatch[] = [];
  for (const [pattern, target] of Object.entries(map)) {
    const capture = matchPathPattern(pattern, specifier);
    if (capture === null) continue;
    out.push({
      pattern,
      capture,
      target,
      specificity: patternSpecificity(pattern, capture),
    });
  }
  return out;
}

function pickMostSpecific(matches: PatternMatch[]): PatternMatch {
  return [...matches].sort((a, b) => b.specificity - a.specificity)[0]!;
}

/** Higher = more specific (exact > longer literal prefix). */
function patternSpecificity(pattern: string, capture: string): number {
  if (!pattern.includes("*")) return 1_000_000 + pattern.length;
  const prefixLen = (pattern.split("*")[0] ?? "").length;
  return prefixLen * 1_000 + pattern.length - capture.length;
}

function relMatchesSeed(
  rel: string,
  seedNorm: string,
  seedStem: string,
  liveFiles?: ReadonlySet<string> | null,
): boolean {
  const normalizedRel = pathNormalize(rel).replaceAll("\\", "/");

  // Mapping target is already the full seed path (e.g. `#payment` → `src/payment.ts`).
  // A sibling cannot satisfy that exact target.
  if (normalizedRel === seedNorm) return true;

  const candidates = [
    normalizedRel,
    `${normalizedRel}.ts`,
    `${normalizedRel}.tsx`,
    `${normalizedRel}.js`,
    `${normalizedRel}.jsx`,
    `${normalizedRel}.mts`,
    `${normalizedRel}.cts`,
    join(normalizedRel, "index.ts").replaceAll("\\", "/"),
    join(normalizedRel, "index.tsx").replaceAll("\\", "/"),
    join(normalizedRel, "index.js").replaceAll("\\", "/"),
  ].map((c) => pathNormalize(c).replaceAll("\\", "/"));

  const exactHit = candidates.some((c) => c === seedNorm);
  const stemHit = candidates.some(
    (c) => c.replace(/\.[cm]?[jt]sx?$/, "") === seedStem,
  );
  if (!exactHit && !stemHit) return false;

  const siblingBlocks = liveFiles
    ? (() => {
        const indexUnderSeed = `${seedStem}/index`;
        const seedIsIndex = seedStem.endsWith("/index");
        const fileStemForIndexSeed = seedIsIndex
          ? seedStem.slice(0, -"/index".length)
          : null;
        for (const live of liveFiles) {
          const liveNorm = live.replaceAll("\\", "/");
          if (liveNorm === seedNorm) continue;
          const liveStem = liveNorm.replace(/\.[cm]?[jt]sx?$/, "");
          if (
            liveStem === seedStem ||
            liveStem === indexUnderSeed ||
            (fileStemForIndexSeed !== null && liveStem === fileStemForIndexSeed)
          ) {
            return true;
          }
        }
        return false;
      })()
    : false;

  // Exact candidate for the seed: live seeds always match (twin present is OK);
  // deleted seeds still apply the sibling veto.
  if (exactHit) {
    return Boolean(liveFiles?.has(seedNorm)) || !siblingBlocks;
  }

  // Stem-only (mapping landed on a twin path): never attribute to a live seed.
  return !liveFiles?.has(seedNorm) && !siblingBlocks;
}

/** Match a tsconfig paths pattern like `@/*` against a specifier; returns the `*` capture or "". */
function matchPathPattern(pattern: string, specifier: string): string | null {
  if (!pattern.includes("*")) {
    return pattern === specifier ? "" : null;
  }
  const [prefix, suffix] = pattern.split("*");
  if (!specifier.startsWith(prefix ?? "")) return null;
  if (suffix && !specifier.endsWith(suffix)) return null;
  const start = (prefix ?? "").length;
  const end = suffix ? specifier.length - suffix.length : specifier.length;
  if (end < start) return null;
  return specifier.slice(start, end);
}
