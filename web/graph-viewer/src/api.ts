import type { GraphPayload } from "./layout.ts";

export async function fetchGraph(): Promise<GraphPayload> {
  const res = await fetch("/api/graph");
  if (!res.ok) {
    throw new Error(`Failed to load graph (${res.status})`);
  }
  return (await res.json()) as GraphPayload;
}
