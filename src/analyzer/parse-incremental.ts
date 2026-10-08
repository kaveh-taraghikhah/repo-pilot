import type { SourceFile } from "typescript";
import { mapPool } from "../cache/concurrency.ts";
import { hashFile, projectFingerprint } from "../cache/fingerprint.ts";
import {
  loadCachedFile,
  loadManifest,
  saveCachedFile,
  saveManifest,
} from "../cache/store.ts";
import type { CacheManifest, CacheStats } from "../cache/types.ts";
import { CACHE_SCHEMA_VERSION } from "../cache/types.ts";
import { canonicalizePath } from "../path-utils.ts";
import type { ScannedFile } from "../scanner/scan-files.ts";
import {
  parseSourceFile,
  type ParsedFile,
  type ParseResult,
} from "./parser.ts";
import {
  createProgramForRoot,
  isProjectSourceFile,
  toPosixRelative,
} from "./program.ts";

export interface IncrementalParseOptions {
  cache?: boolean;
  concurrency?: number;
}

export interface IncrementalParseResult {
  parseResult: ParseResult;
  stats: CacheStats;
}

export async function parseProjectIncremental(
  root: string,
  /** Omit/`null` = use tsconfig fileNames; `[]` = empty allowlist. */
  scannedFiles?: ScannedFile[] | null,
  options: IncrementalParseOptions = {},
): Promise<IncrementalParseResult> {
  const useCache = options.cache !== false;
  const concurrency = options.concurrency ?? 8;
  const started = Date.now();

  const programCtx = createProgramForRoot(root, scannedFiles);
  // Compare by canonical absolute path — relative link-dir vs real/ paths must match.
  const allowlist =
    scannedFiles != null
      ? new Set(scannedFiles.map((f) => canonicalizePath(f.absolutePath)))
      : null;
  const sourceFiles = programCtx.program
    .getSourceFiles()
    .filter((sf) => isProjectSourceFile(sf, programCtx.root))
    .filter((sf) => {
      if (!allowlist) return true;
      return allowlist.has(canonicalizePath(sf.fileName));
    });

  const filesTotal = sourceFiles.length;

  if (!useCache) {
    const files = sourceFiles.map((sf) =>
      parseSourceFile(sf, programCtx.root, programCtx.compilerOptions),
    );
    return {
      parseResult: { program: programCtx, files },
      stats: {
        filesTotal,
        filesCached: 0,
        filesParsed: filesTotal,
        durationMs: Date.now() - started,
      },
    };
  }

  const canonRoot = programCtx.root;
  const projFp = await projectFingerprint(
    canonRoot,
    sourceFiles.map((sf) => toPosixRelative(canonRoot, sf.fileName)),
  );
  let manifest = await loadManifest(canonRoot);
  if (!manifest || manifest.projectFingerprint !== projFp) {
    manifest = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      projectFingerprint: projFp,
      files: {},
    };
  }

  // Hash all source files in parallel
  const hashEntries = await mapPool(sourceFiles, concurrency, async (sf) => {
    const rel = toPosixRelative(canonRoot, sf.fileName);
    const hash = await hashFile(sf.fileName);
    return { sf, rel, hash };
  });

  const cached: ParsedFile[] = [];
  const dirty: Array<{ sf: SourceFile; rel: string; hash: string }> = [];

  for (const entry of hashEntries) {
    const expected = manifest.files[entry.rel];
    if (expected && expected === entry.hash) {
      const hit = await loadCachedFile(canonRoot, entry.rel, entry.hash);
      if (hit) {
        cached.push(hit);
        continue;
      }
    }
    dirty.push(entry);
  }

  const parsedDirty = await mapPool(dirty, concurrency, async (entry) => {
    const data = parseSourceFile(entry.sf, canonRoot, programCtx.compilerOptions);
    await saveCachedFile(canonRoot, entry.rel, entry.hash, data);
    manifest.files[entry.rel] = entry.hash;
    return data;
  });

  // Drop stale paths no longer in the project
  const live = new Set(hashEntries.map((e) => e.rel));
  for (const key of Object.keys(manifest.files)) {
    if (!live.has(key)) delete manifest.files[key];
  }

  await saveManifest(canonRoot, manifest as CacheManifest);

  const files = [...cached, ...parsedDirty].sort((a, b) =>
    a.file.localeCompare(b.file),
  );

  return {
    parseResult: { program: programCtx, files },
    stats: {
      filesTotal,
      filesCached: cached.length,
      filesParsed: parsedDirty.length,
      durationMs: Date.now() - started,
    },
  };
}
