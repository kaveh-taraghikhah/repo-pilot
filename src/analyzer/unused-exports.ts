import ts from "typescript";
import { extractImports } from "./imports.ts";
import type { ParseResult } from "./parser.ts";
import { isProjectSourceFile, toPosixRelative } from "./program.ts";

export interface UnusedExport {
  file: string;
  name: string;
}

/**
 * Best-effort unused export detection via import and re-export bindings
 * across the program.
 */
export function findUnusedExports(
  parsed: ParseResult,
  limit?: number,
): UnusedExport[] {
  const usedKeys = new Set<string>();
  const root = parsed.program.root;
  const options = parsed.program.compilerOptions;

  // Index specifier→resolvedPath for every project SourceFile. Parsed files
  // reuse extractImports results; allowlist-skipped modules resolve via the
  // compiler so their imports still mark usage.
  const resolutions = new Map<string, Map<string, string | null>>();
  const parsedByPath = new Map(parsed.files.map((f) => [f.file, f]));

  for (const sourceFile of parsed.program.program.getSourceFiles()) {
    if (!isProjectSourceFile(sourceFile, root)) continue;
    const fromFile = toPosixRelative(root, sourceFile.fileName);
    const parsedFile = parsedByPath.get(fromFile);
    const imports =
      parsedFile?.imports ?? extractImports(sourceFile, root, options);
    const map = new Map<string, string | null>();
    for (const imp of imports) {
      map.set(imp.specifier, imp.resolvedPath);
    }
    resolutions.set(fromFile, map);
  }

  const markAllExports = (resolved: string): void => {
    const target = parsedByPath.get(resolved);
    for (const exp of target?.exports ?? []) {
      usedKeys.add(`${resolved}::${exp.name}`);
    }
  };

  for (const sourceFile of parsed.program.program.getSourceFiles()) {
    if (!isProjectSourceFile(sourceFile, root)) continue;
    const fromFile = toPosixRelative(root, sourceFile.fileName);
    const fileResolutions = resolutions.get(fromFile);

    const resolveImport = (specifier: string | null): string | null => {
      if (!specifier) return null;
      return fileResolutions?.get(specifier) ?? null;
    };

    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && node.importClause) {
        const specifier =
          node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
            ? node.moduleSpecifier.text
            : null;
        const resolved = resolveImport(specifier);

        if (node.importClause.name && resolved) {
          usedKeys.add(`${resolved}::default`);
        }

        const bindings = node.importClause.namedBindings;
        if (bindings && ts.isNamedImports(bindings) && resolved) {
          for (const el of bindings.elements) {
            const imported = (el.propertyName ?? el.name).text;
            usedKeys.add(`${resolved}::${imported}`);
          }
        }

        if (bindings && ts.isNamespaceImport(bindings) && resolved) {
          markAllExports(resolved);
        }
      }

      // Side-effect import without clause: import './m'
      if (
        ts.isImportDeclaration(node) &&
        !node.importClause &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const resolved = resolveImport(node.moduleSpecifier.text);
        if (resolved) markAllExports(resolved);
      }

      // Re-exports: export { x } from './m' / export * from './m'
      if (
        ts.isExportDeclaration(node) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const resolved = resolveImport(node.moduleSpecifier.text);
        if (resolved) {
          if (!node.exportClause) {
            // export * from './m'
            markAllExports(resolved);
          } else if (ts.isNamedExports(node.exportClause)) {
            for (const el of node.exportClause.elements) {
              const imported = (el.propertyName ?? el.name).text;
              usedKeys.add(`${resolved}::${imported}`);
            }
          } else if (ts.isNamespaceExport(node.exportClause)) {
            // export * as ns from './m'
            markAllExports(resolved);
          }
        }
      }

      // Dynamic import(): conservatively mark all exports of the target used
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length > 0 &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        const resolved = resolveImport(node.arguments[0].text);
        if (resolved) markAllExports(resolved);
      }

      // require('…') — same conservative treatment
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require" &&
        node.arguments.length > 0 &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        const resolved = resolveImport(node.arguments[0].text);
        if (resolved) markAllExports(resolved);
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  const unused: UnusedExport[] = [];

  for (const file of parsed.files) {
    if (file.symbols.isTest) continue;
    for (const exp of file.exports) {
      if (exp.name === "*" || exp.kind === "reexport") continue;
      if (usedKeys.has(`${exp.file}::${exp.name}`)) continue;
      unused.push({ file: exp.file, name: exp.name });
      if (limit !== undefined && unused.length >= limit) return unused;
    }
  }

  return unused;
}
