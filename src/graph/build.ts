import type { ParseResult } from "../analyzer/parser.ts";
import { ProjectGraph } from "./graph.ts";

export function buildProjectGraph(parsed: ParseResult): ProjectGraph {
  const graph = new ProjectGraph();
  const parsedPaths = new Set(parsed.files.map((f) => f.file));

  for (const file of parsed.files) {
    let kind: "module" | "test" | "route" = "module";
    if (file.symbols.isTest) kind = "test";
    else if (file.symbols.isRoute) kind = "route";
    graph.addNode(file.file, file.file, kind);
  }

  for (const file of parsed.files) {
    for (const imp of file.imports) {
      if (imp.external) {
        const externalId = `external:${imp.specifier}`;
        graph.addNode(externalId, imp.specifier, "external");
        graph.addEdge(
          file.file,
          externalId,
          imp.kind === "reexport" ? "reexport" : "import",
        );
        continue;
      }

      if (!imp.resolvedPath) continue;
      // Skip targets outside the scanned/parsed set (ignored dirs, etc.)
      // so we don't create unparsed ghost nodes that truncate impact walks.
      const target = parsed.files.find((f) => f.file === imp.resolvedPath);
      if (!target || !parsedPaths.has(imp.resolvedPath)) continue;

      const kind = target.symbols.isTest
        ? "test"
        : target.symbols.isRoute
          ? "route"
          : "module";
      graph.addNode(imp.resolvedPath, imp.resolvedPath, kind);
      graph.addEdge(
        file.file,
        imp.resolvedPath,
        imp.kind === "reexport" ? "reexport" : "import",
      );
    }
  }

  return graph;
}
