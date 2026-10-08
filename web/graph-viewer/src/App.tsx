import { useEffect, useMemo, useState } from "react";
import { fetchGraph } from "./api.ts";
import { GraphCanvas } from "./components/GraphCanvas.tsx";
import { NodePanel } from "./components/NodePanel.tsx";
import { SearchBar } from "./components/SearchBar.tsx";
import { layoutGraph, type GraphPayload } from "./layout.ts";

export function App() {
  const [data, setData] = useState<GraphPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchGraph()
      .then((payload) => {
        if (!cancelled) setData(payload);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const layout = useMemo(() => {
    if (!data) return null;
    return layoutGraph(data.nodes, data.edges);
  }, [data]);

  const selected = data?.nodes.find((n) => n.id === selectedId) ?? null;
  const moduleCount = data
    ? data.nodes.filter((n) => n.kind !== "external").length
    : 0;
  const edgeCount = data?.edges.length ?? 0;

  return (
    <div className="app">
      <header className="topbar">
        <h1 className="brand">
          <span className="brand-name">
            Repo<span>Pilot</span>
          </span>
          {data ? (
            <span className="brand-meta">
              {moduleCount} modules · {edgeCount} edges
              {data.cycles.length > 0 ? ` · ${data.cycles.length} cycles` : ""}
            </span>
          ) : null}
        </h1>
        <SearchBar value={query} onChange={setQuery} />
      </header>

      {error ? <div className="status error">{error}</div> : null}
      {!data && !error ? <div className="status">Loading graph…</div> : null}

      {data && layout ? (
        <div className="workspace">
          <div className="canvas-wrap">
            <GraphCanvas
              nodes={data.nodes}
              edges={data.edges}
              cycles={data.cycles}
              layout={layout}
              selectedId={selectedId}
              query={query}
              onSelect={setSelectedId}
            />
          </div>
          <NodePanel node={selected} edges={data.edges} cycles={data.cycles} />
        </div>
      ) : null}
    </div>
  );
}
