import type { GraphEdge, GraphNode, LayoutResult } from "../layout.ts";
import { nodeInCycle } from "../layout.ts";

type Props = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  cycles: string[][];
  layout: LayoutResult;
  selectedId: string | null;
  query: string;
  onSelect: (id: string) => void;
};

const NODE_W = 180;
const NODE_H = 36;

export function GraphCanvas({
  nodes,
  edges,
  cycles,
  layout,
  selectedId,
  query,
  onSelect,
}: Props) {
  const q = query.trim().toLowerCase();
  const match = (id: string) => !q || id.toLowerCase().includes(q);

  const visibleNodes = nodes.filter((n) => n.kind !== "external");
  const related = new Set<string>();
  if (selectedId) {
    related.add(selectedId);
    for (const e of edges) {
      if (e.from === selectedId) related.add(e.to);
      if (e.to === selectedId) related.add(e.from);
    }
  }

  return (
    <svg
      className="graph-svg"
      width={layout.width}
      height={layout.height}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
    >
      {edges.map((e) => {
        const a = layout.positions[e.from];
        const b = layout.positions[e.to];
        if (!a || !b) return null;
        if (nodes.find((n) => n.id === e.to)?.kind === "external") return null;

        const x1 = a.x + NODE_W;
        const y1 = a.y + NODE_H / 2;
        const x2 = b.x;
        const y2 = b.y + NODE_H / 2;
        const cx = (x1 + x2) / 2;
        const d = `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`;

        const hot =
          selectedId != null &&
          (e.from === selectedId || e.to === selectedId);
        const dim =
          (q && (!match(e.from) || !match(e.to))) ||
          (selectedId != null && !hot);

        return (
          <path
            key={`${e.from}->${e.to}`}
            className={`edge${hot ? " hot" : ""}${dim ? " dim" : ""}`}
            d={d}
          />
        );
      })}

      {visibleNodes.map((n) => {
        const p = layout.positions[n.id];
        if (!p) return null;
        const label = shortLabel(n.path);
        const selected = selectedId === n.id;
        const hot = selected || related.has(n.id);
        const dim = (q && !match(n.id)) || (selectedId != null && !hot && !match(n.id));
        const cycle = nodeInCycle(n.id, cycles);

        return (
          <g
            key={n.id}
            className={`node${selected ? " selected" : ""}${hot && !selected ? " hot" : ""}${dim ? " dim" : ""}${cycle ? " cycle" : ""}`}
            transform={`translate(${p.x}, ${p.y})`}
            onClick={() => onSelect(n.id)}
          >
            <rect width={NODE_W} height={NODE_H} rx={2} ry={2} />
            <title>{n.path}</title>
            <text x={12} y={22}>
              {label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function shortLabel(path: string): string {
  const parts = path.split("/");
  const file = parts[parts.length - 1] ?? path;
  return file.length > 22 ? `${file.slice(0, 20)}…` : file;
}
