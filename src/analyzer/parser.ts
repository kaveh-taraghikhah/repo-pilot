import type { SourceFile, CompilerOptions } from "typescript";
import { extractExports, type ExportedSymbol } from "./exports.ts";
import { extractImports, type ResolvedImport } from "./imports.ts";
import {
  createProgramForRoot,
  isProjectSourceFile,
  type ProgramContext,
} from "./program.ts";
import { extractSymbols, type FileSymbols } from "./symbols.ts";
import { fileComplexity } from "./complexity.ts";
import { canonicalizePath } from "../path-utils.ts";
import type { ScannedFile } from "../scanner/scan-files.ts";

export interface ParsedFile {
  file: string;
  imports: ResolvedImport[];
  exports: ExportedSymbol[];
  symbols: FileSymbols;
  complexity: number;
}

export interface ParseResult {
  program: ProgramContext;
  files: ParsedFile[];
}

export function parseSourceFile(
  sourceFile: SourceFile,
  root: string,
  compilerOptions: CompilerOptions,
): ParsedFile {
  const symbols = extractSymbols(sourceFile, root);
  return {
    file: symbols.file,
    imports: extractImports(sourceFile, root, compilerOptions),
    exports: extractExports(sourceFile, root),
    symbols,
    complexity: fileComplexity(sourceFile),
  };
}

export function parseProject(
  root: string,
  /** Omit/`null` = use tsconfig fileNames; `[]` = empty allowlist. */
  scannedFiles?: ScannedFile[] | null,
): ParseResult {
  const programCtx = createProgramForRoot(root, scannedFiles);
  const allowlist =
    scannedFiles != null
      ? new Set(scannedFiles.map((f) => canonicalizePath(f.absolutePath)))
      : null;
  const files: ParsedFile[] = [];

  for (const sourceFile of programCtx.program.getSourceFiles()) {
    if (!isProjectSourceFile(sourceFile, root)) continue;
    if (
      allowlist &&
      !allowlist.has(canonicalizePath(sourceFile.fileName))
    ) {
      continue;
    }
    files.push(parseSourceFile(sourceFile, root, programCtx.compilerOptions));
  }

  return { program: programCtx, files };
}

export type { ExportedSymbol, ResolvedImport, FileSymbols, ProgramContext };
