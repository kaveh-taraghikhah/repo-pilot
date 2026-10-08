import ts from "typescript";
import { toPosixRelative } from "./program.ts";

export interface ExportedSymbol {
  file: string;
  name: string;
  kind: "named" | "default" | "reexport";
}

export function extractExports(sourceFile: ts.SourceFile, root: string): ExportedSymbol[] {
  const file = toPosixRelative(root, sourceFile.fileName);
  const results: ExportedSymbol[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      results.push({ file, name: "default", kind: "default" });
      continue;
    }

    if (ts.isExportDeclaration(statement)) {
      if (statement.moduleSpecifier) {
        if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          for (const el of statement.exportClause.elements) {
            results.push({
              file,
              name: (el.name ?? el.propertyName)?.text ?? "unknown",
              kind: "reexport",
            });
          }
        } else if (statement.exportClause && ts.isNamespaceExport(statement.exportClause)) {
          results.push({
            file,
            name: statement.exportClause.name.text,
            kind: "reexport",
          });
        } else if (!statement.exportClause) {
          results.push({ file, name: "*", kind: "reexport" });
        }
      } else if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const el of statement.exportClause.elements) {
          results.push({
            file,
            name: el.name.text,
            kind: "named",
          });
        }
      }
      continue;
    }

    const mods = ts.canHaveModifiers(statement)
      ? ts.getModifiers(statement)
      : undefined;
    const isExported = Boolean(mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
    const isDefault = Boolean(mods?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword));

    if (!isExported) continue;

    if (isDefault) {
      results.push({ file, name: "default", kind: "default" });
      continue;
    }

    if (ts.isFunctionDeclaration(statement) && statement.name) {
      results.push({ file, name: statement.name.text, kind: "named" });
    } else if (ts.isClassDeclaration(statement) && statement.name) {
      results.push({ file, name: statement.name.text, kind: "named" });
    } else if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          results.push({ file, name: decl.name.text, kind: "named" });
        }
      }
    } else if (ts.isEnumDeclaration(statement) && statement.name) {
      results.push({ file, name: statement.name.text, kind: "named" });
    } else if (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) {
      results.push({ file, name: statement.name.text, kind: "named" });
    }
  }

  return results;
}
