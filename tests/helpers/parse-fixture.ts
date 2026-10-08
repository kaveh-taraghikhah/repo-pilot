import type { CompilerOptions } from "typescript";
import type { ExportedSymbol } from "../../src/analyzer/exports.ts";
import type { ResolvedImport } from "../../src/analyzer/imports.ts";
import type { ParsedFile, ParseResult } from "../../src/analyzer/parser.ts";
import type { FileSymbols } from "../../src/analyzer/symbols.ts";

/** Compact import edge for unit fixtures (fromFile defaults to the owning file). */
export interface FixtureImport {
  specifier: string;
  resolvedPath?: string | null;
  external?: boolean;
  kind?: ResolvedImport["kind"];
  fromFile?: string;
}

/** Compact parsed-file descriptor for unit fixtures. */
export interface FixtureFile {
  file: string;
  imports?: FixtureImport[];
  exports?: ExportedSymbol[];
  functions?: string[];
  classes?: string[];
  isRoute?: boolean;
  isTest?: boolean;
  complexity?: number;
}

export interface MakeParsedOptions {
  root?: string;
  compilerOptions?: CompilerOptions;
}

/**
 * Stub `ParseResult` for importer/graph unit tests — no real TS program.
 * Only fields those code paths read are populated.
 */
export function makeParsed(
  files: FixtureFile[],
  options: MakeParsedOptions = {},
): ParseResult {
  const root = options.root ?? "/proj";
  const compilerOptions = options.compilerOptions ?? {};

  const result: ParseResult = {
    program: {
      root,
      compilerOptions,
      // Unit fixtures never touch the real program/checker.
      program: null as unknown as ParseResult["program"]["program"],
      checker: null as unknown as ParseResult["program"]["checker"],
      configPath: null,
    },
    files: files.map((spec) => toParsedFile(spec)),
  };

  return result;
}

function toParsedFile(spec: FixtureFile): ParsedFile {
  const symbols: FileSymbols = {
    file: spec.file,
    functions: spec.functions ?? [],
    classes: spec.classes ?? [],
    isRoute: spec.isRoute ?? false,
    isTest: spec.isTest ?? false,
  };

  const imports: ResolvedImport[] = (spec.imports ?? []).map((imp) => ({
    fromFile: imp.fromFile ?? spec.file,
    specifier: imp.specifier,
    resolvedPath: imp.resolvedPath === undefined ? null : imp.resolvedPath,
    external: imp.external ?? false,
    kind: imp.kind ?? "import",
  }));

  return {
    file: spec.file,
    imports,
    exports: spec.exports ?? [],
    symbols,
    complexity: spec.complexity ?? 1,
  };
}
