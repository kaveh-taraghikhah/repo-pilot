export interface GraphNode {
  id: string;
  path: string;
  kind: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  type: string;
}

export interface GraphPayload {
  root: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  cycles: string[][];
}

export interface Point {
  x: number;
  y: number;
}

export interface LayoutResult {
  positions: Record<string, Point>;
  width: number;
  height: number;
}

/**
 * Layered left-to-right layout from entry nodes (no inbound internal edges).
 */
export function layoutGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  options: { nodeWidth?: number; nodeHeight?: number; gapX?: number; gapY?: number } = {},
): LayoutResult {
  const nodeWidth = options.nodeWidth ?? 180;
  const nodeHeight = options.nodeHeight ?? 36;
  const gapX = options.gapX ?? 80;
  const gapY = options.gapY ?? 28;

  const internal = nodes.filter((n) => n.kind !== "external");
  const ids = new Set(internal.map((n) => n.id));
  const inbound = new Map<string, Set<string>>();
  const outbound = new Map<string, Set<string>>();

  for (const id of ids) {
    inbound.set(id, new Set());
    outbound.set(id, new Set());
  }

  for (const e of edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) continue;
    outbound.get(e.from)?.add(e.to);
    inbound.get(e.to)?.add(e.from);
  }

  const layer = new Map<string, number>();
  const entries = [...ids].filter((id) => (inbound.get(id)?.size ?? 0) === 0);
  const seeds = entries.length > 0 ? entries : [...ids].slice(0, 1);

  const queue = [...seeds];
  for (const s of seeds) layer.set(s, 0);

  while (queue.length > 0) {
    const cur = queue.shift()!;
    const depth = layer.get(cur) ?? 0;
    for (const next of outbound.get(cur) ?? []) {
      const proposed = depth + 1;
      if (!layer.has(next) || (layer.get(next) ?? 0) < proposed) {
        // Prefer shorter path for layering: only set if unset
        if (!layer.has(next)) {
          layer.set(next, proposed);
          queue.push(next);
        }
      }
    }
  }

  for (const id of ids) {
    if (!layer.has(id)) layer.set(id, 0);
  }

  const byLayer = new Map<number, string[]>();
  for (const [id, d] of layer) {
    const list = byLayer.get(d) ?? [];
    list.push(id);
    byLayer.set(d, list);
  }

  for (const list of byLayer.values()) list.sort();

  const positions: Record<string, Point> = {};
  let maxX = 0;
  let maxY = 0;

  const layers = [...byLayer.keys()].sort((a, b) => a - b);
  for (const d of layers) {
    const list = byLayer.get(d) ?? [];
    list.forEach((id, index) => {
      const x = 40 + d * (nodeWidth + gapX);
      const y = 40 + index * (nodeHeight + gapY);
      positions[id] = { x, y };
      maxX = Math.max(maxX, x + nodeWidth + 40);
      maxY = Math.max(maxY, y + nodeHeight + 40);
    });
  }

  return {
    positions,
    width: Math.max(maxX, 640),
    height: Math.max(maxY, 400),
  };
}

export function nodeInCycle(id: string, cycles: string[][]): boolean {
  return cycles.some((c) => c.includes(id));
}
