export type NodeKind = "module" | "external" | "test" | "route";

export interface GraphNode {
  id: string;
  path: string;
  kind: NodeKind;
}

export type EdgeType = "import" | "reexport";

export interface GraphEdge {
  from: string;
  to: string;
  type: EdgeType;
}

export interface ProjectGraphJson {
  nodes: GraphNode[];
  edges: GraphEdge[];
  cycles: string[][];
}

export class ProjectGraph {
  private readonly nodes = new Map<string, GraphNode>();
  private readonly edges: GraphEdge[] = [];
  private readonly outbound = new Map<string, Set<string>>();
  private readonly inbound = new Map<string, Set<string>>();

  addNode(id: string, path: string, kind: NodeKind = "module"): GraphNode {
    const existing = this.nodes.get(id);
    if (existing) {
      // Upgrade kind when we learn more (e.g. module → route/test)
      if (kind !== "module" && existing.kind === "module") {
        existing.kind = kind;
      }
      return existing;
    }
    const node: GraphNode = { id, path, kind };
    this.nodes.set(id, node);
    this.outbound.set(id, new Set());
    this.inbound.set(id, new Set());
    return node;
  }

  addEdge(from: string, to: string, type: GraphEdge["type"] = "import"): void {
    if (from === to) return;
    const key = `${from}\0${to}\0${type}`;
    if (this.edges.some((e) => `${e.from}\0${e.to}\0${e.type}` === key)) {
      return;
    }
    this.edges.push({ from, to, type });
    this.outbound.get(from)?.add(to);
    this.inbound.get(to)?.add(from);
  }

  getNode(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  getNodes(): GraphNode[] {
    return [...this.nodes.values()];
  }

  getEdges(): GraphEdge[] {
    return [...this.edges];
  }

  dependenciesOf(id: string): string[] {
    return [...(this.outbound.get(id) ?? [])];
  }

  dependentsOf(id: string): string[] {
    return [...(this.inbound.get(id) ?? [])];
  }

  /** Internal modules with no inbound edges from other internal modules. */
  entryNodes(): GraphNode[] {
    return this.getNodes().filter((node) => {
      if (node.kind === "external") return false;
      const inbound = [...(this.inbound.get(node.id) ?? [])].filter((from) => {
        const n = this.nodes.get(from);
        return n && n.kind !== "external";
      });
      return inbound.length === 0;
    });
  }

  findCycles(): string[][] {
    const nodes = this.getNodes()
      .filter((n) => n.kind !== "external")
      .map((n) => n.id);

    const index = new Map<string, number>();
    const lowlink = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    let currentIndex = 0;
    const cycles: string[][] = [];

    const strongConnect = (v: string): void => {
      index.set(v, currentIndex);
      lowlink.set(v, currentIndex);
      currentIndex += 1;
      stack.push(v);
      onStack.add(v);

      for (const w of this.outbound.get(v) ?? []) {
        const target = this.nodes.get(w);
        if (!target || target.kind === "external") continue;
        if (!index.has(w)) {
          strongConnect(w);
          lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
        } else if (onStack.has(w)) {
          lowlink.set(v, Math.min(lowlink.get(v)!, index.get(w)!));
        }
      }

      if (lowlink.get(v) === index.get(v)) {
        const component: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          component.push(w);
        } while (w !== v);

        if (component.length > 1) {
          cycles.push(component.reverse());
        } else {
          // Self-cycle via edge v→v already skipped; check multi-edge loops of size 1 N/A
          const self = this.outbound.get(v)?.has(v);
          if (self) cycles.push([v]);
        }
      }
    };

    for (const node of nodes) {
      if (!index.has(node)) strongConnect(node);
    }

    return cycles;
  }

  toJSON(): ProjectGraphJson {
    return {
      nodes: this.getNodes(),
      edges: this.getEdges(),
      cycles: this.findCycles(),
    };
  }
}
