import type { GraphEdge, GraphNode } from "../layout.ts";
import { nodeInCycle } from "../layout.ts";

type Props = {
  node: GraphNode | null;
  edges: GraphEdge[];
  cycles: string[][];
};

export function NodePanel({ node, edges, cycles }: Props) {
  if (!node) {
    return (
      <aside className="panel empty">
        <p>Select a module to inspect dependents and dependencies.</p>
      </aside>
    );
  }

  const dependencies = edges.filter((e) => e.from === node.id).map((e) => e.to);
  const dependents = edges.filter((e) => e.to === node.id).map((e) => e.from);
  const inCycle = nodeInCycle(node.id, cycles);

  return (
    <aside className="panel">
      <h2>{node.path}</h2>
      <span className="kind">{node.kind}</span>
      {inCycle ? <span className="kind badge-cycle">cycle</span> : null}

      <div className="meta">
        <span>In: {dependents.length}</span>
        <span>Out: {dependencies.length}</span>
      </div>

      <section>
        <h3>Dependents</h3>
        <ul>
          {dependents.length === 0 ? <li>—</li> : null}
          {dependents.slice(0, 40).map((id) => (
            <li key={id}>{id}</li>
          ))}
        </ul>
      </section>

      <section>
        <h3>Dependencies</h3>
        <ul>
          {dependencies.length === 0 ? <li>—</li> : null}
          {dependencies.slice(0, 40).map((id) => (
            <li key={id}>{id}</li>
          ))}
        </ul>
      </section>
    </aside>
  );
}
