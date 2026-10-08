import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type ts from "typescript";
import { loadProjectGraph } from "../analyzer/load-graph.ts";
import {
  aliasMapsToSeed,
  extractImports,
  isBareSpecifier,
  type ResolvedImport,
} from "../analyzer/imports.ts";
import type { ParseResult } from "../analyzer/parser.ts";
import { isProjectSourceFile, toPosixRelative, createProgramForRoot } from "../analyzer/program.ts";
import { loadConfig } from "../config/loader.ts";
import { collectChangedFiles } from "../git/changed.ts";
import { GitError, isGitRepo, runGit } from "../git/exec.ts";
import { assertValidSinceRef } from "../git/since.ts";
import type { ImpactResult } from "../output/types.ts";
import { isEscapingRelative, toCanonicalRepoRelative } from "../path-utils.ts";
import { findProjectRoot } from "../scanner/find-root.ts";
import { isTestFile, scanFiles } from "../scanner/scan-files.ts";
import { diffTouchesExports } from "./exports-changed.ts";
import { computeRisk } from "./risk.ts";
import { collectAffectedTests } from "./tests.ts";
import { buildSuggestedValidation } from "./validation.ts";
import type { ProjectGraph } from "../graph/graph.ts";
import { collectDependents, normalize } from "./walk.ts";

function canonRel(root: string, path: string): string {
  const canon = toCanonicalRepoRelative(root, path);
  if (canon !== null) return canon;
  const norm = normalize(path);
  // Already repo-relative parser paths are fine; do not reintroduce escapes.
  if (!norm || norm === "." || isEscapingRelative(norm) || isAbsolute(norm)) {
    return "";
  }
  return norm;
}

export interface RunImpactOptions {
  cwd: string;
  files?: string[];
  since?: string;
  cache?: boolean;
}

export async function runImpact(options: RunImpactOptions): Promise<ImpactResult> {
  const root = findProjectRoot(options.cwd);
  assertValidSinceRef(root, options.since);
  const seeds = resolveSeeds(root, options.cwd, options.files, options.since);

  if (seeds.length === 0) {
    return emptyResult(seeds);
  }

  const config = await loadConfig(root);
  const scan = await scanFiles(root, config.ignore ?? []);
  const { parsed, graph, stats } = await loadProjectGraph(root, scan.files, {
    cache: options.cache !== false,
  });

  const normalizedSeeds = seeds.map(normalize);
  const graphSeeds = normalizedSeeds.filter((p) => graph.getNode(p));
  const missingSeeds = normalizedSeeds.filter((p) => !graph.getNode(p));

  // Recover direct importers of deleted/renamed-away modules, then walk the
  // live graph from those importers so transitive dependents are included.
  const recoveredDirect: string[] = [];
  const recoveredTests: string[] = [];
  for (const seed of missingSeeds) {
    for (const importer of findImportersOfMissingSeed(parsed, seed)) {
      if (normalizedSeeds.includes(importer)) continue;
      if (isTestFile(importer) || graph.getNode(importer)?.kind === "test") {
        recoveredTests.push(importer);
      } else {
        recoveredDirect.push(importer);
      }
    }
  }
  const recoveredUnique = [...new Set(recoveredDirect)];
  const recoveredTestUnique = [...new Set(recoveredTests)];
  // Walk from test importers too so transitive non-test dependents are found,
  // but keep tests out of directDependents (they belong in affectedTests only).
  const walkFromRecovered = [
    ...new Set([...recoveredUnique, ...recoveredTestUnique]),
  ];
  const recoveredInGraph = walkFromRecovered.filter((id) => graph.getNode(id));
  const recoveredSkipped = walkFromRecovered.filter((id) => !graph.getNode(id));

  const fromGraph = collectDependents(graph, graphSeeds);
  const fromRecovered = collectDependents(graph, recoveredInGraph);

  // Grow the in-graph cone and peel skipped (ignore-listed) importers above it
  // to a fixpoint — alternating ignore→src hops need unbounded rounds until
  // idle (L3 → top → L2 → mid → bridge → gone). Also peek live graphSeeds so
  // modified files surface ignore-listed dependents the same way deleted seeds do.
  const seenForWalk = new Set([
    ...normalizedSeeds,
    ...walkFromRecovered,
  ]);
  const graphCone = new Set<string>([
    ...graphSeeds,
    ...fromGraph.direct,
    ...fromGraph.indirect,
    ...recoveredInGraph,
    ...fromRecovered.direct,
    ...fromRecovered.indirect,
  ]);

  const skippedIndirect: string[] = [];
  /** Skipped modules that directly import a live graph seed (directDependents). */
  const skippedDirectLive = new Set<string>();
  const graphEntries: string[] = [];
  const skippedTests: string[] = [];
  const fromSkippedDirect: string[] = [];
  const fromSkippedIndirect: string[] = [];

  const mergeWalk = (walk: {
    skippedIndirect: string[];
    graphEntries: string[];
    tests: string[];
  }) => {
    for (const id of walk.skippedIndirect) skippedIndirect.push(id);
    for (const id of walk.tests) skippedTests.push(id);
    for (const id of walk.graphEntries) {
      graphEntries.push(id);
      graphCone.add(id);
    }
    if (walk.graphEntries.length === 0) return;
    const deps = collectDependents(graph, walk.graphEntries);
    for (const id of deps.direct) {
      fromSkippedDirect.push(id);
      graphCone.add(id);
    }
    for (const id of deps.indirect) {
      fromSkippedIndirect.push(id);
      graphCone.add(id);
    }
  };

  if (recoveredSkipped.length > 0) {
    mergeWalk(
      walkSkippedImporterChain(
        parsed,
        graph,
        recoveredSkipped,
        seenForWalk,
      ),
    );
  }

  // Direct skipped importers of live seeds — same bucket as recoveredUnique for
  // deleted seeds (directDependents), before the wider cone fixpoint.
  if (graphSeeds.length > 0) {
    const liveDirectSkipped = findSkippedImportersAbove(
      parsed,
      graph,
      graphSeeds,
      seenForWalk,
    );
    for (const id of liveDirectSkipped) {
      if (!isTestFile(id) && graph.getNode(id)?.kind !== "test") {
        skippedDirectLive.add(id);
      }
    }
    if (liveDirectSkipped.length > 0) {
      mergeWalk(
        walkSkippedImporterChain(
          parsed,
          graph,
          liveDirectSkipped,
          seenForWalk,
        ),
      );
    }
  }

  // Fixpoint: each peek can open new graph entries whose dependents need another
  // peek. Runs until idle (seen-set prevents cycles); no fixed-depth cap.
  for (;;) {
    const peek = findSkippedImportersAbove(
      parsed,
      graph,
      [...graphCone],
      seenForWalk,
    );
    if (peek.length === 0) break;
    mergeWalk(
      walkSkippedImporterChain(parsed, graph, peek, seenForWalk),
    );
  }

  const directSet = new Set([
    ...fromGraph.direct,
    ...recoveredUnique,
    ...skippedDirectLive,
  ]);
  const indirectSet = new Set([
    ...fromGraph.indirect,
    ...fromRecovered.direct,
    ...fromRecovered.indirect,
    ...new Set(skippedIndirect),
    ...new Set(graphEntries),
    ...new Set(fromSkippedDirect),
    ...new Set(fromSkippedIndirect),
  ]);
  for (const d of directSet) indirectSet.delete(d);
  for (const s of normalizedSeeds) {
    directSet.delete(s);
    indirectSet.delete(s);
  }
  // Tests recovered as importers / bridges must not appear in dependent lists.
  const isImpactTest = (id: string) =>
    isTestFile(id) || graph.getNode(id)?.kind === "test";
  for (const id of [...directSet]) {
    if (isImpactTest(id)) directSet.delete(id);
  }
  for (const id of [...indirectSet]) {
    if (isImpactTest(id)) indirectSet.delete(id);
  }

  const mergedDirect = [...directSet].sort();
  const mergedIndirect = [...indirectSet].sort();

  const affectedTests = [
    ...new Set([
      ...collectAffectedTests(
        graph,
        [...graphSeeds, ...missingSeeds],
        mergedDirect,
        mergedIndirect,
      ),
      ...recoveredTests,
      ...skippedTests,
    ]),
  ].sort();

  const exportedApiChanged = detectExportedApiChanged(
    root,
    normalizedSeeds,
    options.since,
  );
  const moduleExportsPublicSymbols = seedsHaveExports(parsed, normalizedSeeds);

  const { risk, reasons } = computeRisk({
    changed: normalizedSeeds,
    direct: mergedDirect,
    indirect: mergedIndirect,
    affectedTests,
    exportedApiChanged,
    moduleExportsPublicSymbols,
    graph,
  });

  const suggestedValidation = buildSuggestedValidation(affectedTests);

  return {
    changed: normalizedSeeds,
    directDependents: mergedDirect,
    indirectDependents: mergedIndirect,
    affectedTests,
    risk,
    reasons,
    suggestedValidation,
    summary: {
      changed: normalizedSeeds.length,
      direct: mergedDirect.length,
      indirect: mergedIndirect.length,
      tests: affectedTests.length,
    },
    cache: stats,
  };
}

function resolveSeeds(
  root: string,
  cwd: string,
  files: string[] | undefined,
  since: string | undefined,
): string[] {
  if (files && files.length > 0) {
    // Resolve relative args against the CLI cwd, then project-relativize.
    const seeds = canonicalizeSeeds(root, files, cwd);
    if (seeds.length === 0) {
      throw new Error(
        `No valid project files in arguments (paths escape the project root): ${files.join(", ")}`,
      );
    }
    return seeds;
  }

  if (!isGitRepo(root)) {
    throw new Error(
      "No files provided and not a Git repository. Pass file paths or run inside a git repo.",
    );
  }

  const snapshot = collectChangedFiles({ cwd: root, since });
  return canonicalizeSeeds(
    root,
    snapshot.files.map((f) => f.path),
    root,
  );
}

/** Canonicalize seeds; drop paths that escape the project root. */
function canonicalizeSeeds(
  root: string,
  paths: string[],
  cwd: string,
): string[] {
  const out: string[] = [];
  for (const path of paths) {
    const rel = toCanonicalRepoRelative(root, path, cwd);
    if (rel) out.push(normalize(rel));
  }
  return [...new Set(out)];
}

function emptyResult(changed: string[]): ImpactResult {
  return {
    changed,
    directDependents: [],
    indirectDependents: [],
    affectedTests: [],
    risk: "low",
    reasons: ["no changed files"],
    suggestedValidation: [],
    summary: { changed: 0, direct: 0, indirect: 0, tests: 0 },
  };
}

function seedsHaveExports(parsed: ParseResult, seeds: string[]): boolean {
  const seedSet = new Set(seeds);
  return parsed.files.some(
    (f) => seedSet.has(f.file) && f.exports.some((e) => e.name !== "*"),
  );
}

/**
 * Find modules that still import a path missing from the live graph
 * (typically deleted or renamed-away files).
 */
export function findImportersOfMissingSeed(
  parsed: ParseResult,
  seed: string,
): string[] {
  const root = parsed.program.root;
  const seedNorm = canonRel(root, seed);
  const seedStem = stripSourceExt(seedNorm);
  const options = parsed.program.compilerOptions;
  const packageImports = loadPackageImports(root);
  const liveFiles = collectLiveFiles(parsed);
  const importSources = collectImportSources(parsed);
  const importers: string[] = [];

  for (const { file, imports } of importSources) {
    for (const imp of imports) {
      if (
        importRefersTo(
          imp,
          file,
          seedNorm,
          seedStem,
          liveFiles,
          options,
          root,
          packageImports,
        )
      ) {
        importers.push(file);
      }
    }
  }

  return [...new Set(importers)].sort();
}

/** Whether an import edge refers to `seedNorm` (resolved, relative, or alias). */
function importRefersTo(
  imp: ResolvedImport,
  fromFile: string,
  seedNorm: string,
  seedStem: string,
  liveFiles: ReadonlySet<string>,
  options: ts.CompilerOptions,
  root: string,
  packageImports: Record<string, unknown> | null,
): boolean {
  const seedIsLive = isLiveSourcePath(seedNorm, liveFiles, root);
  const siblingBlocks = hasLiveSibling(seedStem, liveFiles, seedNorm);

  if (imp.resolvedPath) {
    const resolvedNorm = canonRel(root, imp.resolvedPath);
    // Deleted seed only: specifier names the seed (e.g. `./foo.ts` / `./foo.js`)
    // but TS remapped onto a twin — trust the specifier, not the twin path.
    if (
      !seedIsLive &&
      resolvedNorm !== seedNorm &&
      relativeSpecifierNamesSeed(imp, fromFile, seedNorm, root)
    ) {
      return allowDeletedSpecifierOverride(
        imp,
        fromFile,
        seedNorm,
        siblingBlocks,
        liveFiles,
        root,
      );
    }
    if (resolvedNorm === seedNorm) {
      // Exact resolved path: live seeds always match (ignore-listed importers of
      // foo.ts must not be dropped when foo/index.ts also exists). Deleted seeds
      // still apply the sibling veto so stale cache paths don't beat a twin.
      if (
        seedIsLive &&
        emitJsSpecifierPrefersTsSibling(imp, seedNorm, liveFiles, root)
      ) {
        return false;
      }
      return seedIsLive || !siblingBlocks;
    }
    if (stripSourceExt(resolvedNorm) === seedStem) {
      // Stem-only means the edge resolved to a different file (the twin) —
      // never attribute that to a live seed; for deleted seeds, veto if twin lives.
      return !seedIsLive && !siblingBlocks;
    }
    return false;
  }

  // Relative unresolved imports
  if (
    !imp.external &&
    (imp.specifier.startsWith(".") || imp.specifier.startsWith("/"))
  ) {
    const fromDir = dirname(fromFile);
    const joined = canonRel(root, join(fromDir, imp.specifier));
    const explicitExt = /\.[cm]?[jt]sx?$/.test(imp.specifier);
    // Explicit extension: exact path always matches (import names the deleted
    // file). Same-stem cross-ext (./x.js → deleted x.ts) allows only when no
    // live sibling would win — never index expansion.
    if (explicitExt) {
      if (joined === seedNorm) return true;
      // Deleted seed only: NodeNext emit extensions name the missing source file.
      if (
        !seedIsLive &&
        relativeSpecifierNamesSeed(imp, fromFile, seedNorm, root)
      ) {
        return allowDeletedSpecifierOverride(
          imp,
          fromFile,
          seedNorm,
          siblingBlocks,
          liveFiles,
          root,
        );
      }
      if (stripSourceExt(joined) === seedStem) {
        // Emit extensions (./foo.js) must use NodeNext pairing above — never
        // stem-match onto an unpaired source (e.g. .js → .mts).
        const joinedExt =
          joined.match(/\.[cm]?[jt]sx?$/)?.[0]?.toLowerCase() ?? "";
        if (isJsEmitExtension(joinedExt)) return false;
        return !seedIsLive && !siblingBlocks;
      }
      return false;
    }
    const candidates = expandResolutionCandidates(joined).map((c) =>
      canonRel(root, c),
    );
    const exactHit = candidates.some((c) => c === seedNorm);
    const stemHit = candidates.some((c) => stripSourceExt(c) === seedStem);
    if (!exactHit && !stemHit) return false;
    if (exactHit) return seedIsLive || !siblingBlocks;
    return !seedIsLive && !siblingBlocks;
  }

  // Path-alias / bare / # subpath imports
  if (
    imp.external ||
    isBareSpecifier(imp.specifier) ||
    imp.specifier.startsWith("#")
  ) {
    return aliasMapsToSeed(
      imp.specifier,
      seedNorm,
      options,
      root,
      packageImports,
      liveFiles,
    );
  }

  return false;
}

/**
 * Whether a deleted-seed specifier override may fire when a live sibling exists.
 * Exact `./foo.ts` and NodeNext emit matches that uniquely name the seed may beat
 * unrelated same-stem siblings (e.g. `.js`→`.tsx` despite a live `.mts` or
 * `foo/index.ts`; `.mjs`→`.mts` despite a live `.tsx`); `./foo.js`→deleted
 * `foo.ts` may beat a live `foo.tsx`; never claim deleted `foo.tsx` when `foo.ts`
 * is live.
 */
function allowDeletedSpecifierOverride(
  imp: ResolvedImport,
  fromFile: string,
  seedNorm: string,
  siblingBlocks: boolean,
  liveFiles: ReadonlySet<string>,
  root: string,
): boolean {
  if (emitJsSpecifierPrefersTsSibling(imp, seedNorm, liveFiles, root)) {
    return false;
  }
  if (!siblingBlocks) return true;
  // Explicit path to the deleted source file (e.g. `./foo.ts`).
  if (
    !imp.external &&
    (imp.specifier.startsWith(".") || imp.specifier.startsWith("/")) &&
    /\.[cm]?[jt]sx?$/.test(imp.specifier)
  ) {
    const joined = canonRel(root, join(dirname(fromFile), imp.specifier));
    if (joined === seedNorm) return true;
  }
  // Emit match naming this seed; same-stem files outside the emit family do not compete.
  return nodeNextEmitBeatsUnrelatedSibling(imp, seedNorm);
}

/**
 * NodeNext `./foo.js` targets the `.ts` sibling when both `.ts` and `.tsx` exist;
 * do not attribute that edge to a `.tsx` seed when `.ts` is live (program or disk).
 */
function emitJsSpecifierPrefersTsSibling(
  imp: ResolvedImport,
  seedNorm: string,
  liveFiles: ReadonlySet<string>,
  root?: string,
): boolean {
  if (imp.external) return false;
  if (!(imp.specifier.startsWith(".") || imp.specifier.startsWith("/"))) {
    return false;
  }
  const specExt =
    imp.specifier.match(/\.[cm]?[jt]sx?$/)?.[0]?.toLowerCase() ?? "";
  // Only .js/.jsx prefer .ts over .tsx; .mjs/.cjs are a different emit family.
  if (specExt !== ".js" && specExt !== ".jsx") return false;
  const seedExt =
    seedNorm.match(/\.[cm]?[jt]sx?$/)?.[0]?.toLowerCase() ?? "";
  if (seedExt !== ".tsx") return false;
  const stem = stripSourceExt(seedNorm);
  const tsSibling = `${stem}.ts`;
  if (liveFiles.has(tsSibling)) return true;
  return root != null && existsSync(join(root, tsSibling));
}

/**
 * Emit specifier names the deleted seed in a way that should ignore same-stem
 * siblings from other emit families (or the .ts-over-.tsx preference for .js).
 */
function nodeNextEmitBeatsUnrelatedSibling(
  imp: ResolvedImport,
  seedNorm: string,
): boolean {
  if (imp.external) return false;
  if (!(imp.specifier.startsWith(".") || imp.specifier.startsWith("/"))) {
    return false;
  }
  const specExt =
    imp.specifier.match(/\.[cm]?[jt]sx?$/)?.[0]?.toLowerCase() ?? "";
  const seedExt =
    seedNorm.match(/\.[cm]?[jt]sx?$/)?.[0]?.toLowerCase() ?? "";
  if (!nodeNextEmitNamesSource(specExt, seedExt)) return false;
  // .js/.jsx → .ts or .tsx: beat unrelated siblings (index, .mts, .cts).
  // Prefer-.ts-over-.tsx when .ts is live is handled by emitJsSpecifierPrefersTsSibling
  // before this runs.
  if (specExt === ".js" || specExt === ".jsx") {
    return seedExt === ".ts" || seedExt === ".tsx";
  }
  // .mjs→.mts / .cjs→.cts: .ts/.tsx/.js siblings are a different family.
  if (specExt === ".mjs" && seedExt === ".mts") return true;
  if (specExt === ".cjs" && seedExt === ".cts") return true;
  return false;
}

/**
 * NodeNext/TS emit extension → source extension pairing:
 * `.js`/`.jsx` → `.ts`/`.tsx`; `.mjs` → `.mts`; `.cjs` → `.cts`.
 */
function nodeNextEmitNamesSource(specExt: string, seedExt: string): boolean {
  if (specExt === ".js" || specExt === ".jsx") {
    return seedExt === ".ts" || seedExt === ".tsx";
  }
  if (specExt === ".mjs") return seedExt === ".mts";
  if (specExt === ".cjs") return seedExt === ".cts";
  return false;
}

function isJsEmitExtension(ext: string): boolean {
  return (
    ext === ".js" ||
    ext === ".jsx" ||
    ext === ".mjs" ||
    ext === ".cjs"
  );
}

/** True when a relative specifier with an explicit extension names `seedNorm`. */
function relativeSpecifierNamesSeed(
  imp: ResolvedImport,
  fromFile: string,
  seedNorm: string,
  root: string,
): boolean {
  if (imp.external) return false;
  if (!(imp.specifier.startsWith(".") || imp.specifier.startsWith("/"))) {
    return false;
  }
  if (!/\.[cm]?[jt]sx?$/.test(imp.specifier)) return false;
  const joined = canonRel(root, join(dirname(fromFile), imp.specifier));
  if (joined === seedNorm) return true;

  // NodeNext emit extensions name their paired sources only — never e.g. `.js`→`.mts`.
  // Do not treat `./foo.ts` as naming `foo.tsx` (different source files).
  const specExt = joined.match(/\.[cm]?[jt]sx?$/)?.[0]?.toLowerCase() ?? "";
  const seedExt = seedNorm.match(/\.[cm]?[jt]sx?$/)?.[0]?.toLowerCase() ?? "";
  if (!nodeNextEmitNamesSource(specExt, seedExt)) return false;
  return stripSourceExt(joined) === stripSourceExt(seedNorm);
}

/** Wide tsconfig program, cached per ParseResult (live files + import sources). */
const wideProgramCache = new WeakMap<
  ParseResult,
  ReturnType<typeof createProgramForRoot> | null
>();

function getWideProgram(
  parsed: ParseResult,
): ReturnType<typeof createProgramForRoot> | null {
  if (wideProgramCache.has(parsed)) {
    return wideProgramCache.get(parsed) ?? null;
  }
  try {
    const wide = createProgramForRoot(parsed.program.root, null);
    wideProgramCache.set(parsed, wide);
    return wide;
  } catch {
    wideProgramCache.set(parsed, null);
    return null;
  }
}

function collectLiveFiles(parsed: ParseResult): Set<string> {
  const root = parsed.program.root;
  const live = new Set<string>();

  const addProgram = (
    program: { getSourceFiles(): Iterable<ts.SourceFile> } | null | undefined,
    programRoot: string,
  ) => {
    if (!program || typeof program.getSourceFiles !== "function") return;
    for (const sf of program.getSourceFiles()) {
      if (!isProjectSourceFile(sf, programRoot)) continue;
      live.add(canonRel(programRoot, toPosixRelative(programRoot, sf.fileName)));
    }
  };

  for (const file of parsed.files) {
    live.add(canonRel(root, file.file));
  }
  addProgram(parsed.program.program, root);

  // Include ignore-listed modules so live-sibling checks see twins outside the
  // scan allowlist (e.g. ignored/foo.tsx vs deleted ignored/foo.ts).
  const wide = getWideProgram(parsed);
  if (wide) addProgram(wide.program, wide.root);

  return live;
}

/** Parsed modules plus allowlist-skipped / wide-program deps. */
const importSourcesCache = new WeakMap<
  ParseResult,
  Array<{ file: string; imports: ResolvedImport[] }>
>();

function collectImportSources(
  parsed: ParseResult,
): Array<{ file: string; imports: ResolvedImport[] }> {
  const cached = importSourcesCache.get(parsed);
  if (cached) return cached;

  const root = parsed.program.root;
  const options = parsed.program.compilerOptions;
  const sources: Array<{ file: string; imports: ResolvedImport[] }> = [];
  const seen = new Set<string>();
  const scannedOnly = new Set(parsed.files.map((f) => f.file));

  const addFromProgram = (
    program: { getSourceFiles(): Iterable<ts.SourceFile> } | null | undefined,
    compilerOptions: ts.CompilerOptions,
    programRoot: string,
    /** When set, only include modules from this allowlist (scanned/parsed set). */
    restrictTo?: ReadonlySet<string>,
  ) => {
    if (!program || typeof program.getSourceFiles !== "function") return;
    for (const sf of program.getSourceFiles()) {
      if (!isProjectSourceFile(sf, programRoot)) continue;
      const rel = toPosixRelative(programRoot, sf.fileName);
      if (restrictTo && !restrictTo.has(rel)) continue;
      if (seen.has(rel)) continue;
      seen.add(rel);
      sources.push({
        file: rel,
        imports: extractImports(sf, programRoot, compilerOptions),
      });
    }
  };

  for (const file of parsed.files) {
    seen.add(file.file);
    sources.push({ file: file.file, imports: file.imports });
  }

  // Allowlist-only: dependency files pulled into the narrow program (e.g. via
  // imports into ignored dirs) can resolve differently than the wide tsconfig
  // program — off-allowlist modules are added from `getWideProgram` below.
  addFromProgram(parsed.program.program, options, root, scannedOnly);

  // Full tsconfig program (no scan allowlist) so skipped modules that are only
  // dependents — never pulled in as deps of scanned roots — still appear as
  // importer candidates (e.g. ignored/outer → src/mid → ignored/bridge).
  const wide = getWideProgram(parsed);
  if (wide) addFromProgram(wide.program, wide.compilerOptions, wide.root);

  importSourcesCache.set(parsed, sources);
  return sources;
}

/** True when `seedNorm` is in the TS program or still exists on disk (TS may drop one of foo.ts/foo.tsx). */
function isLiveSourcePath(
  seedNorm: string,
  liveFiles: ReadonlySet<string>,
  root: string,
): boolean {
  if (liveFiles.has(seedNorm)) return true;
  return existsSync(join(root, seedNorm));
}

function hasLiveSibling(
  seedStem: string,
  liveFiles: ReadonlySet<string>,
  seedNorm: string,
): boolean {
  const indexUnderSeed = `${seedStem}/index`;
  const seedIsIndex = seedStem.endsWith("/index");
  const fileStemForIndexSeed = seedIsIndex
    ? seedStem.slice(0, -"/index".length)
    : null;
  for (const live of liveFiles) {
    if (live === seedNorm) continue;
    const liveStem = stripSourceExt(live);
    // Extension twin (foo.ts vs foo.tsx), index under stem (foo.ts vs foo/index.ts),
    // or reverse (deleted foo/index.ts vs live foo.ts).
    if (
      liveStem === seedStem ||
      liveStem === indexUnderSeed ||
      (fileStemForIndexSeed !== null && liveStem === fileStemForIndexSeed)
    ) {
      return true;
    }
  }
  return false;
}

/** Skipped (off-graph) modules that directly import any of `graphNodes`. */
function findSkippedImportersAbove(
  parsed: ParseResult,
  graph: ProjectGraph,
  graphNodes: string[],
  seen: Set<string>,
): string[] {
  const found: string[] = [];
  for (const node of graphNodes) {
    for (const up of findDirectImportersOf(parsed, [node])) {
      if (seen.has(up)) continue;
      if (graph.getNode(up)) continue;
      seen.add(up);
      found.push(up);
    }
  }
  return found;
}

/** Who imports `targets` (resolved, relative, or alias — same rules as seed recovery). */
function findDirectImportersOf(
  parsed: ParseResult,
  targets: string[],
): string[] {
  if (targets.length === 0) return [];
  const root = parsed.program.root;
  const options = parsed.program.compilerOptions;
  const packageImports = loadPackageImports(root);
  const liveFiles = collectLiveFiles(parsed);
  const targetList = [...new Set(targets.map((t) => canonRel(root, t)))];
  const importers: string[] = [];

  for (const { file, imports } of collectImportSources(parsed)) {
    const fileNorm = canonRel(root, file);
    if (targetList.includes(fileNorm)) continue;
    for (const imp of imports) {
      const hits = targetList.some((target) =>
        importRefersTo(
          imp,
          file,
          target,
          stripSourceExt(target),
          liveFiles,
          options,
          root,
          packageImports,
        ),
      );
      if (hits) {
        importers.push(fileNorm);
        break;
      }
    }
  }

  return [...new Set(importers)];
}

/**
 * Walk allowlist-skipped importer chains until scanned/graph modules are reached.
 * In-graph cones are handed to `collectDependents`; AST continues only through
 * skipped (off-graph) importers. Callers seed the frontier with recovered
 * skipped modules and any skipped-above peeks from the in-graph cone.
 */
function walkSkippedImporterChain(
  parsed: ParseResult,
  graph: ProjectGraph,
  recoveredSkipped: string[],
  alreadySeen: ReadonlySet<string>,
): { skippedIndirect: string[]; graphEntries: string[]; tests: string[] } {
  const frontier = [...recoveredSkipped];
  const seen = new Set(alreadySeen);

  const skippedIndirect: string[] = [];
  const graphEntries: string[] = [];
  const tests: string[] = [];

  for (const id of recoveredSkipped) {
    seen.add(id);
    // Frontier seeds must appear in the result (e.g. skipped-above peeks).
    if (graph.getNode(id)) {
      graphEntries.push(id);
      continue;
    }
    const isTest = isTestFile(id) || graph.getNode(id)?.kind === "test";
    if (isTest) tests.push(id);
    else skippedIndirect.push(id);
  }

  while (frontier.length > 0) {
    const batch = frontier.splice(0, frontier.length);
    for (const importer of findDirectImportersOf(parsed, batch)) {
      if (seen.has(importer)) continue;
      seen.add(importer);

      const isTest =
        isTestFile(importer) || graph.getNode(importer)?.kind === "test";
      if (isTest) {
        tests.push(importer);
      }

      if (graph.getNode(importer)) {
        graphEntries.push(importer);
        continue;
      }

      if (!isTest) skippedIndirect.push(importer);
      frontier.push(importer);
    }
  }

  return {
    skippedIndirect: [...new Set(skippedIndirect)],
    graphEntries: [...new Set(graphEntries)],
    tests: [...new Set(tests)],
  };
}

function loadPackageImports(root: string): Record<string, unknown> | null {
  try {
    const raw = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      imports?: unknown;
    };
    if (raw.imports && typeof raw.imports === "object" && !Array.isArray(raw.imports)) {
      return raw.imports as Record<string, unknown>;
    }
  } catch {
    // ignore
  }
  return null;
}

function stripSourceExt(path: string): string {
  return path.replace(/\.[cm]?[jt]sx?$/, "");
}

function expandResolutionCandidates(joined: string): string[] {
  const stem = stripSourceExt(joined);
  return [
    joined,
    `${stem}.ts`,
    `${stem}.tsx`,
    `${stem}.js`,
    `${stem}.jsx`,
    `${stem}.mts`,
    `${stem}.cts`,
    `${stem}/index.ts`,
    `${stem}/index.tsx`,
    `${stem}/index.js`,
  ].map(normalize);
}

function isGitBufferOverflow(err: unknown): boolean {
  if (!(err instanceof GitError)) return false;
  return /ENOBUFS|maxBuffer/i.test(err.message);
}

/** Diff text, `"overflow"` when maxBuffer hit, or `"error"` for other git failures. */
function tryGitDiff(
  root: string,
  args: string[],
): string | "overflow" | "error" {
  try {
    return runGit(root, args);
  } catch (err) {
    if (isGitBufferOverflow(err)) return "overflow";
    return "error";
  }
}

function detectExportedApiChanged(
  root: string,
  seeds: string[],
  since: string | undefined,
): boolean {
  if (!isGitRepo(root)) return false;

  for (const path of seeds) {
    const chunks: string[] = [];

    const pushDiff = (args: string[]): boolean => {
      const diff = tryGitDiff(root, args);
      // Cannot verify — treat as export change so risk is not under-reported.
      if (diff === "overflow" || diff === "error") return true;
      chunks.push(diff);
      return false;
    };

    if (since) {
      if (pushDiff(["diff", `${since}...HEAD`, "--", path])) return true;
    }

    // Always include worktree + index so uncommitted export edits are caught,
    // including deletions (git still emits -export lines for removed files).
    if (pushDiff(["diff", "HEAD", "--", path])) return true;
    if (pushDiff(["diff", "--cached", "--", path])) return true;

    if (diffTouchesExports(chunks.join("\n"))) return true;

    // Brand-new untracked files: scan contents as a synthetic added diff.
    const abs = resolve(root, path);
    if (!existsSync(abs)) continue;
    const tracked = tryGitDiff(root, ["ls-files", "--", path]);
    if (tracked === "overflow" || tracked === "error") return true;
    if (typeof tracked === "string" && tracked.trim()) continue;
    try {
      const body = readFileSync(abs, "utf8");
      const fauxDiff = body
        .split(/\r?\n/)
        .map((l) => `+${l}`)
        .join("\n");
      if (diffTouchesExports(fauxDiff)) return true;
    } catch {
      // ignore
    }
  }
  return false;
}

export type { ProjectGraph } from "../graph/graph.ts";
